from flask import Flask, request, jsonify
from flask_cors import CORS
import cv2
import numpy as np
import face_recognition
import os
import pickle
from datetime import datetime
import sqlite3
import base64

app = Flask(__name__)
CORS(app)

DATA_PATH = "data"
ENCODING_FILE = "data/encodings.pkl"
DB_FILE = "attendance.db"

os.makedirs(DATA_PATH, exist_ok=True)

attendance_active = False

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
    conn.commit()
    conn.close()

init_db()

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

    if not name or not image_b64:
        return jsonify({"status": "error", "message": "Missing data"}), 400

    img = base64_to_image(image_b64)
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

    faces = face_recognition.face_locations(rgb)
    if len(faces) != 1:
        return jsonify({"status": "error", "message": "Show exactly one face"}), 400

    encoding = face_recognition.face_encodings(rgb, faces)[0]
    known_encodings[name] = encoding
    save_encodings()

    return jsonify({"status": "success", "message": f"{name} registered"})

@app.route("/attendance", methods=["POST"])
def attendance():
    global attendance_active
    if not attendance_active:
        return jsonify({"status": "error", "message": "Attendance not started"}), 403

    data = request.json
    image_b64 = data.get("image")

    img = base64_to_image(image_b64)
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

    faces = face_recognition.face_locations(rgb)
    encodings = face_recognition.face_encodings(rgb, faces)

    if len(encodings) == 0:
        return jsonify({"status": "error", "message": "No face detected"})

    results = []
    names_list = list(known_encodings.keys())
    enc_list = list(known_encodings.values())

    for enc in encodings:
        name = "Unknown"
        if len(enc_list) > 0:
            matches = face_recognition.compare_faces(enc_list, enc, tolerance=0.5)
            if True in matches:
                idx = matches.index(True)
                name = names_list[idx]

                now = datetime.now()
                date = now.strftime("%Y-%m-%d")
                time = now.strftime("%H:%M:%S")

                conn = sqlite3.connect(DB_FILE)
                c = conn.cursor()
                c.execute("SELECT * FROM attendance WHERE name=? AND date=?", (name, date))
                if not c.fetchone():
                    c.execute("INSERT INTO attendance (name, date, time) VALUES (?, ?, ?)",
                              (name, date, time))
                    conn.commit()
                conn.close()

        results.append(name)

    return jsonify({"status": "success", "recognized": results})

@app.route("/report", methods=["GET"])
def report():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT name, date, time FROM attendance ORDER BY id DESC")
    rows = c.fetchall()
    conn.close()
    return jsonify(rows)

if __name__ == "__main__":
    app.run(debug=True)
    if __name__ == "__main__":
        app.run(host="0.0.0.0", port=5000)
        @app.route("/")
        def home():
            return "Backend is running"