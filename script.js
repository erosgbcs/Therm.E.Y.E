// ═══════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════
const DEFAULT_ROOMS = [
  {
    id: "room1",
    name: "Room-1",
    sensors: [
      { id: "AMG8833_1", name: "S1: ELEC FAN BACK" },
      { id: "AMG8833_2", name: "S2: THERMAL CAMERA" },
    ],
  },
];

const sensorsData = {};
const globalEventHistory = [];
const lastDbWriteTime = new Map();
let activeRoomId = DEFAULT_ROOMS[0].id;
let activeSensorId = DEFAULT_ROOMS[0].sensors[0].id;
let isCelsius = true;
let esp32Sockets = [];
let esp32Connections = [false];
let monitoringEnabled = false;
const lastPublishedTelemetry = new Map();
window.ignoreInitialFirebaseTemp = true;

let audioCtx;
let alarmInterval = null;
let isAuthenticated = false;

// ═══════════════════════════════════════════════════════════════
// INIT SENSOR DATA
// ═══════════════════════════════════════════════════════════════
function initSensorsData() {
  DEFAULT_ROOMS.forEach((room) => {
    room.sensors.forEach((sensor) => {
      const key = `${room.id}_${sensor.id}`;
      if (!sensorsData[key]) {
        sensorsData[key] = {
          roomId: room.id,
          roomName: room.name,
          sensorId: sensor.id,
          sensorName: sensor.name,
          dataLog: [],
          safeLimit: 50.0,
          currentTemp: null,
          status: "NORMAL",
          acknowledged: false,
          lastEventTime: 0,
        };
      }
    });
  });
}
initSensorsData();

function getActiveSensorData() {
  return sensorsData[`${activeRoomId}_${activeSensorId}`] || null;
}
function getActiveKey() {
  return `${activeRoomId}_${activeSensorId}`;
}

// ═══════════════════════════════════════════════════════════════
// DOM REFS
// ═══════════════════════════════════════════════════════════════
const $currentTemp = document.getElementById("currentTemp");
const $highTemp = document.getElementById("highTemp");
const $lowTemp = document.getElementById("lowTemp");
const $avgTemp = document.getElementById("avgTemp");
const $alertBanner = document.getElementById("alertBanner");
const $tempStatusText = document.getElementById("tempStatusText");
const $thermalStateBadge = document.getElementById("thermalStateBadge");
const $deviceBadge = document.getElementById("deviceBadge1");
const $limitInput = document.getElementById("limitInput");
const $limitLabel = document.getElementById("limitLabel");
const $telemetryLogBody = document.getElementById("telemetryLogBody");
const $esp32HostInputs = [document.getElementById("esp32HostInput1")];
const $deviceBadges = [document.getElementById("deviceBadge1")];
const $authScreen = document.getElementById("auth-screen");
const $dashboardContainer = document.getElementById("dashboard-container");
const $authError = document.getElementById("authError");
const $authSuccess = document.getElementById("authSuccess");
const $authSubmitBtn = document.getElementById("authSubmitBtn");
const $authEmail = document.getElementById("authEmail");
const $authPassword = document.getElementById("authPassword");
const $activeSensorSelect = document.getElementById("activeSensorSelect");
const $unitSegmented = document.getElementById("unitSegmented");
const $settingsModal = document.getElementById("settingsModal");

window.authMode = "signin";

// ═══════════════════════════════════════════════════════════════
// DATE / TIME
// ═══════════════════════════════════════════════════════════════
function updateDateTime() {
  const now = new Date();
  const d = document.getElementById("currentDate");
  const t = document.getElementById("currentTime");
  if (d) d.innerText = now.toLocaleDateString(undefined, {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
  });
  if (t) t.innerText = now.toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
  });
}
setInterval(updateDateTime, 1000);
updateDateTime();

// ═══════════════════════════════════════════════════════════════
// TEMP FORMATTING
// ═══════════════════════════════════════════════════════════════
function formatTemp(tempInC) {
  if (tempInC === null || tempInC === undefined || isNaN(tempInC)) return "--.-°C";
  if (isCelsius) return `${tempInC.toFixed(1)}°C`;
  return `${((tempInC * 9) / 5 + 32).toFixed(1)}°F`;
}
function toCelsius(val) { return isCelsius ? val : ((val - 32) * 5) / 9; }
function fromCelsius(val) { return isCelsius ? val : (val * 9) / 5 + 32; }

function formatHistoryTime(entry) {
  if (entry && entry.timestamp) {
    return new Date(entry.timestamp).toLocaleTimeString(undefined, { hour12: true });
  }
  return entry && entry.time ? entry.time : "--:--:--";
}

// ═══════════════════════════════════════════════════════════════
// AUDIO
// ═══════════════════════════════════════════════════════════════
document.addEventListener("click", () => {
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}, { once: false });

function playSystemBeep() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(800, audioCtx.currentTime);
  gain.gain.setValueAtTime(1, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.5);
}
function startSiren() {
  if (!isAuthenticated) return;
  if (!alarmInterval) {
    playSystemBeep();
    alarmInterval = setInterval(playSystemBeep, 1000);
  }
}
function stopSiren() {
  if (alarmInterval) { clearInterval(alarmInterval); alarmInterval = null; }
}

// ═══════════════════════════════════════════════════════════════
// RENDER SENSOR DROPDOWN
// ═══════════════════════════════════════════════════════════════
function populateActiveSensorSelect() {
  if (!$activeSensorSelect) return;
  $activeSensorSelect.innerHTML = Object.keys(sensorsData).map(key => {
    const sd = sensorsData[key];
    return `<option value="${key}">${sd.roomName} › ${sd.sensorName}</option>`;
  }).join("");
  $activeSensorSelect.value = getActiveKey();
}
function updateActiveSensorSelect() {
  if (!$activeSensorSelect) return;
  $activeSensorSelect.value = getActiveKey();
}
$activeSensorSelect?.addEventListener("change", (e) => {
  const [roomId, ...parts] = e.target.value.split("_");
  activeRoomId = roomId;
  activeSensorId = parts.join("_");
  refreshHeroDisplay();
  updateLimitInputForActiveSensor();
  populateActiveSensorSelect();
});

function updateLimitInputForActiveSensor() {
  const sd = getActiveSensorData();
  if (sd && $limitInput) $limitInput.value = fromCelsius(sd.safeLimit).toFixed(1);
}

// ═══════════════════════════════════════════════════════════════
// REFRESH HERO + STATS + NEW UI
// ═══════════════════════════════════════════════════════════════
function refreshHeroDisplay() {
  const sd = getActiveSensorData();

  if (!sd || sd.currentTemp === null) {
    $currentTemp.innerText = "--.-°C";
    $currentTemp.className = "temp-big";
    $highTemp.innerText = "--.-°C";
    $lowTemp.innerText = "--.-°C";
    $avgTemp.innerText = "--.-°C";
    $thermalStateBadge.className = "state-badge normal";
    $thermalStateBadge.innerText = "NORMAL";
    $tempStatusText.innerText = "Waiting for data...";
$tempStatusText.className = "status-text text-muted";
    $alertBanner.style.display = "none";
    $alertBanner.className = "alert-banner";
    const tb = document.getElementById("tempBlock");
    if (tb) tb.className = "temp-block status-safe";
    stopSiren();

    renderSparkline();
    renderInlineStats();
    renderRecentEvents();
    renderTableLog();
    updateStatusChip();
    updateActiveSensorSelect();
    return;
  }

  const dataLog = sd.dataLog;
  const highest = dataLog.length ? Math.max(...dataLog) : sd.currentTemp;
  const lowest = dataLog.length ? Math.min(...dataLog) : sd.currentTemp;
  const average = dataLog.length ? dataLog.reduce((a, b) => a + b, 0) / dataLog.length : sd.currentTemp;

  $currentTemp.innerText = formatTemp(sd.currentTemp);
  $highTemp.innerText = formatTemp(highest);
  $lowTemp.innerText = formatTemp(lowest);
  $avgTemp.innerText = formatTemp(average);

  $currentTemp.className = "temp-big";
$tempStatusText.className = "status-text text-muted";
  $thermalStateBadge.className = "state-badge";
  $alertBanner.style.display = "none";
  $alertBanner.className = "alert-banner";

  const tempBlock = document.getElementById("tempBlock");
  if (tempBlock) tempBlock.className = "temp-block";

  if (sd.status === "CRITICAL") {
    $currentTemp.classList.add("status-danger");
    if (tempBlock) tempBlock.classList.add("status-danger");
    $alertBanner.style.display = "flex";
    $alertBanner.className = "alert-banner" + (sd.acknowledged ? " acknowledged" : "");
    $alertBanner.innerHTML = `
      <div class="msg">
        <svg class="icon" viewBox="0 0 24 24" style="flex-shrink:0"><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/></svg>
        <span><strong>${sd.roomName} › ${sd.sensorName}</strong> breached safe limit (${formatTemp(sd.safeLimit)}). Current: ${formatTemp(sd.currentTemp)}</span>
      </div>
      <button class="ack-btn" id="ackBtn" type="button">
        <svg class="icon" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg> Acknowledge
      </button>`;
    $tempStatusText.innerText = sd.acknowledged ? "Alarm acknowledged" : "Appliance Temperature Critical";
    $tempStatusText.classList.add("status-danger");
    $thermalStateBadge.innerText = "CRITICAL BREACH";
    $thermalStateBadge.classList.add("critical");
    if (!sd.acknowledged) startSiren(); else stopSiren();
  } else if (sd.status === "HIGH_HEAT") {
    $currentTemp.classList.add("status-warning");
    if (tempBlock) tempBlock.classList.add("status-warning");
    sd.acknowledged = false;
    $tempStatusText.innerText = "Approaching Limit Alert";
    $tempStatusText.classList.add("status-warning");
    $thermalStateBadge.innerText = "HIGH HEAT";
    $thermalStateBadge.classList.add("high-heat");
    stopSiren();
  } else {
    $currentTemp.classList.add("status-safe");
    if (tempBlock) tempBlock.classList.add("status-safe");
    sd.acknowledged = false;
    $tempStatusText.innerText = "Appliance Operational — Stable";
    $tempStatusText.classList.add("status-safe");
    $thermalStateBadge.innerText = "NORMAL";
    $thermalStateBadge.classList.add("normal");
    stopSiren();
  }

  renderSparkline();
  renderInlineStats();
  renderRecentEvents();
  renderTableLog();
  updateStatusChip();
  updateActiveSensorSelect();
}

// ═══════════════════════════════════════════════════════════════
// SPARKLINE
// ═══════════════════════════════════════════════════════════════
function renderSparkline() {
  const sd = getActiveSensorData();
  const lineEl = document.getElementById("sparkLine");
  const fillEl = document.getElementById("sparkFill");
  const nowEl = document.getElementById("sparkNow");
  if (!lineEl || !fillEl) return;

  const data = sd && sd.dataLog ? sd.dataLog.slice(-60) : [];
  if (data.length < 2) {
    lineEl.setAttribute("d", "");
    fillEl.setAttribute("d", "");
    if (nowEl) nowEl.textContent = sd && sd.currentTemp !== null ? formatTemp(sd.currentTemp) : "--.-°C";
    return;
  }
  const min = Math.min(...data) - 2;
  const max = Math.max(...data) + 2;
  const range = max - min || 1;
  const W = 200, H = 70;
  const stepX = W / (data.length - 1);
  const points = data.map((v, i) => [i * stepX, H - ((v - min) / range) * H]);
  const linePath = "M" + points.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L");
  const fillPath = linePath + ` L${W},${H} L0,${H} Z`;
  lineEl.setAttribute("d", linePath);
  fillEl.setAttribute("d", fillPath);
  if (nowEl && sd && sd.currentTemp !== null) nowEl.textContent = formatTemp(sd.currentTemp);
}

// ═══════════════════════════════════════════════════════════════
// INLINE STATS
// ═══════════════════════════════════════════════════════════════
function renderInlineStats() {
  const sd = getActiveSensorData();
  if (!sd || !sd.dataLog || sd.dataLog.length === 0 || sd.currentTemp === null) {
    ["highTemp", "lowTemp", "avgTemp"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = "--.-°C";
    });
    const lastEl = document.getElementById("lastReading");
    if (lastEl) lastEl.textContent = sd && sd.currentTemp === null ? "offline" : "--";
    return;
  }
  const log = sd.dataLog;
  document.getElementById("highTemp").textContent = formatTemp(Math.max(...log));
  document.getElementById("lowTemp").textContent = formatTemp(Math.min(...log));
  document.getElementById("avgTemp").textContent = formatTemp(log.reduce((a, b) => a + b, 0) / log.length);

  const lastEl = document.getElementById("lastReading");
  if (lastEl) {
    const ago = sd.lastEventTime ? Math.floor((Date.now() - sd.lastEventTime) / 1000) : null;
    lastEl.textContent = ago === null ? "—" : ago < 2 ? "just now" : `${ago}s ago`;
  }
}

// ═══════════════════════════════════════════════════════════════
// RECENT EVENTS
// ═══════════════════════════════════════════════════════════════
function renderRecentEvents() {
  const wrap = document.getElementById("recentEvents");
  if (!wrap) return;
  const items = globalEventHistory.slice(0, 5);
  if (!items.length) {
    wrap.innerHTML = `<div class="muted" style="padding:1rem;text-align:center;font-size:.85rem">No events yet.</div>`;
    return;
  }
  wrap.innerHTML = items.map(e => {
    const isAlarm = e.isAlarm || e.status === "ALARM DETECTED";
    const sLabel = e.status === "ALARM DETECTED" ? "Critical" : e.status === "HIGH HEAT" ? "High Heat" : "Normal";
    return `<div class="event-row ${isAlarm ? "alarm" : ""}">
      <span class="time">${e.time || "--"}</span>
      <span class="room">${e.roomName || "--"}</span>
      <span class="sensor">${e.sensorName || "--"}</span>
      <span class="evt">${formatTemp(e.temp)}</span>
      <span class="status ${isAlarm ? "CRITICAL" : "NORMAL"}">${sLabel}</span>
    </div>`;
  }).join("");
}

// ═══════════════════════════════════════════════════════════════
// STATUS CHIP
// ═══════════════════════════════════════════════════════════════
function updateStatusChip() {
  const chip = document.getElementById("statusChip");
  const text = document.getElementById("statusChipText");
  if (!chip || !text) return;
  if (!isAuthenticated) return;
  if (!monitoringEnabled || !esp32Connections[0]) {
    chip.className = "status-chip offline";
    text.textContent = "Offline";
  } else if (Date.now() - lastDataReceivedTime > 2500) {
    chip.className = "status-chip delayed";
    text.textContent = "Delayed";
  } else {
    chip.className = "status-chip live";
    text.textContent = "Live";
  }
}
setInterval(updateStatusChip, 1000);

// ═══════════════════════════════════════════════════════════════
// ACKNOWLEDGE (delegated)
// ═══════════════════════════════════════════════════════════════
$alertBanner?.addEventListener("click", (e) => {
  if (!e.target.closest("#ackBtn")) return;
  const sd = getActiveSensorData();
  if (sd) { sd.acknowledged = true; refreshHeroDisplay(); }
});
// ── Sensor name editor (Settings modal) ──
function populateSensorNamesEditor() {
  const wrap = document.getElementById("sensorNamesEditor");
  if (!wrap) return;
  wrap.innerHTML = Object.values(sensorsData).map(sd => `
    <div style="display:flex;flex-direction:column;gap:.3rem">
      <span class="muted" style="font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;font-weight:700">
        ${sd.roomName} › ${sd.sensorId}
      </span>
      <input type="text" class="sensor-name-input" data-key="${sd.roomId}_${sd.sensorId}"
             value="${(sd.sensorName || "").replace(/"/g, "&quot;")}" placeholder="Sensor name" />
    </div>
  `).join("");
}

function saveSensorNames() {
  const inputs = document.querySelectorAll(".sensor-name-input");
  let anyChanged = false;
  inputs.forEach(input => {
    const key = input.dataset.key;
    const sd = sensorsData[key];
    if (!sd) return;
    const newName = input.value.trim();
    if (!newName || newName === sd.sensorName) return;
    
    sd.sensorName = newName;
    anyChanged = true;
    
    const room = DEFAULT_ROOMS.find(r => r.id === sd.roomId);
    if (room) {
      const sensor = room.sensors.find(s => s.id === sd.sensorId);
      if (sensor) sensor.name = newName;
    }
    
    esp32Sockets.forEach(socket => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: "updateSensorName",
          sensorId: sd.sensorId,
          sensorName: newName,
        }));
      }
    });
    
    if (typeof window.publishSensorNameToDatabase === "function") {
      window.publishSensorNameToDatabase(sd.roomId, sd.sensorId, newName);
    }
  });
  
  if (anyChanged) {
    populateActiveSensorSelect();
    populateMapSensorSelect();
    refreshHeroDisplay();
    renderTableLog();
    renderRecentEvents();
  }
}
// ═══════════════════════════════════════════════════════════════
// EVALUATE METRICS
// ═══════════════════════════════════════════════════════════════
function evaluateMetrics(
  roomId, sensorId, newTemp,
  { publishTelemetry = true, publishHistory = true, refreshDashboard = true, recordHistory = true } = {}
) {
  if (!isAuthenticated || !monitoringEnabled) return;

  const key = `${roomId}_${sensorId}`;
  let sd = sensorsData[key];

  if (!sd) {
    const room = DEFAULT_ROOMS.find(r => r.id === roomId) || { id: roomId, name: roomId, sensors: [] };
    sensorsData[key] = {
      roomId, roomName: room.name, sensorId, sensorName: sensorId,
      dataLog: [], safeLimit: 50.0, currentTemp: null, status: "NORMAL",
      acknowledged: false, lastEventTime: 0,
    };
    sd = sensorsData[key];
  }

  sd.dataLog.push(newTemp);
  sd.currentTemp = newTemp;
  if (sd.dataLog.length > 500) sd.dataLog.shift();

  if (newTemp >= sd.safeLimit) sd.status = "CRITICAL";
  else if (newTemp >= sd.safeLimit - 2.0) sd.status = "HIGH_HEAT";
  else sd.status = "NORMAL";

  const now = Date.now();
  if (recordHistory && (!sd.lastEventTime || now - sd.lastEventTime > 2000)) {
    sd.lastEventTime = now;
    const timeStr = new Date(now).toLocaleTimeString("en-US", { hour12: true });
    const eventEntry = {
      timestamp: now,
      time: timeStr,
      roomId: sd.roomId,
      roomName: sd.roomName,
      sensorId: sd.sensorId,
      sensorName: sd.sensorName,
      event: sd.status === "CRITICAL" ? "ALARM" : sd.status === "HIGH_HEAT" ? "WARNING" : "READING",
      temp: newTemp,
      status: sd.status === "CRITICAL" ? "ALARM DETECTED" : sd.status === "HIGH_HEAT" ? "HIGH HEAT" : "NORMAL",
      isAlarm: sd.status === "CRITICAL",
    };

    globalEventHistory.unshift(eventEntry);
    if (globalEventHistory.length > 500) globalEventHistory.length = 500;

    if (typeof appendLogEntryToTable === "function") appendLogEntryToTable(eventEntry);
    if (publishHistory && typeof window.publishEventHistoryToDatabase === "function") {
      window.publishEventHistoryToDatabase(eventEntry);
    }
  }

  const lastWrite = lastDbWriteTime.get(key) || 0;
  if (publishTelemetry && now - lastWrite > 2000) {
    lastDbWriteTime.set(key, now);
    if (typeof window.publishTemperatureToDatabase === "function") {
      window.publishTemperatureToDatabase(roomId, sensorId, newTemp);
    }
  }

  if (roomId === activeRoomId && sensorId === activeSensorId && refreshDashboard) {
    refreshHeroDisplay();
  }

  const mapPage = document.getElementById("thermalMappingPage");
  const sensorKey = `${roomId}_${sensorId}`;
  if (mapPage && mapPage.classList.contains("active") && mapState.sensorId === sensorKey) {
    loadSensorToMap(sensorKey);
    if (!mapState.dataStale) recordMapSnapshot();
  }
}

// ═══════════════════════════════════════════════════════════════
// LOG TABLE
// ═══════════════════════════════════════════════════════════════
function appendLogEntryToTable(item) {
  if (!$telemetryLogBody) return;
  const row = document.createElement("tr");
  if (item.isAlarm || item.status === "ALARM DETECTED") row.className = "row-alarm";
  row.innerHTML = `
    <td>${formatHistoryTime(item)}</td>
    <td>${item.roomName || "--"}</td>
    <td>${item.sensorName || "--"}</td>
    <td><strong>${item.event || "STATUS_CHANGE"}</strong></td>
    <td>${formatTemp(item.temp)}</td>
    <td>${item.status}</td>`;
  $telemetryLogBody.prepend(row);
  while ($telemetryLogBody.children.length > 100) {
    $telemetryLogBody.removeChild($telemetryLogBody.lastElementChild);
  }
}

function renderTableLog() {
  if (!$telemetryLogBody) return;
  if (!globalEventHistory || globalEventHistory.length === 0) {
    $telemetryLogBody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#888;">No history events recorded yet.</td></tr>`;
    return;
  }
  $telemetryLogBody.innerHTML = globalEventHistory.slice(0, 100).map(item => {
    const isAlarmClass = (item.isAlarm || item.status === "ALARM DETECTED") ? ' class="row-alarm"' : "";
    return `<tr${isAlarmClass}>
      <td>${formatHistoryTime(item)}</td>
      <td>${item.roomName || "--"}</td>
      <td>${item.sensorName || "--"}</td>
      <td><strong>${item.event || "STATUS_CHANGE"}</strong></td>
      <td>${formatTemp(item.temp)}</td>
      <td>${item.status}</td>
    </tr>`;
  }).join("");
}

document.getElementById("exportCsvBtn")?.addEventListener("click", () => {
  const entries = globalEventHistory.slice(0, 200);
  let csv = "Time,Room,Sensor,Event,Temperature,Status\n";
  entries.forEach(item => {
    const tempVal = isCelsius ? item.temp.toFixed(1) : ((item.temp * 9) / 5 + 32).toFixed(1);
    const unit = isCelsius ? "C" : "F";
    csv += `"${item.time}","${item.roomName || ""}","${item.sensorName || ""}","${item.event}","${tempVal}°${unit}","${item.status}"\n`;
  });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ThermEYE_Log_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

document.getElementById("clearLogBtn")?.addEventListener("click", () => {
  if (confirm("Clear all local event log entries? (Firebase data remains intact)")) {
    globalEventHistory.length = 0;
    renderTableLog();
    renderRecentEvents();
  }
});

// ═══════════════════════════════════════════════════════════════
// SAFE LIMIT (DEBOUNCED)
// ═══════════════════════════════════════════════════════════════
let _limitDebounce;
$limitInput?.addEventListener("input", () => {
  clearTimeout(_limitDebounce);
  _limitDebounce = setTimeout(() => {
    const val = parseFloat($limitInput.value);
    if (isNaN(val)) return;
    const celsiusVal = toCelsius(val);
    const sd = getActiveSensorData();
    if (!sd) return;
    sd.safeLimit = celsiusVal;
    esp32Sockets.forEach(socket => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ safeLimit: celsiusVal }));
      }
    });
    if (sd.currentTemp !== null) {
      if (sd.currentTemp >= sd.safeLimit) sd.status = "CRITICAL";
      else if (sd.currentTemp >= sd.safeLimit - 2.0) sd.status = "HIGH_HEAT";
      else sd.status = "NORMAL";
      refreshHeroDisplay();
    }
  }, 300);
});

// ═══════════════════════════════════════════════════════════════
// UNIT TOGGLE (SEGMENTED IN SETTINGS MODAL)
// ═══════════════════════════════════════════════════════════════
function toggleUnit() {
  isCelsius = !isCelsius;
  const unitEl = document.getElementById("unitDisplay");
  if (unitEl) unitEl.textContent = isCelsius ? "Celsius" : "Fahrenheit";
  if ($limitLabel) $limitLabel.innerText = isCelsius ? "Safe Limit (°C)" : "Safe Limit (°F)";
  document.querySelectorAll("#unitSegmented button").forEach(b => {
    b.classList.toggle("active", (isCelsius && b.dataset.unit === "C") || (!isCelsius && b.dataset.unit === "F"));
  });
  updateLimitInputForActiveSensor();
  refreshHeroDisplay();
  renderTableLog();
  sendUnitToEsp32(isCelsius ? "C" : "F");
}
$unitSegmented?.querySelectorAll("button").forEach(btn => {
  btn.addEventListener("click", toggleUnit);
});

function sendUnitToEsp32(unitType) {
  esp32Sockets.forEach(socket => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ unit: unitType }));
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// THEME TOGGLE
// ═══════════════════════════════════════════════════════════════
function setTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    const icon = document.getElementById("themeIcon");
    if (icon) icon.innerHTML = `<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>`;
    localStorage.setItem("theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
    const icon = document.getElementById("themeIcon");
    if (icon) icon.innerHTML = `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>`;
    localStorage.setItem("theme", "dark");
  }
}
document.getElementById("themeToggle")?.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  setTheme(current === "light" ? "dark" : "light");
});
const savedTheme = localStorage.getItem("theme");
if (savedTheme === "light") setTheme("light"); else setTheme("dark");

// ═══════════════════════════════════════════════════════════════
// SETTINGS MODAL
// ═══════════════════════════════════════════════════════════════
document.getElementById("openSettingsBtn")?.addEventListener("click", () => {
  const input = document.getElementById("esp32HostInput1");
  if (input) input.value = localStorage.getItem("esp32Host1") || "";
  document.querySelectorAll("#unitSegmented button").forEach(b => {
    b.classList.toggle("active", (isCelsius && b.dataset.unit === "C") || (!isCelsius && b.dataset.unit === "F"));
  });
  populateSensorNamesEditor();
  $settingsModal?.classList.add("open");
});
function closeSettings() { $settingsModal?.classList.remove("open"); }
document.getElementById("closeSettingsBtn")?.addEventListener("click", closeSettings);
document.getElementById("cancelSettingsBtn")?.addEventListener("click", closeSettings);
$settingsModal?.addEventListener("click", (e) => { if (e.target === $settingsModal) closeSettings(); });

document.getElementById("saveSettingsBtn")?.addEventListener("click", () => {
  const host = document.getElementById("esp32HostInput1")?.value.trim() || "";
  if ($esp32HostInputs[0]) $esp32HostInputs[0].value = host;
  localStorage.setItem("esp32Host1", host);
  const hostDisplay = document.getElementById("hostDisplay");
  if (hostDisplay) hostDisplay.textContent = host || "—";
  saveSensorNames();
  closeSettings();
  if (typeof connectToEsp32 === "function") connectToEsp32(0);
});

// ═══════════════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════════════
function switchTab(tab) {
  document.querySelectorAll(".tab-bar button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.dataset.page === tab));

  if (tab === "map") {
    initThermalMapping();
    if (mapState.sensorId && sensorsData[mapState.sensorId]) loadSensorToMap(mapState.sensorId);
  }
  if (tab === "dashboard") refreshHeroDisplay();
  if (tab === "log") renderTableLog();
}
document.querySelectorAll(".tab-bar button").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
document.querySelectorAll("[data-goto]").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.goto));
});

// ═══════════════════════════════════════════════════════════════
// THERMAL MAPPING
// ═══════════════════════════════════════════════════════════════
const mapState = {
  grid: Array(64).fill(0),
  sensorId: null,
  history: [],
  interval: null,
  isActive: false,
  dataStale: false,
};

const $mapGrid = document.getElementById("thermalGridContainer");
const $mapSensorLabel = document.getElementById("mapSensorLabel");
const $mapAvgTemp = document.getElementById("mapAvgTemp");
const $mapMaxTemp = document.getElementById("mapMaxTemp");
const $mapMinTemp = document.getElementById("mapMinTemp");
const $mapLogBody = document.getElementById("mapLogBody");
const $mapSensorSelect = document.getElementById("mapSensorSelect");

function getHeatColor(temp) {
  const min = 20, max = 60;
  const clamped = Math.max(min, Math.min(max, temp));
  const ratio = (clamped - min) / (max - min);
  const r = Math.min(255, Math.round(ratio * 255));
  const g = Math.min(255, Math.round((1 - Math.abs(ratio - 0.5) * 2) * 255));
  const b = Math.min(255, Math.round((1 - ratio) * 255));
  return `rgb(${r},${g},${b})`;
}

function renderThermalGrid() {
  if (!$mapGrid) return;
  const hasData = mapState.grid.some(v => v > 0.1 && !isNaN(v));
  if (!hasData || mapState.dataStale) {
    $mapGrid.innerHTML = Array(64).fill(0).map(() =>
      `<div style="background:#444;aspect-ratio:1/1;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#888;font-size:0.6rem;">N/A</div>`
    ).join("");
    if ($mapAvgTemp) $mapAvgTemp.textContent = "--";
    if ($mapMaxTemp) $mapMaxTemp.textContent = "--";
    if ($mapMinTemp) $mapMinTemp.textContent = "--";
    const hotspotEl = document.getElementById("mapHotspot");
    if (hotspotEl) hotspotEl.textContent = "--";
    return;
  }
  $mapGrid.innerHTML = mapState.grid.map((temp) => {
    const color = getHeatColor(temp);
    const label = isCelsius ? temp.toFixed(1) + "°" : ((temp * 9) / 5 + 32).toFixed(1) + "°";
    return `<div style="background:${color};aspect-ratio:1/1;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:700;color:#fff;text-shadow:0 0 4px rgba(0,0,0,0.7);">${label}</div>`;
  }).join("");
  updateMapStats();
}

function updateMapStats() {
  if (!mapState.grid || mapState.grid.length === 0) return;
  const valid = mapState.grid.filter(v => !isNaN(v));
  if (valid.length === 0) return;
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const max = Math.max(...valid);
  const min = Math.min(...valid);
  const fmt = (v) => `${(isCelsius ? v : (v * 9 / 5 + 32)).toFixed(1)}°${isCelsius ? "C" : "F"}`;
  if ($mapAvgTemp) $mapAvgTemp.textContent = fmt(avg);
  if ($mapMaxTemp) $mapMaxTemp.textContent = fmt(max);
  if ($mapMinTemp) $mapMinTemp.textContent = fmt(min);
  const idx = mapState.grid.indexOf(max);
  const row = Math.floor(idx / 8), col = idx % 8;
  const hotspotEl = document.getElementById("mapHotspot");
  if (hotspotEl) hotspotEl.textContent = `Row ${row + 1}, Col ${col + 1}`;
}

function populateMapSensorSelect() {
  if (!$mapSensorSelect) return;
  const keys = Object.keys(sensorsData);
  if (!keys.length) {
    $mapSensorSelect.innerHTML = "<option>No sensors available</option>";
    return;
  }
  $mapSensorSelect.innerHTML = keys.map(key => {
    const sd = sensorsData[key];
    return `<option value="${key}">${sd.roomName} › ${sd.sensorName}</option>`;
  }).join("");
  if (!mapState.sensorId || !sensorsData[mapState.sensorId]) {
    mapState.sensorId = keys[0];
  }
  $mapSensorSelect.value = mapState.sensorId;
}

function generateHeatDistribution(baseTemp) {
  const center = 3.5;
  mapState.grid = Array(64).fill(0).map((_, i) => {
    const row = Math.floor(i / 8), col = i % 8;
    const centerDist = Math.sqrt(Math.pow(row - center, 2) + Math.pow(col - center, 2));
    return Math.max(15, Math.min(70, baseTemp - centerDist * 1.5));
  });
}

function loadSensorToMap(sensorKey) {
  const sd = sensorsData[sensorKey];
  if (!sd) {
    mapState.dataStale = true;
    if ($mapSensorLabel) $mapSensorLabel.textContent = "Sensor not found";
    renderThermalGrid();
    return;
  }
  let baseTemp = sd.currentTemp;
  if (baseTemp === null || baseTemp === undefined || baseTemp <= 0.1) {
    if (sd.dataLog && sd.dataLog.length > 0) baseTemp = sd.dataLog[sd.dataLog.length - 1];
  }
  if (baseTemp === null || baseTemp === undefined || baseTemp <= 0.1) {
    mapState.dataStale = true;
    if ($mapSensorLabel) $mapSensorLabel.textContent = `${sd.roomName} › ${sd.sensorName} — No Data`;
    renderThermalGrid();
    return;
  }
  mapState.dataStale = false;
  generateHeatDistribution(baseTemp);
  if ($mapSensorLabel) $mapSensorLabel.textContent = `${sd.roomName} › ${sd.sensorName} (${baseTemp.toFixed(1)}°C)`;
  renderThermalGrid();
}

function recordMapSnapshot() {
  const data = mapState.grid.filter(v => !isNaN(v) && v > 0.1);
  if (!data.length) return;
  const avg = data.reduce((a, b) => a + b, 0) / data.length;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const entry = {
    time: new Date().toLocaleTimeString(undefined, { hour12: true }),
    sensor: $mapSensorLabel.textContent.replace(/\(.*\)/, "").trim(),
    avg: avg.toFixed(1),
    max: max.toFixed(1),
    min: min.toFixed(1),
  };
  mapState.history.unshift(entry);
  if (mapState.history.length > 50) mapState.history.length = 50;
  renderMapLog();
}

function renderMapLog() {
  if (!$mapLogBody) return;
  $mapLogBody.innerHTML = mapState.history.slice(0, 30).map(e => `
    <tr>
      <td>${e.time}</td>
      <td>${e.sensor}</td>
      <td>${e.avg}°C</td>
      <td>${e.max}°C</td>
      <td>${e.min}°C</td>
    </tr>
  `).join("");
}

function initThermalMapping() {
  populateMapSensorSelect();
  mapState.dataStale = true;
  mapState.grid = Array(64).fill(0);
  if ($mapSensorLabel) $mapSensorLabel.textContent = "No data – select a sensor";
  renderThermalGrid();
  if (mapState.interval) clearInterval(mapState.interval);
  const mapPage = document.getElementById("thermalMappingPage");
  if (mapPage && mapPage.classList.contains("active")) {
    if (mapState.sensorId && sensorsData[mapState.sensorId]) {
      loadSensorToMap(mapState.sensorId);
      if (!mapState.dataStale) recordMapSnapshot();
    }
  }
}

document.getElementById("refreshMapBtn")?.addEventListener("click", () => {
  const sel = document.getElementById("mapSensorSelect");
  if (sel && sel.value) mapState.sensorId = sel.value;
  if (mapState.sensorId && sensorsData[mapState.sensorId]) {
    loadSensorToMap(mapState.sensorId);
    if (!mapState.dataStale) recordMapSnapshot();
  } else {
    if ($mapSensorLabel) $mapSensorLabel.textContent = "No sensor selected";
    mapState.dataStale = true;
    renderThermalGrid();
  }
});

$mapSensorSelect?.addEventListener("change", (e) => {
  mapState.sensorId = e.target.value;
  if (mapState.sensorId && sensorsData[mapState.sensorId]) {
    loadSensorToMap(mapState.sensorId);
    recordMapSnapshot();
  }
});

document.getElementById("clearMapLogBtn")?.addEventListener("click", () => {
  if (confirm("Clear mapping history?")) {
    mapState.history = [];
    renderMapLog();
  }
});

window.mapState = mapState;
window.loadSensorToMap = loadSensorToMap;
window.renderThermalGrid = renderThermalGrid;
window.recordMapSnapshot = recordMapSnapshot;

// ═══════════════════════════════════════════════════════════════
// ESP32 WEBSOCKET
// ═══════════════════════════════════════════════════════════════
function setDeviceBadge(index, text, cls) {
  const badge = $deviceBadges[index];
  if (!badge) return;
  badge.innerText = text;
  badge.className = cls;
}

let lastDataReceivedTime = Date.now();
let watchdogInterval = null;

function zeroOutSensorReadings() {
  Object.keys(sensorsData).forEach(key => {
    const sd = sensorsData[key];
    if (sd.currentTemp !== null) {
      sd.currentTemp = null;
      sd.status = "NORMAL";
      sd.dataLog = [];
      sd.acknowledged = false;
    }
  });
  refreshHeroDisplay();
}

function startDataWatchdog() {
  if (watchdogInterval) clearInterval(watchdogInterval);
  lastDataReceivedTime = Date.now();
  watchdogInterval = setInterval(() => {
    if (Date.now() - lastDataReceivedTime > 3000) {
      zeroOutSensorReadings();
      esp32Sockets.forEach((socket, index) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.close();
        }
      });
    }
  }, 500);
}

function connectToEsp32(index) {
  if (!isAuthenticated || !monitoringEnabled) {
    setDeviceBadge(index, "Not Connected", "badge offline");
    return;
  }
  const host = ($esp32HostInputs[index].value || "").trim();
  if (!host) {
    esp32Connections[index] = false;
    setDeviceBadge(index, "Not Connected", "badge offline");
    if (esp32Sockets[index]) { try { esp32Sockets[index].close(); } catch (e) {} esp32Sockets[index] = null; }
    return;
  }
  const wsUrl = host.startsWith("ws://") || host.startsWith("wss://") ? host : `ws://${host}:81`;
  if (esp32Sockets[index] && (esp32Sockets[index].readyState === WebSocket.OPEN || esp32Sockets[index].readyState === WebSocket.CONNECTING)) return;

  esp32Connections[index] = false;
  setDeviceBadge(index, "Connecting...", "badge offline");

  try {
    const socket = new WebSocket(wsUrl);
    esp32Sockets[index] = socket;

    socket.addEventListener("open", () => {
      esp32Connections[index] = true;
      setDeviceBadge(index, "ESP32 Connected", "badge online");

      const currentLimit = parseFloat($limitInput.value);
      if (!isNaN(currentLimit)) {
        socket.send(JSON.stringify({ type: "connected", safeLimit: toCelsius(currentLimit) }));
        socket.send(JSON.stringify({ type: "requestTelemetry" }));
      }
      sendUnitToEsp32(isCelsius ? "C" : "F");
      Object.values(sensorsData).forEach(sd => {
        socket.send(JSON.stringify({ type: "updateSensorName", sensorId: sd.sensorId, sensorName: sd.sensorName }));
      });
    });

    socket.addEventListener("message", (event) => {
      lastDataReceivedTime = Date.now();
      try {
        const payload = JSON.parse(event.data);

        if (payload.thermalGrid && Array.isArray(payload.thermalGrid) && payload.thermalGrid.length === 64) {
          const gridData = payload.thermalGrid.map(v => parseFloat(v)).filter(v => !isNaN(v));
          if (gridData.length === 64 && payload.sensorId) {
            const mapKey = `${payload.roomId || activeRoomId}_${payload.sensorId}`;
            if (window.mapState.sensorId === mapKey) {
              window.mapState.grid = gridData;
              if (typeof window.renderThermalGrid === "function") window.renderThermalGrid();
              if (!window.mapState.dataStale && typeof window.recordMapSnapshot === "function") window.recordMapSnapshot();
            }
          }
        }

        if (payload.safeLimit !== undefined) {
          const syncedLimit = parseFloat(payload.safeLimit);
          if (!isNaN(syncedLimit)) {
            const activeSensor = getActiveSensorData();
            if (activeSensor) activeSensor.safeLimit = syncedLimit;
            $limitInput.value = fromCelsius(syncedLimit).toFixed(1);
          }
        }

        if (payload.temperature !== undefined) {
          let numericTemp = parseFloat(payload.temperature);
          if (!isNaN(numericTemp)) {
            if (!isCelsius) numericTemp = ((numericTemp - 32) * 5) / 9;
            const rId = payload.roomId || activeRoomId;
            const sId = payload.sensorId || activeSensorId;
            evaluateMetrics(rId, sId, numericTemp);
          }
        }
      } catch (e) {
        console.error("Invalid ESP32 payload:", e);
      }
    });

    socket.addEventListener("close", () => {
      esp32Connections[index] = false;
      setDeviceBadge(index, "ESP32 Offline", "badge offline");
      if (esp32Sockets[index] === socket) esp32Sockets[index] = null;
      zeroOutSensorReadings();
      setTimeout(() => { if (monitoringEnabled) connectToEsp32(index); }, 2000);
    });

    socket.addEventListener("error", () => {
      esp32Connections[index] = false;
      setDeviceBadge(index, "ESP32 Error", "badge offline");
    });
  } catch (e) {
    console.error("ESP32 connection error:", e);
    setDeviceBadge(index, "ESP32 Error", "badge offline");
    zeroOutSensorReadings();
  }
}

$esp32HostInputs.forEach((input, index) => {
  input?.addEventListener("change", () => {
    localStorage.setItem(`esp32Host${index + 1}`, input.value.trim());
    const hostDisplay = document.getElementById("hostDisplay");
    if (hostDisplay) hostDisplay.textContent = input.value.trim() || "—";
    connectToEsp32(index);
  });
});

$esp32HostInputs.forEach((input, index) => {
  if (!input) return;
  const savedHost = localStorage.getItem(`esp32Host${index + 1}`) || "";
  if (savedHost) {
    input.value = savedHost;
    connectToEsp32(index);
  } else {
    setDeviceBadge(index, "Not Connected", "badge offline");
  }
});

// ═══════════════════════════════════════════════════════════════
// PRINT MODES
// ═══════════════════════════════════════════════════════════════
document.getElementById("printLogBtn")?.addEventListener("click", () => {
  document.body.classList.add("print-log-mode");
  window.print();
  document.body.classList.remove("print-log-mode");
});
document.getElementById("printMapBtn")?.addEventListener("click", () => {
  document.body.classList.add("print-map-mode");
  window.print();
  document.body.classList.remove("print-map-mode");
});

// ═══════════════════════════════════════════════════════════════
// LOADING + STARTUP SOUND
// ═══════════════════════════════════════════════════════════════
setTimeout(() => {
  const ls = document.getElementById("loading-screen");
  if (ls) ls.classList.add("fade-out");
}, 6000);

function playStartupSound() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const now = audioCtx.currentTime;
  function playTone(freq, start, dur, type = "sine", gain = 0.15) {
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now + start);
    g.gain.setValueAtTime(0, now + start);
    g.gain.linearRampToValueAtTime(gain, now + start + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, now + start + dur);
    osc.connect(g);
    g.connect(audioCtx.destination);
    osc.start(now + start);
    osc.stop(now + start + dur);
  }
  playTone(130.81, 0, 1.2, "sine", 0.1);
  playTone(523.25, 0.1, 0.6, "sine", 0.18);
  playTone(659.25, 0.25, 0.6, "sine", 0.18);
  playTone(783.99, 0.4, 0.7, "sine", 0.2);
  playTone(1046.5, 0.55, 0.9, "sine", 0.22);
}

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════
const $passwordToggleBtn = document.getElementById("passwordToggleBtn");
const $forgotPasswordBtn = document.getElementById("forgotPasswordBtn");

$passwordToggleBtn?.addEventListener("click", () => {
  const isPassword = $authPassword.type === "password";
  $authPassword.type = isPassword ? "text" : "password";
  $passwordToggleBtn.innerText = isPassword ? "Hide" : "Show";
});

function showDashboard() {
  isAuthenticated = true;
  monitoringEnabled = true;
  renderTableLog();
  refreshHeroDisplay();
  updateLimitInputForActiveSensor();
  populateActiveSensorSelect();
  playStartupSound();
  $authScreen.classList.add("hidden");
  $dashboardContainer.classList.add("visible");
  const hostDisplay = document.getElementById("hostDisplay");
  if (hostDisplay) hostDisplay.textContent = localStorage.getItem("esp32Host1") || "—";
  $esp32HostInputs.forEach((input, index) => {
    const savedHost = localStorage.getItem(`esp32Host${index + 1}`) || "";
    if (savedHost) { input.value = savedHost; connectToEsp32(index); }
  });
  startDataWatchdog();
  updateStatusChip();
}

function showAuthScreen() {
  isAuthenticated = false;
  monitoringEnabled = false;
  if (typeof window.stopEsp32Simulation === "function") window.stopEsp32Simulation();
  $authScreen.classList.remove("hidden");
  $dashboardContainer.classList.remove("visible");
  stopSiren();
}

window.showDashboard = showDashboard;
window.showAuthScreen = showAuthScreen;
window.setUserBadge = function (email) {
  const badge = document.getElementById("userBadge");
  if (badge) { badge.innerText = email || "Authenticated"; badge.className = "badge connected"; }
};

// ═══════════════════════════════════════════════════════════════
// INITIAL RENDER
// ═══════════════════════════════════════════════════════════════
populateActiveSensorSelect();
refreshHeroDisplay();
renderTableLog();
updateLimitInputForActiveSensor();
setInterval(renderInlineStats, 1000);

// Safety stub — firebase.js may still push simulation readings; ignore them.
window.receiveSimulationReading = function() {};