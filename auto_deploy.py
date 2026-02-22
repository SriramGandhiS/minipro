import tkinter as tk
from tkinter import messagebox
import subprocess
import urllib.request
import threading
import os

def run_git_commands():
    try:
        subprocess.run(["git", "add", "."], check=True, cwd=os.path.dirname(__file__) or ".")
        subprocess.run(["git", "commit", "-m", "Auto deploy update with headless opencv"], check=True, cwd=os.path.dirname(__file__) or ".")
        subprocess.run(["git", "push"], check=True, cwd=os.path.dirname(__file__) or ".")
        return True
    except subprocess.CalledProcessError as e:
        return False

def trigger_deploy(hook_url):
    try:
        req = urllib.request.Request(hook_url, method="POST")
        urllib.request.urlopen(req)
        return True
    except Exception as e:
        return False

def deploy_action():
    hook_url = hook_entry.get().strip()
    
    btn_deploy.config(text="Pushing code...", state=tk.DISABLED)
    status_label.config(text="Pushing changes to GitHub...")
    root.update()
    
    def task():
        push_success = run_git_commands()
        if not push_success:
            root.after(0, lambda: messagebox.showwarning("Warning", "Git push had an issue (maybe no changes or requires auth)."))
        
        if hook_url:
            root.after(0, lambda: status_label.config(text="Triggering Render..."))
            deploy_success = trigger_deploy(hook_url)
            if deploy_success:
                root.after(0, lambda: messagebox.showinfo("Success", "Code pushed and Render deploy triggered!"))
            else:
                root.after(0, lambda: messagebox.showerror("Error", "Failed to trigger Render hook. Is the URL correct?"))
        else:
            root.after(0, lambda: messagebox.showinfo("Success", "Code pushed! (No Render Deploy Hook provided, waiting for auto-deploy)"))
        
        root.after(0, lambda: btn_deploy.config(text="Deploy Application", state=tk.NORMAL))
        root.after(0, lambda: status_label.config(text="Ready."))

    threading.Thread(target=task).start()

root = tk.Tk()
root.title("Auto Deploy Tool")
root.geometry("400x200")
root.configure(padx=20, pady=20)

tk.Label(root, text="Render Deploy Hook URL (Optional):", font=("Arial", 10, "bold")).pack(anchor="w")
hook_entry = tk.Entry(root, width=50)
hook_entry.pack(pady=5)
hook_entry.insert(0, "https://api.render.com/deploy/srv-...") 

status_label = tk.Label(root, text="Ready.", fg="blue")
status_label.pack(pady=10)

btn_deploy = tk.Button(root, text="Push & Deploy", command=deploy_action, bg="#4CAF50", fg="white", font=("Arial", 12, "bold"))
btn_deploy.pack(fill="x", pady=10)

root.mainloop()
