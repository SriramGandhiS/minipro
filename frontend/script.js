// Detect API base URL dynamically
let API_BASE = window.location.pathname.includes('static')
  ? window.location.origin
  : (window.location.protocol + "//" + window.location.host);

// For Render: automatically use the current domain
if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
  API_BASE = window.location.protocol + "//" + window.location.host;
}

// Global JWT Token state - restored from session on load
let jwtToken = sessionStorage.getItem("jwtToken") || null;

// These are initialized in initPage once the DOM is ready
let video = null;
let canvas = null;
let output = null;
let scanState = null;

let attendanceInterval = null;
let dashboardInterval = null;
let mouseX = 0;
let mouseY = 0;
let currentProfileData = null;
let currentProfileName = "";
let adminSessionPassword = "";

function showMessage(msg, isError = false) {
  const text = typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
  if (output) {
    output.textContent = text;
    output.style.color = isError ? "#ff6b6b" : "#d8f9ff";
  }
  if (isError) console.error(text);
}

function setScanState(active) {
  if (!scanState) return;
  scanState.textContent = active ? "Scanning" : "Stopped";
  scanState.classList.toggle("live", active);
}

async function startCamera() {
  if (!video || !navigator.mediaDevices?.getUserMedia) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    await video.play();
  } catch (_) {
    showMessage("Camera access denied. Allow camera and reload.", true);
  }
}

function captureImage() {
  if (!video || !canvas) throw new Error("Camera not available");
  if (!video.srcObject) throw new Error("Camera not started");
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg");
}

async function captureAndMarkAttendance() {
  const image = captureImage();
  const resp = await fetch(`${API_BASE}/attendance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image })
  });
  const recognizedData = await resp.json();
  if (!resp.ok) throw new Error(recognizedData.message || "Attendance mark failed");

  if (recognizedData.recognized?.length) {
    const names = recognizedData.recognized
      .map(r => typeof r === 'object' ? r.name : r)
      .filter(n => n !== "Unknown");

    if (names.length > 0) {
      const uniqueNames = [...new Set(names)];
      showMessage(`Marked: ${uniqueNames.join(", ")} at ${new Date().toLocaleString()}`);
    }
  }
}

async function startAttendance() {
  try {
    const res = await fetch(`${API_BASE}/start_attendance`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Failed to start");

    setScanState(true);
    showMessage(data.message || "Attendance started");

    await captureAndMarkAttendance();
    if (!attendanceInterval) {
      attendanceInterval = setInterval(async () => {
        try {
          await captureAndMarkAttendance();
        } catch (_) {
          // Continue scanning loop.
        }
      }, 3000);
    }
  } catch (err) {
    showMessage(err.message || err, true);
  }
}

async function stopAttendance() {
  try {
    const res = await fetch(`${API_BASE}/stop_attendance`, { method: "POST" });
    const data = await res.json();
    showMessage(data.message || "Attendance stopped");
    setScanState(false);
    if (attendanceInterval) {
      clearInterval(attendanceInterval);
      attendanceInterval = null;
    }
  } catch (err) {
    showMessage(err.message || err, true);
  }
}

async function registerStudent() {
  try {
    const nameInput = document.getElementById("name");
    const detailsInput = document.getElementById("details");
    const name = nameInput?.value.trim();
    const details = detailsInput?.value.trim();

    if (!name) {
      showMessage("Please enter student name", true);
      return;
    }

    const image = captureImage();
    const registerRes = await fetch(`${API_BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, image, details })
    });
    const registerData = await registerRes.json();
    if (!registerRes.ok) {
      showMessage(registerData.message || "Registration failed", true);
      return;
    }
    showMessage(registerData.message || "Student registered");
  } catch (err) {
    showMessage(err.message || err, true);
  }
}

function profileHTML(data) {
  const leaveText = data.leave_dates?.length ? data.leave_dates.join(", ") : "No leave records";
  const pctClass = data.low_attendance ? "low-attendance" : "";
  const editButton = document.body.dataset.page === "profile"
    ? `<div class="card-actions left"><button class="btn" onclick="openAdminEdit()">Edit</button></div>`
    : "";
  const records = (data.records || [])
    .map(r => `<li><strong>${r.date}</strong> — ${r.times.length} time(s): ${r.times.join(", ")}</li>`)
    .join("") || "<li>No attendance records</li>";

  return `
    <h3>${data.name}</h3>
    <p><strong>Details:</strong> ${data.details || "Not provided"}</p>
    <p class="${pctClass}"><strong>Attendance:</strong> ${data.percentage}% (${data.present}/${data.total})</p>
    <p><strong>Leave Dates:</strong> ${leaveText}</p>
    <p><strong>Daily Records:</strong></p>
    <ul>${records}</ul>
    ${editButton}
  `;
}

async function fetchStudentProfile(name) {
  const res = await fetch(`${API_BASE}/student/${encodeURIComponent(name)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Student not found");
  return data;
}

async function renderProfileByName(name, targetId) {
  const target = document.getElementById(targetId);
  if (!name?.trim()) {
    showMessage("Enter student name", true);
    return;
  }
  try {
    const data = await fetchStudentProfile(name.trim());
    currentProfileData = data;
    currentProfileName = data.name;

    // Auto-login to Student chatbot so they can chat instantly
    const loginRes = await fetch(`${API_BASE}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "student", name: data.name })
    });
    const loginData = await loginRes.json();
    if (loginData.status === "success") {
      jwtToken = loginData.token;
      sessionStorage.setItem("jwtToken", jwtToken);
      showMessage("Welcome " + name + "! Student Identity Verified.");
      setTimeout(() => {
        const chatBtn = document.getElementById("chat-toggle-btn");
        if (chatBtn) chatBtn.classList.remove("hidden");
      }, 500);
      sessionStorage.setItem("role", "student");

      const chatWidget = document.getElementById("student-chat-widget");
      if (chatWidget) chatWidget.classList.remove("hidden");
    }

    if (!target) return;
    target.innerHTML = profileHTML(data);
    target.classList.remove("hidden");
    showMessage("Profile loaded");
  } catch (err) {
    if (target) {
      target.classList.add("hidden");
      target.innerHTML = "";
    }
    showMessage(err.message || err, true);
  }
}

async function searchFromDashboard() {
  const name = document.getElementById("search-name")?.value || "";
  await renderProfileByName(name, "student-profile");
}

async function searchProfilePage() {
  const name = document.getElementById("profile-search-name")?.value || "";
  await renderProfileByName(name, "profile-result");
  const editCard = document.getElementById("admin-edit");
  if (editCard) editCard.classList.add("hidden");
}

function renderDailyAttendanceEditor(records) {
  const box = document.getElementById("daily-attendance-editor");
  if (!box) return;
  box.classList.remove("hidden");

  const rows = (records || []).map(r => `
    <tr>
      <td>${r.date}</td>
      <td><input type="date" value="${r.date}" data-old-date="${r.date}" class="daily-date"></td>
      <td><input type="time" step="1" value="${r.times?.[0] || ''}" data-old-date="${r.date}" class="daily-time"></td>
      <td>
        <button class="btn daily-save" data-old-date="${r.date}">Save</button>
        <button class="btn daily-remove" data-old-date="${r.date}">Mark Leave</button>
      </td>
    </tr>
  `).join("");

  box.innerHTML = `
    <table>
      <thead>
        <tr><th>Original Date</th><th>New Date</th><th>Time</th><th>Action</th></tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="4">No attendance records yet</td></tr>`}
      </tbody>
    </table>
    <div class="card-actions left" style="margin-top:12px;">
      <button class="btn" id="add-today-record">Add Today Attendance</button>
    </div>
  `;

  box.querySelectorAll(".daily-save").forEach(btn => {
    btn.addEventListener("click", async () => {
      const oldDate = btn.dataset.oldDate;
      const newDate = box.querySelector(`.daily-date[data-old-date="${oldDate}"]`)?.value;
      const newTime = box.querySelector(`.daily-time[data-old-date="${oldDate}"]`)?.value;
      await saveDailyAttendance(oldDate, newDate, newTime, true);
    });
  });

  box.querySelectorAll(".daily-remove").forEach(btn => {
    btn.addEventListener("click", async () => {
      const oldDate = btn.dataset.oldDate;
      const oldTime = box.querySelector(`.daily-time[data-old-date="${oldDate}"]`)?.value || "09:00:00";
      await saveDailyAttendance(oldDate, oldDate, oldTime, false);
    });
  });

  const addToday = box.querySelector("#add-today-record");
  if (addToday) {
    addToday.addEventListener("click", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const now = new Date().toTimeString().slice(0, 8);
      await saveDailyAttendance(today, today, now, true);
    });
  }
}

function openAdminEdit() {
  if (!currentProfileData || !currentProfileName) {
    showMessage("Search student first", true);
    return;
  }

  if (!adminSessionPassword) {
    const entered = prompt('Enter admin password');
    if (!entered) return;
    adminSessionPassword = entered;
  }

  const editCard = document.getElementById("admin-edit");
  const currentName = document.getElementById("edit-current-name");
  const detailsInput = document.getElementById("edit-details");

  currentName.value = currentProfileName;
  detailsInput.value = currentProfileData.details || "";
  editCard.classList.remove("hidden");
  renderDailyAttendanceEditor(currentProfileData.records || []);
  showMessage("Edit mode enabled");
}

async function saveStudentUpdate() {
  const name = document.getElementById("edit-current-name")?.value?.trim();
  const newName = document.getElementById("edit-new-name")?.value?.trim();
  const details = document.getElementById("edit-details")?.value?.trim();

  if (!name) {
    showMessage("Current name is required", true);
    return;
  }

  if (!adminSessionPassword) {
    adminSessionPassword = prompt('Enter admin password') || "";
    if (!adminSessionPassword) return;
  }

  try {
    const res = await fetch(`${API_BASE}/student/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        admin_password: adminSessionPassword,
        name,
        new_name: newName || null,
        details
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Update failed");

    const searchName = newName || name;
    const profileSearch = document.getElementById("profile-search-name");
    const currentNameField = document.getElementById("edit-current-name");
    if (profileSearch) profileSearch.value = searchName;
    if (currentNameField) currentNameField.value = searchName;

    showMessage(data.message || "Student updated");
    await renderProfileByName(searchName, "profile-result");
    await loadReport(getSelectedMonth());
  } catch (err) {
    showMessage(err.message || err, true);
  }
}

async function saveDailyAttendance(oldDate, newDate, newTime, present) {
  const name = document.getElementById("edit-current-name")?.value?.trim();
  if (!name) {
    showMessage("Current name missing", true);
    return;
  }
  if (!adminSessionPassword) {
    adminSessionPassword = prompt('Enter admin password') || "";
    if (!adminSessionPassword) return;
  }
  if (!oldDate) {
    showMessage("Date is required", true);
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/student/attendance/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        admin_password: adminSessionPassword,
        name,
        date: oldDate,
        time: newTime || "09:00:00",
        new_date: newDate || oldDate,
        new_time: newTime || "09:00:00",
        present
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Daily attendance update failed");

    showMessage(data.message || "Daily attendance updated");

    // Auto-refresh the live view!
    await renderProfileByName(name, "profile-result");
    openAdminEdit();
  } catch (err) {
    showMessage(err.message || err, true);
  }
}

const CLASS_LIST = [
  "SANJAY G", "SANJAY KUMAR K S", "SANJAY KUMAR M", "SANJAY RAJ M", "SANTHOSH KUMAR S",
  "SARAN KUMAR R", "SELVIN JEFRE B", "SHACHIN V P", "SHAMBUGAMOORTHI K", "SHARAN DEV M",
  "SIVA RANJAN R", "SIVASARAN K", "SIVAHARISH P L", "SOLAIRAJAN S", "SRI DHARSAN S",
  "SRI VARSHAN S S", "SRINIVAS J", "SRIRAM S", "SUDHARSAN E", "SURIYA KUMAR R",
  "TANUSH R", "THILAK BABU T A", "VENGATA VISVA P S", "VIDHYA DHARANESH P", "VIGNESH KUMAR S P",
  "VIGNESHWARAN M", "VIJAY BALAJI P S", "VIJAY KASTHURI K", "VIKRAM K", "VINUVARSHAN K",
  "VISHAL C", "VISHNUSANKAR K", "YUVANRAJ A", "SAKTHI J", "SANDHIYA S", "SANKARI M",
  "SANTHIYA L", "SANTHIYA S", "SARANYA S", "SARMATHI M", "SASMIKA S M", "SATHYA ESWARI K",
  "SERAFINA J B", "SHAMIKSAA R J", "SHARMITHASRI T", "SHEREEN TREESHA A", "SHWETHA S M",
  "SIVARANJANI S", "SIVASANKARI S", "SRI SIVADHARSHINI S", "SRILEKA S", "SRINIDHI U",
  "SRINITHI B", "SUJITHA M", "SURYA P", "THEJNI S", "VALARMATHI M", "VASIKA K",
  "VEERALAKSHMI N", "VISHWAATHIGA N M", "VIYANSA MERCY S", "YASWANTHINI M M"
];

function getPeriodIndex(timeStr) {
  const hour = parseInt(timeStr.split(':')[0], 10);
  if (hour === 8) return 1;
  if (hour === 9) return 2;
  if (hour === 10) return 3;
  if (hour === 11) return 4;
  if (hour === 12) return 5;
  if (hour === 13) return 6;
  if (hour === 14) return 7;
  if (hour === 15) return 8;
  return (hour % 8) + 1; // fallback
}

function formatTimeAMPM(timeStr) {
  if (!timeStr) return "-";
  let [h, m] = timeStr.split(':');
  let hour = parseInt(h, 10);
  let ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${m} ${ampm}`;
}

async function loadReport(month) {
  const tbody = document.querySelector("#table tbody");
  if (!tbody) return;
  try {
    const url = month ? `${API_BASE}/report/month/${month}` : `${API_BASE}/report`;
    const res = await fetch(url);
    const rows = await res.json();

    let dynamicClassList = [...CLASS_LIST];
    try {
      const studentRes = await fetch(`${API_BASE}/students`);
      if (studentRes.ok) {
        const studentData = await studentRes.json();
        studentData.forEach(s => {
          const upperName = s.name.toUpperCase();
          // Smarter duplicate check to ignore missing initials
          const existingMatch = dynamicClassList.find(n => n === upperName || n.startsWith(upperName + " ") || upperName.startsWith(n + " "));
          if (!existingMatch) {
            dynamicClassList.push(upperName);
          }
        });
      }
    } catch (e) { console.error("Could not fetch students", e); }

    tbody.innerHTML = "";

    // Group logs by Date
    // Each date contains an attendance map of 62 students -> 8 periods
    const datesMap = {};

    // Always show today's empty roster if viewing recent reports (no month filter)
    if (!month) {
      const todayStr = new Date().toLocaleDateString('en-CA'); // Local YYYY-MM-DD
      datesMap[todayStr] = {};
      dynamicClassList.forEach(n => datesMap[todayStr][n.toUpperCase()] = { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: null });
    }

    rows.forEach(row => {
      const name = row[0];
      const dateStr = row[1];
      const timeStr = row[2];

      if (!datesMap[dateStr]) {
        datesMap[dateStr] = {};
        dynamicClassList.forEach(n => datesMap[dateStr][n.toUpperCase()] = { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: null });
      }

      const period = getPeriodIndex(timeStr);
      let studentNameUpper = Object.keys(datesMap[dateStr]).find(n => n === name.toUpperCase() || n.startsWith(name.toUpperCase() + " ") || name.toUpperCase().startsWith(n + " "));

      if (!studentNameUpper) {
        studentNameUpper = name.toUpperCase();
        datesMap[dateStr][studentNameUpper] = { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: null };
      }

      if (period >= 1 && period <= 8) {
        if (!datesMap[dateStr][studentNameUpper][period]) {
          datesMap[dateStr][studentNameUpper][period] = timeStr;
        }
      }
    });

    // Render sorted by newest date first
    const sortedDates = Object.keys(datesMap).sort((a, b) => new Date(b) - new Date(a));

    sortedDates.forEach(dateStr => {
      for (const [studentName, records] of Object.entries(datesMap[dateStr])) {
        const tr = document.createElement("tr");
        let html = `<td>${studentName}</td><td>${dateStr}</td>`;

        for (let p = 1; p <= 8; p++) {
          if (records[p]) {
            html += `<td>✅ ${formatTimeAMPM(records[p])}</td>`;
          } else {
            html += `<td><span style="color: rgba(255,255,255,0.1)">-</span></td>`;
          }
        }
        tr.innerHTML = html;
        tbody.appendChild(tr);
      }
    });

  } catch (err) {
    showMessage(err.message || err, true);
  }
}

function getSelectedMonth() {
  const sel = document.getElementById("month-select");
  return sel && sel.value !== "all" ? sel.value : "";
}

async function loadMonths() {
  const sel = document.getElementById("month-select");
  if (!sel) return;
  try {
    const res = await fetch(`${API_BASE}/report/months`);
    const months = await res.json();
    sel.innerHTML = `<option value="all">All Months</option>` + months.map(m => `<option value="${m}">${m}</option>`).join("");
  } catch (_) { /* ignore */ }
}

async function loadSelectedMonth() {
  await loadReport(getSelectedMonth());
}

function init3DBackground() {
  const container = document.getElementById("three-bg");
  if (!container || !window.THREE) return;

  // WebGL check - prevents hanging on devices without GPU support
  try {
    const testCanvas = document.createElement('canvas');
    const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
    if (!gl) { console.warn('WebGL not supported. Skipping 3D background.'); return; }
  } catch (e) { return; }

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x051016, 0.0011);
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 2000);
  camera.position.z = 900;

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  const geometry = new THREE.BufferGeometry();
  const particleCount = window.innerWidth > 900 ? 3000 : 1200; // Optimized density for performance
  const vertices = [];
  const velocities = [];

  for (let i = 0; i < particleCount; i++) {
    vertices.push((Math.random() - 0.5) * 2500);
    vertices.push((Math.random() - 0.5) * 2500);
    vertices.push((Math.random() - 0.5) * 2500);
    velocities.push((Math.random() - 0.5) * 0.2); // Slow drift
  }

  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  const material = new THREE.PointsMaterial({
    color: 0xffffff, // Pure white dots as requested
    size: 3.5, // Slightly larger "fancy" dots
    opacity: 0.6,
    transparent: true,
    sizeAttenuation: true
  });

  const particles = new THREE.Points(geometry, material);
  scene.add(particles);

  const cursor = document.getElementById("cursor");
  document.addEventListener("mousemove", e => {
    mouseX = (e.clientX / window.innerWidth) * 2 - 1;
    mouseY = -(e.clientY / window.innerHeight) * 2 + 1;

    // Fancy Dot Cursor Follow
    if (cursor) {
      cursor.style.left = e.clientX + 'px';
      cursor.style.top = e.clientY + 'px';

      const target = e.target;
      const isInteractive = target.tagName === 'A' || target.tagName === 'BUTTON' || target.closest('.btn');
      cursor.classList.toggle('hovering', !!isInteractive);
    }
  });

  function animate() {
    requestAnimationFrame(animate);

    // Smooth flowing rotation
    particles.rotation.y += 0.0012;
    particles.rotation.x += 0.0004;

    // Interactive drift based on mouse
    camera.position.x += (mouseX * 400 - camera.position.x) * 0.02;
    camera.position.y += (mouseY * 400 - camera.position.y) * 0.02;

    camera.lookAt(scene.position);
    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

async function fetchAnalytics() {
  if (!jwtToken) return;

  try {
    const headers = { "Authorization": "Bearer " + jwtToken };
    const intRes = await fetch(`${API_BASE}/api/analytics/intelligence`, { headers });
    const intData = await intRes.json();
    if (intData.status === "success") {
      const occ = document.getElementById("stat-occupancy");
      const skip = document.getElementById("stat-skipped");
      if (occ) occ.textContent = intData.occupancy;
      if (skip) skip.textContent = intData.most_skipped_period;
    }

    const heatRes = await fetch(`${API_BASE}/api/analytics/heatmap`, { headers });
    const heatData = await heatRes.json();
    if (heatData.status === "success") {
      renderHeatmap(heatData.heatmap);
      renderTrendChart(heatData.heatmap);
    }
  } catch (e) {
    console.error("Analytics error", e);
  }
}

function renderHeatmap(data) {
  const grid = document.getElementById("heatmap-grid");
  if (!grid) return;
  grid.innerHTML = "";
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  grid.style.display = "grid";
  grid.style.gridTemplateColumns = "repeat(9, 1fr)";
  grid.style.gap = "4px";

  grid.innerHTML += `<div></div>`;
  for (let p = 1; p <= 8; p++) grid.innerHTML += `<div style="font-size:0.8rem; text-align:center;">P${p}</div>`;

  days.forEach(day => {
    grid.innerHTML += `<div style="font-size:0.8rem; text-align:right; padding-right:5px; align-self:center;">${day.substring(0, 3)}</div>`;
    for (let p = 1; p <= 8; p++) {
      let count = data[day][p] || 0;
      let pct = (count / 62) * 100;
      let color = "rgba(255,107,107,0.7)";
      if (pct >= 85) color = "rgba(110,231,183,0.7)";
      else if (pct >= 75) color = "rgba(253,203,110,0.7)";
      if (count === 0) color = "rgba(255,255,255,0.05)";

      grid.innerHTML += `<div title="${day} P${p}: ${count} present" style="background:${color}; height:24px; border-radius:4px; transition:0.3s;" class="heatmap-cell"></div>`;
    }
  });
}

function renderTrendChart(data) {
  const ctx = document.getElementById('trendChart');
  if (!ctx) return;
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const counts = days.map(d => {
    let sum = 0;
    for (let p = 1; p <= 8; p++) sum += data[d][p];
    return Math.round(sum / 8);
  });

  if (window.myTrendChart) window.myTrendChart.destroy();

  window.myTrendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: days.map(d => d.substring(0, 3)),
      datasets: [{
        label: 'Avg Daily Attendance',
        data: counts,
        borderColor: '#8af1ff',
        backgroundColor: 'rgba(138, 241, 255, 0.2)',
        tension: 0.3,
        fill: true
      }]
    },
    options: {
      responsive: true,
      scales: {
        y: { suggestedMin: 0, suggestedMax: 62, grid: { color: "rgba(255,255,255,0.1)" }, ticks: { color: "#fff" } },
        x: { grid: { color: "rgba(255,255,255,0.1)" }, ticks: { color: "#fff" } }
      },
      plugins: { legend: { display: false } }
    }
  });
}

function toggleChat() {
  const widget = document.getElementById("student-chat-widget") || document.getElementById("admin-chat-widget");
  const btn = document.getElementById("chat-toggle-btn");

  if (widget) {
    widget.classList.toggle("hidden");
    const isHidden = widget.classList.contains("hidden");

    // Auto-open body when unlocking widget
    const cb = document.getElementById("chat-body");
    if (!isHidden && cb) cb.classList.remove("hidden");

    // Toggle glowing button based on widget state
    if (btn) {
      if (isHidden) btn.classList.remove("hidden");
      else btn.classList.add("hidden");
    }
  }
}

window.toggleChat = toggleChat;

async function sendChat(endpoint) {
  const input = document.getElementById("chat-input");
  const msgs = document.getElementById("chat-messages");
  const query = input.value;
  if (!query.trim() || !jwtToken) return;

  msgs.innerHTML += `<div class="msg user" style="text-align:right; margin:5px; background:rgba(138,241,255,0.2); padding:8px; border-radius:8px;">${query}</div>`;
  input.value = "";

  try {
    const res = await fetch(`${API_BASE}/api/chat/${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + jwtToken },
      body: JSON.stringify({ query })
    });
    const data = await res.json();
    msgs.innerHTML += `<div class="msg ai" style="text-align:left; margin:5px; background:rgba(255,255,255,0.1); padding:8px; border-radius:8px;">${data.response || data.message || "Error"}</div>`;
    msgs.scrollTop = msgs.scrollHeight;
  } catch (e) {
    msgs.innerHTML += `<div class="msg ai" style="color:red">Connection Error</div>`;
  }
}

window.sendAdminChat = () => sendChat("admin");
window.sendStudentChat = () => sendChat("student");

// --- Google Auth Methods ---
async function handleGoogleLogin(response) {
  try {
    const res = await fetch(`${API_BASE}/api/google_login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });

    const data = await res.json();
    if (!res.ok) {
      const errEl = document.getElementById("auth-error");
      if (errEl) {
        errEl.textContent = data.message;
        errEl.classList.remove("hidden");
      }
      return;
    }

    // Save token and info
    jwtToken = data.token;
    sessionStorage.setItem("jwtToken", jwtToken);
    sessionStorage.setItem("role", data.role);
    sessionStorage.setItem("userInfo", JSON.stringify(data.user_info));

    // Redirect to dashboard
    window.location.href = "dashboard.html";
  } catch (err) {
    const errEl = document.getElementById("auth-error");
    if (errEl) {
      errEl.textContent = "Connection error. Ensure backend is running.";
      errEl.classList.remove("hidden");
    }
  }
}

function checkAuthProtection() {
  const page = document.body.dataset.page;
  // Allow home, register, admin, and the new attendance page to bypass auth redirect
  if (!jwtToken && page !== "home" && page !== "login" && page !== "admin" && page !== "attendance") {
    console.warn("Unauthorized access attempt. Redirecting to home.");
    window.location.href = "index.html";
  }
}

// Run init on load
document.addEventListener("DOMContentLoaded", initPage);

function initPage() {
  try {
    // Initialize DOM references now that the DOM is ready
    video = document.getElementById("video");
    canvas = document.getElementById("canvas");
    output = document.getElementById("output");
    scanState = document.getElementById("scan-state");

    init3DBackground();
    if (window.VanillaTilt) VanillaTilt.init(document.querySelectorAll("[data-tilt]"));

    checkAuthProtection();

    const page = document.body.dataset.page;
    if (page === "dashboard") {
      // Dashboard: ONLY load reports and analytics. Camera is on attendance.html.
      loadMonths().then(() => loadReport(getSelectedMonth())).catch(console.warn);
      if (jwtToken) {
        dashboardInterval = setInterval(() => loadReport(getSelectedMonth()), 10000);
        setTimeout(fetchAnalytics, 1500);
      }
    } else if (page === "attendance") {
      // Dedicated attendance page - start camera here
      startCamera();
    } else if (page === "register") {
      startCamera();
    } else if (page === "profile") {
      const dl = document.getElementById("class-list-datalist");
      if (dl && typeof CLASS_LIST !== 'undefined') {
        dl.innerHTML = CLASS_LIST.map(n => `<option value="${n}">`).join("");
      }
    }
  } catch (err) {
    console.error("Page Init Error:", err);
  }
}

function logout() {
  console.log("Logging out...");
  sessionStorage.removeItem("jwtToken");
  sessionStorage.removeItem("role");
  sessionStorage.removeItem("userInfo");
  jwtToken = null;
  if (typeof stopAttendance === 'function') stopAttendance();
  window.location.href = "index.html";
}

function openAdminRegister() {
  const entered = prompt("Enter Admin ID: (e.g. Sriramgandhi.Dev)");
  if (!entered) return;
  const pwd = prompt("Enter Admin Password:");

  // Support both original and requested admin bypass in frontend as well
  if ((entered === "sriram.dev" && pwd === "1234") ||
    (entered === "Sriramgandhi.Dev" && pwd === "1234")) {
    window.location.href = "register.html";
  } else {
    alert("Invalid Admin Credentials");
  }
}

async function loginAdmin(event) {
  if (event) event.preventDefault();
  const name = document.getElementById("admin-user").value;
  const password = document.getElementById("admin-pass").value;
  const output = document.getElementById("output");

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "admin", name, password })
    });
    const data = await res.json();

    if (data.status === "success") {
      sessionStorage.setItem("jwtToken", data.token);
      sessionStorage.setItem("role", data.role);
      jwtToken = data.token;
      if (output) output.innerText = "Authenticated! Redirecting...";
      setTimeout(() => window.location.href = "dashboard.html", 1000);
    } else {
      if (output) output.innerText = "Error: " + (data.message || "Invalid credentials");
    }
  } catch (err) {
    if (output) output.innerText = "Connection error: " + err.message;
  }
}

window.logout = logout;
window.handleGoogleLogin = handleGoogleLogin;
window.openAdminRegister = openAdminRegister;
window.loginAdmin = loginAdmin;
window.startAttendance = startAttendance;
window.stopAttendance = stopAttendance;
window.registerStudent = registerStudent;
window.loadReport = loadReport;
window.searchFromDashboard = searchFromDashboard;
window.searchProfilePage = searchProfilePage;
window.openAdminEdit = openAdminEdit;
window.saveStudentUpdate = saveStudentUpdate;
window.loadSelectedMonth = loadSelectedMonth;
