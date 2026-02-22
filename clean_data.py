import sqlite3
import pickle
import os

DB_FILE = "backend/attendance.db"
ENCODING_FILE = "backend/data/encodings.pkl"
TARGET = "jacks"

print(f"Starting cleanup for target '{TARGET}'...")

# 1. Clean Database
try:
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    
    c.execute("DELETE FROM students WHERE lower(name) = lower(?)", (TARGET,))
    students_deleted = c.rowcount
    
    c.execute("DELETE FROM attendance WHERE lower(name) = lower(?)", (TARGET,))
    attendance_deleted = c.rowcount
    
    conn.commit()
    conn.close()
    print(f"Deleted {students_deleted} from students table.")
    print(f"Deleted {attendance_deleted} from attendance table.")
except Exception as e:
    print(f"Database clean error: {e}")

# 2. Clean Encodings
if os.path.exists(ENCODING_FILE):
    try:
        with open(ENCODING_FILE, "rb") as f:
            encodings = pickle.load(f)
        
        # Case insensitive removal
        keys_to_delete = [k for k in encodings.keys() if k.lower() == TARGET.lower()]
        for k in keys_to_delete:
            del encodings[k]
            
        with open(ENCODING_FILE, "wb") as f:
            pickle.dump(encodings, f)
            
        print(f"Deleted {len(keys_to_delete)} keys from encodings file: {keys_to_delete}")
    except Exception as e:
        print(f"Encodings clean error: {e}")
else:
    print("No encodings file found.")

print("Cleanup complete.")
