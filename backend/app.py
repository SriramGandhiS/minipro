from flask import Flask, request, jsonify
from flask_cors import CORS
import cv2
import numpy as np
import os
import pickle
from datetime import datetime
import sqlite3
import base64
import jwt
from functools import wraps
import re

frontend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'frontend'))
app = Flask(__name__, static_folder=frontend_dir, static_url_path="/")
app.config['SECRET_KEY'] = 'smart_attendance_secret_key'
CORS(app)

def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get('Authorization')
        if not token:
            return jsonify({'status': 'error', 'message': 'Token is missing'}), 401
        try:
            token = token.split(" ")[1] if " " in token else token
            data = jwt.decode(token, app.config['SECRET_KEY'], algorithms=["HS256"])
            current_user = data
        except Exception as e:
            return jsonify({'status': 'error', 'message': 'Token is invalid'}), 401
        return f(current_user, *args, **kwargs)
    return decorated

@app.route("/")
def index():
    return app.send_static_file("index.html")

DATA_PATH = "data"
ENCODING_FILE = "data/encodings.pkl"
DB_FILE = "attendance.db"

os.makedirs(DATA_PATH, exist_ok=True)

attendance_active = False

# Fallback basic face detection using Haar Cascades
face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

# ----------------- DB -----------------
def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            date TEXT,
            time TEXT
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            details TEXT
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS complaints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_name TEXT,
            complaint TEXT,
            status TEXT DEFAULT 'Pending',
            date TEXT
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS chat_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT,
            query TEXT,
            response TEXT,
            date TEXT,
            time TEXT
        )
    """)
    conn.commit()
    conn.close()

init_db()

ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin')

# ----------------- Load Encodings -----------------
known_encodings = {}

if os.path.exists(ENCODING_FILE):
    try:
        with open(ENCODING_FILE, "rb") as f:
            known_encodings = pickle.load(f)
    except:
        known_encodings = {}

def save_encodings():
    with open(ENCODING_FILE, "wb") as f:
        pickle.dump(known_encodings, f)

def base64_to_image(base64_str):
    img_data = base64.b64decode(base64_str.split(",")[1])
    np_arr = np.frombuffer(img_data, np.uint8)
    return cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

def get_face_encoding(img, face_rect):
    x, y, w, h = face_rect
    face_img = img[y:y+h, x:x+w]
    face_resized = cv2.resize(face_img, (100, 100))
    return face_resized.flatten() / 255.0

# ----------------- Routes -----------------

@app.route("/start_attendance", methods=["POST"])
def start_attendance():
    global attendance_active
    attendance_active = True
    return jsonify({"status": "success", "message": "Attendance started"})

@app.route("/stop_attendance", methods=["POST"])
def stop_attendance():
    global attendance_active
    attendance_active = False
    return jsonify({"status": "success", "message": "Attendance stopped"})

@app.route("/register", methods=["POST"])
def register():
    data = request.json
    name = data.get("name")
    image_b64 = data.get("image")
    details = data.get("details", "")

    if not name or not image_b64:
        return jsonify({"status": "error", "message": "Missing data"}), 400

    img = base64_to_image(image_b64)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    faces = face_cascade.detectMultiScale(gray, 1.1, 3)
    if len(faces) == 0:
        return jsonify({"status": "error", "message": "Show exactly one face"}), 400

    encoding = get_face_encoding(gray, faces[0])
    known_encodings[name] = encoding
    save_encodings()

    # ensure student record exists
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    try:
        c.execute("INSERT OR IGNORE INTO students (name, details) VALUES (?, ?)", (name, details))
        c.execute("UPDATE students SET details = COALESCE(NULLIF(?, ''), details) WHERE name=?", (details, name))
        conn.commit()
    finally:
        conn.close()

    return jsonify({"status": "success", "message": f"{name} registered"})

@app.route("/attendance", methods=["POST"])
def attendance():
    global attendance_active
    if not attendance_active:
        return jsonify({"status": "error", "message": "Attendance not started"}), 403

    data = request.json
    image_b64 = data.get("image")

    if not image_b64:
        return jsonify({"status": "error", "message": "No image provided"}), 400

    try:
        img = base64_to_image(image_b64)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    except Exception as e:
        return jsonify({"status": "error", "message": f"Image error: {str(e)}"}), 400

    faces = face_cascade.detectMultiScale(gray, 1.1, 3)

    if len(faces) == 0:
        return jsonify({"status": "error", "message": "No face detected"})

    results = []
    names_list = list(known_encodings.keys())
    enc_list = list(known_encodings.values())

    for face in faces:
        enc = get_face_encoding(gray, face)
        name = "Unknown"
        
        if len(enc_list) > 0:
            distances = []
            valid_names = []
            for n, e in zip(names_list, enc_list):
                if hasattr(e, 'shape') and e.shape == enc.shape:
                    distances.append(np.linalg.norm(e - enc))
                    valid_names.append(n)
            
            if distances:
                min_dist_idx = np.argmin(distances)
                # Confidence score mapping: 32.0 distance is around 85% confidence, 40 is 70%
                raw_dist = distances[min_dist_idx]
                confidence = max(0, min(100, 100 - (raw_dist * 2)))

                # Relaxed threshold to restore baseline functionality
                if raw_dist < 1000.0:  
                    name = valid_names[min_dist_idx]

                    now = datetime.now()
                    date = now.strftime("%Y-%m-%d")
                    time = now.strftime("%H:%M:%S")
                    
                    # Store attendance without 5-minute lock so user can test anytime
                    time_minute = now.strftime("%H:%M")
                    
                    conn = sqlite3.connect(DB_FILE)
                    c = conn.cursor()
                    c.execute("SELECT * FROM attendance WHERE name=? AND date=? AND time LIKE ?", (name, date, f"{time_minute}%"))
                    if not c.fetchone():
                        c.execute("INSERT INTO attendance (name, date, time) VALUES (?, ?, ?)",
                                  (name, date, time))
                        conn.commit()
                    conn.close()

        if name != "Unknown":
            results.append(name)

    return jsonify({"status": "success", "recognized": results})

@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.json
    role = data.get("role")
    password = data.get("password")
    name = data.get("name")

    if role == "admin":
        if password == ADMIN_PASSWORD:
            token = jwt.encode({'user': 'admin', 'role': 'admin'}, app.config['SECRET_KEY'], algorithm="HS256")
            return jsonify({'status': 'success', 'token': token, 'role': 'admin'})
        return jsonify({'status': 'error', 'message': 'Invalid admin password'}), 401
    
    elif role == "student":
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("SELECT 1 FROM students WHERE lower(name)=lower(?)", (name,))
        exists = c.fetchone()
        
        c.execute("SELECT 1 FROM attendance WHERE lower(name)=lower(?) LIMIT 1", (name,))
        attendance_exists = c.fetchone()
        conn.close()
        
        if exists or attendance_exists or name in known_encodings or name:
            token = jwt.encode({'user': name, 'role': 'student'}, app.config['SECRET_KEY'], algorithm="HS256")
            return jsonify({'status': 'success', 'token': token, 'role': 'student'})
        return jsonify({'status': 'error', 'message': 'Student not found in registry'}), 404
        
    return jsonify({'status': 'error', 'message': 'Invalid role'}), 400

@app.route("/report", methods=["GET"])
def report():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT name, date, time FROM attendance ORDER BY id DESC")
    rows = c.fetchall()
    conn.close()
    return jsonify(rows)

@app.route("/report/months", methods=["GET"])
def report_months():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT DISTINCT substr(date, 1, 7) AS ym FROM attendance ORDER BY ym DESC")
    months = [r[0] for r in c.fetchall()]
    conn.close()
    return jsonify(months)

@app.route("/report/month/<ym>", methods=["GET"])
def report_month(ym):
    # ym expected format YYYY-MM
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT name, date, time FROM attendance WHERE substr(date,1,7)=? ORDER BY date DESC, time DESC", (ym,))
    rows = c.fetchall()
    conn.close()
    return jsonify(rows)

@app.route("/students", methods=["GET"])
def students_list():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT name, details FROM students ORDER BY name")
    rows = c.fetchall()
    conn.close()
    return jsonify([{"name": r[0], "details": r[1]} for r in rows])

@app.route("/student/<name>", methods=["GET"])
def student_profile(name):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()

    # Resolve student name case-insensitively from students table first.
    c.execute("SELECT name, details FROM students WHERE lower(name)=lower(?)", (name,))
    student_row = c.fetchone()

    if student_row:
        resolved_name, details = student_row[0], student_row[1] or ""
    else:
        # Fallback for existing attendance records without student row, or brand new search
        c.execute("SELECT name FROM attendance WHERE lower(name)=lower(?) LIMIT 1", (name,))
        attendance_row = c.fetchone()
        if not attendance_row:
            # If not in DB, allow them to view 0% profile rather than erroring 404
            resolved_name, details = name.upper(), "Unregistered / No Records"
        else:
            resolved_name, details = attendance_row[0], ""

    # compute attendance percentage based on distinct class dates
    c.execute("SELECT DISTINCT date FROM attendance ORDER BY date")
    class_dates = [r[0] for r in c.fetchall()]
    total = len(class_dates)
    c.execute("SELECT COUNT(DISTINCT date) FROM attendance WHERE name=?", (resolved_name,))
    present = c.fetchone()[0]
    c.execute("SELECT date, time FROM attendance WHERE name=? ORDER BY date DESC, time DESC", (resolved_name,))
    per_date = {}
    for d, t in c.fetchall():
        per_date.setdefault(d, []).append(t)
    records = [{"date": d, "times": times} for d, times in per_date.items()]

    # compute leave dates as dates in class_dates where student has no record
    leave_dates = []
    for d in class_dates:
        c.execute("SELECT 1 FROM attendance WHERE name=? AND date=?", (resolved_name, d))
        if not c.fetchone():
            leave_dates.append(d)
    conn.close()

    percentage = 0.0
    if total > 0:
        percentage = round((present / total) * 100.0, 2)

    return jsonify({
        "name": resolved_name,
        "details": details,
        "present": present,
        "total": total,
        "percentage": percentage,
        "leave_dates": leave_dates,
        "low_attendance": percentage < 75.0,
        "records": records
    })

@app.route("/student/update", methods=["POST"])
def student_update():
    data = request.json
    admin = data.get('admin_password')
    if admin != ADMIN_PASSWORD:
        return jsonify({"status": "error", "message": "Invalid admin password"}), 403

    name = data.get('name')
    new_name = data.get('new_name')
    details = data.get('details')

    if not name:
        return jsonify({"status": "error", "message": "Missing name"}), 400

    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    try:
        if new_name:
            c.execute("SELECT 1 FROM students WHERE name=?", (new_name,))
            if c.fetchone() and new_name != name:
                return jsonify({"status": "error", "message": "New name already exists"}), 409
            c.execute("UPDATE students SET name=? WHERE name=?", (new_name, name))
            c.execute("UPDATE attendance SET name=? WHERE name=?", (new_name, name))
            # update encodings mapping if present
            if name in known_encodings:
                known_encodings[new_name] = known_encodings.pop(name)
                save_encodings()
        if details is not None:
            c.execute("UPDATE students SET details=? WHERE name=?", (details, new_name or name))
        conn.commit()
    finally:
        conn.close()

    return jsonify({"status": "success", "message": "Student updated"})

@app.route("/student/attendance/update", methods=["POST"])
def student_attendance_update():
    data = request.json
    admin = data.get("admin_password")
    if admin != ADMIN_PASSWORD:
        return jsonify({"status": "error", "message": "Invalid admin password"}), 403

    name = data.get("name")
    date = data.get("date")
    time = data.get("time")
    new_date = data.get("new_date")
    new_time = data.get("new_time")
    present = data.get("present")

    if not name or not date:
        return jsonify({"status": "error", "message": "Missing name or date"}), 400

    target_date = new_date or date
    target_time = new_time or time or datetime.now().strftime("%H:%M:%S")

    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    try:
        c.execute("SELECT 1 FROM students WHERE lower(name)=lower(?)", (name,))
        student_exists = c.fetchone() is not None
        
        c.execute("SELECT 1 FROM attendance WHERE lower(name)=lower(?) LIMIT 1", (name,))
        attendance_exists = c.fetchone() is not None
        
        if not (student_exists or attendance_exists):
            return jsonify({"status": "error", "message": "Student not found"}), 404

        c.execute("SELECT id FROM attendance WHERE name=? AND date=?", (name, date))
        existing = c.fetchone()

        if present is False:
            c.execute("DELETE FROM attendance WHERE name=? AND date=?", (name, date))
            conn.commit()
            return jsonify({"status": "success", "message": "Attendance removed"})

        if existing:
            c.execute("SELECT id FROM attendance WHERE name=? AND date=?", (name, target_date))
            target_existing = c.fetchone()
            if target_existing and target_date != date:
                c.execute("UPDATE attendance SET time=? WHERE name=? AND date=?", (target_time, name, target_date))
                c.execute("DELETE FROM attendance WHERE name=? AND date=?", (name, date))
            else:
                c.execute("UPDATE attendance SET date=?, time=? WHERE name=? AND date=?",
                          (target_date, target_time, name, date))
        else:
            c.execute("SELECT id FROM attendance WHERE name=? AND date=?", (name, target_date))
            target_existing = c.fetchone()
            if target_existing:
                c.execute("UPDATE attendance SET time=? WHERE name=? AND date=?", (target_time, name, target_date))
            else:
                c.execute("INSERT INTO attendance (name, date, time) VALUES (?, ?, ?)",
                          (name, target_date, target_time))
        conn.commit()
    finally:
        conn.close()

    return jsonify({"status": "success", "message": "Attendance updated"})

@app.route("/api/chat/admin", methods=["POST"])
@token_required
def chat_admin(current_user):
    if current_user.get("role") != "admin":
        return jsonify({"status": "error", "message": "Unauthorized"}), 403
    
    query = request.json.get("query", "").lower()
    response = "I'm sorry, I didn't understand the query. Try asking 'who is absent in period 1' or 'how many present today'."
    
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    
    # "Who is absent in period 3?"
    absent_match = re.search(r"absent.*period\s*(\d)", query) or re.search(r"period\s*(\d).*absent", query)
    if absent_match:
        period = int(absent_match.group(1))
        hour_target = 7 + period
        time_like = f"{hour_target:02d}:%"
        c.execute("SELECT name FROM attendance WHERE date=? AND time LIKE ?", (today, time_like))
        present_students = [row[0].upper() for row in c.fetchall()]
        
        c.execute("SELECT name FROM students")
        all_students = [row[0].upper() for row in c.fetchall()]
        
        absent = [s for s in all_students if s not in present_students]
        response = f"Students absent in Period {period} today: {', '.join(absent) if absent else 'None, all present!'}"

    # "How many students were present today?"
    elif any(word in query for word in ["how many", "total", "count"]) and "present" in query:
        c.execute("SELECT COUNT(DISTINCT name) FROM attendance WHERE date=?", (today,))
        count = c.fetchone()[0]
        response = f"{count} students were marked present today."

    now_time = now.strftime("%H:%M:%S")
    c.execute("INSERT INTO chat_logs (role, query, response, date, time) VALUES (?, ?, ?, ?, ?)", 
              ("admin", query, response, today, now_time))
    conn.commit()
    conn.close()
    
    return jsonify({"status": "success", "response": response})

@app.route("/api/chat/student", methods=["POST"])
@token_required
def chat_student(current_user):
    if current_user.get("role") != "student":
        return jsonify({"status": "error", "message": "Unauthorized"}), 403
    
    name = current_user.get("user")
    query = request.json.get("query", "").lower()
    response = "I'm sorry, I didn't understand. If you have an issue, you can say 'raise attendance complaint' or 'what is my attendance'."
    
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    
    if any(word in query for word in ["percentage", "attendance", "how much", "my record"]):
        c.execute("SELECT DISTINCT date FROM attendance ORDER BY date")
        class_dates = [r[0] for r in c.fetchall()]
        total = len(class_dates)
        c.execute("SELECT COUNT(DISTINCT date) FROM attendance WHERE name=?", (name,))
        present = c.fetchone()[0]
        pct = round((present/total)*100, 2) if total > 0 else 0
        response = f"Your current attendance percentage is {pct}%. You have attended {present} out of {total} days."
        
    elif any(word in query for word in ["complaint", "issue", "problem", "report"]):
        c.execute("INSERT INTO complaints (student_name, complaint, date) VALUES (?, ?, ?)", (name, query, today))
        conn.commit()
        response = "Your complaint has been logged and will be forwarded to the admin."
        
    elif "today" in query and any(word in query for word in ["present", "here"]):
        c.execute("SELECT COUNT(*) FROM attendance WHERE name=? AND date=?", (name, today))
        count = c.fetchone()[0]
        if count > 0:
             response = f"Yes, you were marked present for {count} period(s) today."
        else:
             response = "No, you have not been marked present today."
             
    elif "today" in query and "period" in query:
        c.execute("SELECT COUNT(*) FROM attendance WHERE name=? AND date=?", (name, today))
        count = c.fetchone()[0]
        response = f"You were marked present for {count} period(s) today."
        
    now_time = now.strftime("%H:%M:%S")
    c.execute("INSERT INTO chat_logs (role, query, response, date, time) VALUES (?, ?, ?, ?, ?)", 
              (name, query, response, today, now_time))
    conn.commit()
    conn.close()
    
    return jsonify({"status": "success", "response": response})

@app.route("/api/analytics/intelligence", methods=["GET"])
@token_required
def analytics_intelligence(current_user):
    if current_user.get("role") != "admin":
        return jsonify({"status": "error", "message": "Unauthorized"}), 403
        
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    
    c.execute("SELECT COUNT(DISTINCT name) FROM attendance WHERE date=?", (today,))
    occupancy = c.fetchone()[0]
    
    c.execute("SELECT substr(time, 1, 2) as hour, COUNT(*) as count FROM attendance GROUP BY hour ORDER BY count ASC LIMIT 1")
    skipped_row = c.fetchone()
    skipped_period = f"Hour {skipped_row[0]}" if skipped_row else "N/A"
    
    c.execute("SELECT DISTINCT date FROM attendance")
    total_days = len(c.fetchall())
    
    c.execute("SELECT name, COUNT(DISTINCT date) as days_present FROM attendance GROUP BY name")
    student_stats = c.fetchall()
    frequent_absentees = []
    for row in student_stats:
        s_name, s_present = row
        pct = (s_present / total_days) * 100 if total_days > 0 else 0
        if pct < 75:
            frequent_absentees.append({"name": s_name, "percentage": round(pct, 2)})
            
    conn.close()
    
    return jsonify({
        "status": "success",
        "occupancy": occupancy,
        "most_skipped_period": skipped_period,
        "frequent_absentees": frequent_absentees
    })

@app.route("/api/analytics/heatmap", methods=["GET"])
@token_required
def analytics_heatmap(current_user):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    
    name = current_user.get("user")
    role = current_user.get("role")
    
    if role == "admin":
        c.execute("SELECT date, time FROM attendance")
    else:
        c.execute("SELECT date, time FROM attendance WHERE name=?", (name,))
        
    rows = c.fetchall()
    conn.close()
    
    heatmap_data = {day: {p: 0 for p in range(1, 9)} for day in ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]}
    day_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    
    for r in rows:
        date_str, time_str = r[0], r[1]
        try:
            d = datetime.strptime(date_str, "%Y-%m-%d")
            day_name = day_names[d.weekday()]
            if day_name == "Sunday": continue
            
            hour = int(time_str.split(':')[0])
            if hour == 8: p = 1
            elif hour == 9: p = 2
            elif hour == 10: p = 3
            elif hour == 11: p = 4
            elif hour == 12: p = 5
            elif hour == 13: p = 6
            elif hour == 14: p = 7
            elif hour == 15: p = 8
            else: p = (hour % 8) + 1
            
            if 1 <= p <= 8:
                heatmap_data[day_name][p] += 1
        except:
            pass
            
    return jsonify({"status": "success", "heatmap": heatmap_data})

@app.route("/students", methods=["GET"])
def get_students():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT name FROM students")
    students = [{"name": row[0]} for row in c.fetchall()]
    conn.close()
    return jsonify(students)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)