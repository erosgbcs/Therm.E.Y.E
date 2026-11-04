      // ─────────────────────────────────────
      // GLOBAL STATE
      // ─────────────────────────────────────
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

      // Per-sensor data: key = "roomId_sensorId"
      const sensorsData = {};
      const globalEventHistory = []; // unified log
      const lastDbWriteTime = new Map();
      let activeRoomId = DEFAULT_ROOMS[0].id;
      let activeSensorId = DEFAULT_ROOMS[0].sensors[0].id;
      let isCelsius = true;
      let esp32Sockets = [];
      let simulationMode = false;
      let randomSimulationInterval = null;
      const simulationClientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      function playSystemBeep() {
        if (!audioCtx) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        oscillator.type = "triangle";
        oscillator.frequency.setValueAtTime(800, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(1, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(
          0.001,
          audioCtx.currentTime + 0.5,
        );

        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.5);
      }
      let esp32Connections = [false];
      let monitoringEnabled = false;
      const lastPublishedTelemetry = new Map();
      window.ignoreInitialFirebaseTemp = true; // skip first FB snapshot

      // ─────────────────────────────────────
      // INIT SENSOR DATA STRUCTURES
      // ─────────────────────────────────────
      // Creates the per-appliance state object for every default sensor so the dashboard
      // can keep track of temperature history, safe threshold, and status for each device.
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
                status: "NORMAL", // NORMAL | HIGH_HEAT | CRITICAL
              };
            }
          });
        });
      }
      initSensorsData();

      // Returns the active appliance's current state object for the selected room/sensor pair.
      function getActiveSensorData() {
        const key = `${activeRoomId}_${activeSensorId}`;
        return sensorsData[key] || null;
      }

      // Builds the lookup key used to retrieve the active sensor's state from sensorsData.
      function getActiveKey() {
        return `${activeRoomId}_${activeSensorId}`;
      }

      // ─────────────────────────────────────
      // DOM REFS
      // ─────────────────────────────────────
      const $currentTemp = document.getElementById("currentTemp");
      const $highTemp = document.getElementById("highTemp");
      const $lowTemp = document.getElementById("lowTemp");
      const $avgTemp = document.getElementById("avgTemp");
      const $alertBanner = document.getElementById("alertBanner");
      const $tempStatusText = document.getElementById("tempStatusText");
      const $thermalStateBadge = document.getElementById("thermalStateBadge");
      const $heroSensorLabel = document.getElementById("heroSensorLabel");
      const $deviceBadge = document.getElementById("deviceBadge");
      const $dbBadge = document.getElementById("dbBadge");
      const $userBadge = document.getElementById("userBadge");
      const $limitInput = document.getElementById("limitInput");
      const $limitLabel = document.getElementById("limitLabel");
      const $telemetryLogBody = document.getElementById("telemetryLogBody");
      const $esp32HostInputs = [document.getElementById("esp32HostInput1")];
      const $deviceBadges = [document.getElementById("deviceBadge1")];
      const $sensorCardsGrid = document.getElementById("sensorCardsGrid");
      const $authScreen = document.getElementById("auth-screen");
      const $dashboardContainer = document.getElementById(
        "dashboard-container",
      );
      const $authError = document.getElementById("authError");
      const $authSuccess = document.getElementById("authSuccess");
      const $authSubmitBtn = document.getElementById("authSubmitBtn");
      const $authEmail = document.getElementById("authEmail");
      const $authPassword = document.getElementById("authPassword");
      const $tabSignIn = document.getElementById("tabSignIn");

      window.authMode = "signin";

      // ─────────────────────────────────────
      // DATE / TIME
      // ─────────────────────────────────────
      // Keeps the header clock synchronized with the user's local system time.
      function updateDateTime() {
        const now = new Date();
        const dateOpts = {
          weekday: "short",
          year: "numeric",
          month: "short",
          day: "numeric",
        };
        const timeOpts = {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        };
        document.getElementById("currentDate").innerText =
          now.toLocaleDateString(undefined, dateOpts);
        document.getElementById("currentTime").innerText =
          now.toLocaleTimeString(undefined, timeOpts);
      }
      setInterval(updateDateTime, 1000);
      updateDateTime();

      // ─────────────────────────────────────
      // TEMP FORMATTING
      // ─────────────────────────────────────
      // Converts the stored Celsius temperature into the currently selected display unit.
      function formatTemp(tempInC) {
        if (tempInC === null || tempInC === undefined || isNaN(tempInC))
          return "--.-°C";
        if (isCelsius) return `${tempInC.toFixed(1)}°C`;
        const tempInF = (tempInC * 9) / 5 + 32;
        return `${tempInF.toFixed(1)}°F`;
      }

      // Converts a displayed Fahrenheit value back into Celsius for internal threshold logic.
      function toCelsius(val) {
        if (isCelsius) return val;
        return ((val - 32) * 5) / 9;
      }

      // Converts an internal Celsius value into the current UI unit for the limit input.
      function fromCelsius(val) {
        if (isCelsius) return val;
        return (val * 9) / 5 + 32;
      }
      function formatLogTime(timestamp) {
        const date = new Date(timestamp);
        // Ensures 12-hour format with AM/PM matching your UI design
        return date.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        });
      }
      // ─────────────────────────────────────
      // AUDIO ALARM (Pure JS Web Audio API)
      // ─────────────────────────────────────
      let audioCtx;
      let alarmInterval = null;
      let isAuthenticated = false;
      // Resume audio context on first user interaction
      document.addEventListener(
        "click",
        () => {
          if (audioCtx && audioCtx.state === "suspended") {
            audioCtx.resume();
          }
        },
        { once: false },
      );
      function playSystemBeep() {
        if (!audioCtx) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        oscillator.type = "triangle";
        oscillator.frequency.setValueAtTime(800, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(1, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(
          0.001,
          audioCtx.currentTime + 0.5,
        );

        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.5);
      }

      function startSiren() {
        if (!isAuthenticated) return;
        if (!alarmInterval) {
          playSystemBeep();
          alarmInterval = setInterval(playSystemBeep, 1000);
        }
      }

      function stopSiren() {
        if (alarmInterval) {
          clearInterval(alarmInterval);
          alarmInterval = null;
        }
      }

      // ─────────────────────────────────────
      // RENDER SENSOR CARDS
      // ─────────────────────────────────────
      function renderSensorCards() {
        const room = DEFAULT_ROOMS.find((r) => r.id === activeRoomId);
        if (!room) {
          $sensorCardsGrid.innerHTML = "";
          return;
        }

        $sensorCardsGrid.innerHTML = room.sensors
          .map((sensor) => {
            const key = `${room.id}_${sensor.id}`;
            const sd = sensorsData[key];
            const temp = sd ? sd.currentTemp : null;
            const status = sd ? sd.status : "NORMAL";
            const isSelected = sensor.id === activeSensorId;
            let statusClass = "mini-status-normal";
            if (status === "CRITICAL") {
              statusClass = "mini-status-danger";
            } else if (status === "HIGH_HEAT") {
              statusClass = "mini-status-warning";
            }

            const alarmClass = status === "CRITICAL" ? " alarm" : "";

            return `
    <div class="sensor-mini-card${isSelected ? " selected" : ""}${alarmClass}"
        data-sensor="${sensor.id}" data-room="${room.id}">
      
      <div class="sensor-mini-name">
        ${sensor.name}
        <button class="edit-sensor-btn"
                data-room="${room.id}"
                data-sensor="${sensor.id}"
                title="Edit sensor name">
          <svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m4 16-.8 4.8L8 20l11-11a2.8 2.8 0 0 0-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/></svg> Edit Name
        </button>
      </div>

      <div class="sensor-mini-temp"
          style="color:${
            status === "CRITICAL"
              ? "var(--danger)"
              : status === "HIGH_HEAT"
                ? "var(--warning)"
                : "var(--success)"
          }">
        ${formatTemp(temp)}
      </div>

      <span class="sensor-mini-status ${statusClass}">
        ${status.replace("_", " ")}
      </span>

    </div>
  `;
          })
          .join("");

        // Click handlers for sensor selection (already present)
        $sensorCardsGrid
          .querySelectorAll(".sensor-mini-card")
          .forEach((card) => {
            card.addEventListener("click", (e) => {
              // Ignore clicks on the edit button
              if (e.target.classList.contains("edit-sensor-btn")) return;
              const sensorId = card.getAttribute("data-sensor");
              const roomId = card.getAttribute("data-room");
              activeRoomId = roomId;
              activeSensorId = sensorId;
              renderSensorCards();
              refreshHeroDisplay();
              updateLimitInputForActiveSensor();
            });
          });

        // NEW: Edit button event listeners
        $sensorCardsGrid.querySelectorAll(".edit-sensor-btn").forEach((btn) => {
          btn.addEventListener("click", (e) => {
            e.stopPropagation(); // Prevent card selection
            const roomId = btn.getAttribute("data-room");
            const sensorId = btn.getAttribute("data-sensor");
            editSensorName(roomId, sensorId);
          });
        });
      }
      function editSensorName(roomId, sensorId) {
        const key = `${roomId}_${sensorId}`;
        const sd = sensorsData[key];
        if (!sd) {
          alert("Sensor not found!");
          return;
        }
        const newName = prompt(
          "Enter new name for this sensor:",
          sd.sensorName,
        );
        if (newName && newName.trim() !== "") {
          const trimmed = newName.trim();

          // Update local data
          sd.sensorName = trimmed;

          // Also update the sensor object in DEFAULT_ROOMS (for future renders)
          const room = DEFAULT_ROOMS.find((r) => r.id === roomId);
          if (room) {
            const sensor = room.sensors.find((s) => s.id === sensorId);
            if (sensor) sensor.name = trimmed;
          }

          // Persist to Firebase
          if (typeof window.publishSensorNameToDatabase === "function") {
            window.publishSensorNameToDatabase(roomId, sensorId, trimmed);
          }

          // ---------------------------------------------------------
          // --- NEW: Sync updated sensor name to ESP32 (for OLED) ---
          // ---------------------------------------------------------
          if (
            typeof esp32Sockets !== "undefined" &&
            Array.isArray(esp32Sockets)
          ) {
            esp32Sockets.forEach((socket) => {
              if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(
                  JSON.stringify({
                    type: "updateSensorName",
                    sensorId: sensorId,
                    sensorName: trimmed,
                  }),
                );
              }
            });
          }
          // ---------------------------------------------------------

          // Re-render UI
          renderSensorCards();
          refreshHeroDisplay();

          // Update thermal map dropdown if it's open
          const mapPage = document.getElementById("thermalMappingPage");
          if (mapPage && mapPage.style.display !== "none") {
            populateMapSensorSelect();
            if (mapState.sensorId && sensorsData[mapState.sensorId]) {
              loadSensorToMap(mapState.sensorId);
            }
          }
        }
      }
      // Keeps the safe-limit input synchronized with the currently selected appliance's threshold.
      function updateLimitInputForActiveSensor() {
        const sd = getActiveSensorData();
        if (sd) {
          $limitInput.value = fromCelsius(sd.safeLimit).toFixed(1);
        }
      }

      // ─────────────────────────────────────
      // REFRESH HERO + STATS
      // ─────────────────────────────────────
      // Updates the primary live readout, status badge, alert banner, and summary metrics for the active sensor.
      function refreshHeroDisplay() {
        const sd = getActiveSensorData();
        if (!sd || sd.currentTemp === null) {
          $currentTemp.innerText = "--.-°C";
          $currentTemp.className = "temp-display";
          $highTemp.innerText = "--.-°C";
          $lowTemp.innerText = "--.-°C";
          $avgTemp.innerText = "--.-°C";
          $thermalStateBadge.className = "state-badge normal";
          $thermalStateBadge.innerText = "NORMAL";
          $tempStatusText.innerText = "Waiting for data...";
          $tempStatusText.className = "text-muted";
          $heroSensorLabel.innerText = sd
            ? `${sd.roomName} › ${sd.sensorName}`
            : "--";
          $alertBanner.style.display = "none";
          stopSiren();
          return;
        }

        const dataLog = sd.dataLog;
        const highest = dataLog.length ? Math.max(...dataLog) : sd.currentTemp;
        const lowest = dataLog.length ? Math.min(...dataLog) : sd.currentTemp;
        const average = dataLog.length
          ? dataLog.reduce((a, b) => a + b, 0) / dataLog.length
          : sd.currentTemp;

        $currentTemp.innerText = formatTemp(sd.currentTemp);
        $highTemp.innerText = formatTemp(highest);
        $lowTemp.innerText = formatTemp(lowest);
        $avgTemp.innerText = formatTemp(average);
        $heroSensorLabel.innerText = `${sd.roomName} › ${sd.sensorName}`;

        $currentTemp.className = "temp-display";
        $tempStatusText.className = "text-muted";
        $thermalStateBadge.className = "state-badge";
        $alertBanner.style.display = "none";
        stopSiren();

        if (sd.status === "CRITICAL") {
          $currentTemp.classList.add("status-danger");
          $alertBanner.style.display = "block";
          $alertBanner.innerHTML = `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/></svg> Warning: <strong>${sd.roomName} › ${sd.sensorName}</strong> has breached the safe limit (${formatTemp(sd.safeLimit)})!`;
          $tempStatusText.innerText = "Appliance Temperature Critical";
          $tempStatusText.classList.add("status-danger");
          $thermalStateBadge.innerText = "CRITICAL BREACH";
          $thermalStateBadge.classList.add("critical");
          startSiren();
        } else if (sd.status === "HIGH_HEAT") {
          $currentTemp.classList.add("status-warning");
          $tempStatusText.innerText = "Approaching Limit Alert";
          $tempStatusText.classList.add("status-warning");
          $thermalStateBadge.innerText = "HIGH HEAT";
          $thermalStateBadge.classList.add("high-heat");
          stopSiren();
        } else {
          $currentTemp.classList.add("status-safe");
          $tempStatusText.innerText = "Appliance Operational — Stable";
          $tempStatusText.classList.add("status-safe");
          $thermalStateBadge.innerText = "NORMAL";
          $thermalStateBadge.classList.add("normal");
          stopSiren();
        }

        // Update sensor mini-cards
        renderSensorCards();
        renderTableLog();
      }
      // Animate progress counter from 0 to 100 over 3 seconds
      const counter = document.getElementById("progressCounter");
      if (counter) {
        let startTime = Date.now();
        const duration = 6000; // same as progress bar fill
        function updateCounter() {
          const elapsed = Date.now() - startTime;
          const progress = Math.min(
            100,
            Math.floor((elapsed / duration) * 100),
          );
          counter.textContent = progress + "%";
          if (progress < 100) {
            requestAnimationFrame(updateCounter);
          }
        }
        requestAnimationFrame(updateCounter);
      }
      // ─────────────────────────────────────
      // EVALUATE METRICS (called on new temp)
      // ─────────────────────────────────────
      function evaluateMetrics(
        roomId,
        sensorId,
        newTemp,
        {
          publishTelemetry = true,
          publishHistory = true,
          refreshDashboard = true,
          recordHistory = true,
        } = {},
      ) {
        if (!isAuthenticated || !monitoringEnabled) return;

        const key = `${roomId}_${sensorId}`;
        let sd = sensorsData[key];

        if (!sd) {
          const room = DEFAULT_ROOMS.find((r) => r.id === roomId) || {
            id: roomId,
            name: roomId,
            sensors: [],
          };
          sensorsData[key] = {
            roomId,
            roomName: room.name,
            sensorId,
            sensorName: sensorId,
            dataLog: [],
            safeLimit: 50.0,
            currentTemp: null,
            status: "NORMAL",
            lastEventTime: 0, // keep track of last event to throttle
          };
          sd = sensorsData[key];
        }

        sd.dataLog.push(newTemp);
        sd.currentTemp = newTemp;

        // Determine status
        if (newTemp >= sd.safeLimit) {
          sd.status = "CRITICAL";
        } else if (newTemp >= sd.safeLimit - 2.0) {
          sd.status = "HIGH_HEAT";
        } else {
          sd.status = "NORMAL";
        }

        // ---- ALWAYS LOG AN EVENT (throttled) ----
        const now = Date.now();
        if (recordHistory && (!sd.lastEventTime || now - sd.lastEventTime > 2000)) {
          // throttle events to max 1 every 2s
          sd.lastEventTime = now;

          const timeStr = new Date(now).toLocaleTimeString("en-US", {
            hour12: true,
          });
          const eventEntry = {
            timestamp: now,
            time: timeStr,
            roomId: sd.roomId,
            roomName: sd.roomName,
            sensorId: sd.sensorId,
            sensorName: sd.sensorName,
            event:
              sd.status === "CRITICAL"
                ? "ALARM"
                : sd.status === "HIGH_HEAT"
                  ? "WARNING"
                  : "READING",
            temp: newTemp,
            status:
              sd.status === "CRITICAL"
                ? "ALARM DETECTED"
                : sd.status === "HIGH_HEAT"
                  ? "HIGH HEAT"
                  : "NORMAL",
            isAlarm: sd.status === "CRITICAL",
          };

          globalEventHistory.unshift(eventEntry);
          if (globalEventHistory.length > 500) globalEventHistory.length = 500;

          // Update the table (now using the clean version below)
          if (typeof appendLogEntryToTable === "function") {
            appendLogEntryToTable(eventEntry);
          }

          if (
            publishHistory &&
            typeof window.publishEventHistoryToDatabase === "function"
          ) {
            window.publishEventHistoryToDatabase(eventEntry);
          }
        }

        // ---- Throttled temperature write to Firebase (unchanged) ----
        const lastWrite = lastDbWriteTime.get(key) || 0;
        if (publishTelemetry && now - lastWrite > 2000) {
          lastDbWriteTime.set(key, now);
          if (typeof window.publishTemperatureToDatabase === "function") {
            window.publishTemperatureToDatabase(roomId, sensorId, newTemp);
          }
        }

        // ---- Refresh UI ----
        if (roomId === activeRoomId && sensorId === activeSensorId && refreshDashboard) {
          refreshHeroDisplay();
        } else if (roomId !== activeRoomId || sensorId !== activeSensorId) {
          if (typeof updateSensorCardUI === "function") {
            updateSensorCardUI(roomId, sensorId, newTemp, sd.status);
          }
        }
        // ---- Auto‑update thermal map if it's currently visible ----
        const mapPage = document.getElementById("thermalMappingPage");
        const sensorKey = `${roomId}_${sensorId}`;
        if (
          mapPage &&
          mapPage.style.display !== "none" &&
          mapState.sensorId === sensorKey
        ) {
          loadSensorToMap(sensorKey);
          if (!mapState.dataStale) {
            recordMapSnapshot();
          }
        }
      }

      function appendLogEntryToTable(item) {
        if (!$telemetryLogBody) return;

        const row = document.createElement("tr");
        if (item.isAlarm || item.status === "ALARM DETECTED") {
          row.className = "row-alarm";
        }

        row.innerHTML = `
          <td>${formatHistoryTime(item)}</td>
          <td>${item.roomName || "--"}</td>
          <td>${item.sensorName || "--"}</td>
          <td><strong>${item.event || "STATUS_CHANGE"}</strong></td>
          <td>${formatTemp(item.temp)}</td>
          <td>${item.status}</td>
      `;

        $telemetryLogBody.prepend(row);

        while ($telemetryLogBody.children.length > 100) {
          $telemetryLogBody.removeChild($telemetryLogBody.lastElementChild);
        }
      }

      function formatHistoryTime(entry) {
        if (entry && entry.timestamp) {
          return new Date(entry.timestamp).toLocaleTimeString(undefined, {
            hour12: true,
          });
        }
        return entry && entry.time ? entry.time : "--:--:--";
      }
      function renderTableLog() {
        if (!$telemetryLogBody) return;

        if (!globalEventHistory || globalEventHistory.length === 0) {
          $telemetryLogBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#888;">No history events recorded yet.</td></tr>`;
          return;
        }

        $telemetryLogBody.innerHTML = globalEventHistory
          .slice(0, 100)
          .map((item) => {
            const isAlarmClass =
              item.isAlarm || item.status === "ALARM DETECTED"
                ? ' class="row-alarm"'
                : "";
            return `<tr${isAlarmClass}>
              <td>${formatHistoryTime(item)}</td>
              <td>${item.roomName || "--"}</td>
              <td>${item.sensorName || "--"}</td>
              <td><strong>${item.event || "STATUS_CHANGE"}</strong></td>
              <td>${formatTemp(item.temp)}</td>
              <td>${item.status}</td>
          </tr>`;
          })
          .join("");
      }

      document.getElementById("exportCsvBtn").addEventListener("click", () => {
        const entries = globalEventHistory.slice(0, 200);
        let csv = "Time,Room,Sensor,Event,Temperature,Status\n";
        entries.forEach((item) => {
          const tempVal = isCelsius
            ? item.temp.toFixed(1)
            : ((item.temp * 9) / 5 + 32).toFixed(1);
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

      document.getElementById("clearLogBtn").addEventListener("click", () => {
        if (
          confirm(
            "Clear all local event log entries? (Firebase data remains intact)",
          )
        ) {
          globalEventHistory.length = 0;
          renderTableLog();
        }
      });

      // ─────────────────────────────────────
      // SAFE LIMIT INPUT
      // ─────────────────────────────────────
      $limitInput.addEventListener("input", () => {
        const val = parseFloat($limitInput.value);
        if (!isNaN(val)) {
          const celsiusVal = toCelsius(val);
          const sd = getActiveSensorData();
          if (sd) {
            sd.safeLimit = celsiusVal;

            // --- ADD THIS CODE BELOW TO TRANSMIT THRESHOLD TO ESP32 ---
            esp32Sockets.forEach((socket) => {
              if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ safeLimit: celsiusVal }));
              }
            });
            // ---------------------------------------------------------

            if (sd.currentTemp !== null) {
              if (sd.currentTemp >= sd.safeLimit) sd.status = "CRITICAL";
              else if (sd.currentTemp >= sd.safeLimit - 2.0)
                sd.status = "HIGH_HEAT";
              else sd.status = "NORMAL";
              refreshHeroDisplay();
            }
          }
        }
      });

      // ─────────────────────────────────────
      // UNIT TOGGLE
      // ─────────────────────────────────────
      document.getElementById("unitToggle").addEventListener("click", () => {
        isCelsius = !isCelsius;
        document.getElementById("unitText").innerText = isCelsius
          ? "Celsius (°C)"
          : "Fahrenheit (°F)";
        $limitLabel.innerText = isCelsius
          ? "Safe Limit (°C)"
          : "Safe Limit (°F)";
        updateLimitInputForActiveSensor();
        refreshHeroDisplay();
        renderTableLog();
        renderSensorCards();

        // --- ADDED: Send the selected unit to the ESP32 ---
        sendUnitToEsp32(isCelsius ? "C" : "F");
      });

      // ─────────────────────────────────────
      // THEME TOGGLE
      // ─────────────────────────────────────
      // Switches the page between light and dark color themes and saves the user choice.
      function setTheme(theme) {
        if (theme === "light") {
          document.documentElement.setAttribute("data-theme", "light");
          document.getElementById("themeIcon").innerHTML = `<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>`;
          document.getElementById("themeText").innerText = "Dark Mode";
          localStorage.setItem("theme", "light");
        } else {
          document.documentElement.removeAttribute("data-theme");
          document.getElementById("themeIcon").innerHTML = `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>`;
          document.getElementById("themeText").innerText = "Light Mode";
          localStorage.setItem("theme", "dark");
        }
      }
      document.getElementById("themeToggle").addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme");
        setTheme(current === "light" ? "dark" : "light");
      });
      const savedTheme = localStorage.getItem("theme");
      if (savedTheme === "light") setTheme("light");
      else setTheme("dark");

      // ─────────────────────────────────────
      // ─────────────────────────────────────
      // Helper to send temperature unit selection to the ESP32
      // ─────────────────────────────────────
      function sendUnitToEsp32(unitType) {
        // unitType = 'C' or 'F'
        if (
          typeof esp32Sockets !== "undefined" &&
          Array.isArray(esp32Sockets)
        ) {
          esp32Sockets.forEach((socket) => {
            if (socket && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ unit: unitType }));
            }
          });
        }
      }
      // ===== THERMAL MAPPING ENGINE – REAL ESP32 DATA ONLY =====
      const mapState = {
        grid: Array(64).fill(0),
        sensorId: null,
        history: [],
        interval: null,
        isActive: false,
        dataStale: false,
      };

      // --- DOM refs ---
      const $mapGrid = document.getElementById("thermalGridContainer");
      const $mapSensorLabel = document.getElementById("mapSensorLabel");
      const $mapAvgTemp = document.getElementById("mapAvgTemp");
      const $mapMaxTemp = document.getElementById("mapMaxTemp");
      const $mapMinTemp = document.getElementById("mapMinTemp");
      const $mapLogBody = document.getElementById("mapLogBody");
      const $mapSensorSelect = document.getElementById("mapSensorSelect");

      // --- Heat color mapping ---
      function getHeatColor(temp) {
        const min = 20,
          max = 60;
        const clamped = Math.max(min, Math.min(max, temp));
        const ratio = (clamped - min) / (max - min);
        const r = Math.min(255, Math.round(ratio * 255));
        const g = Math.min(
          255,
          Math.round((1 - Math.abs(ratio - 0.5) * 2) * 255),
        );
        const b = Math.min(255, Math.round((1 - ratio) * 255));
        return `rgb(${r},${g},${b})`;
      }

      // --- Render the 8x8 grid ---
      function renderThermalGrid() {
        if (!$mapGrid) return;
        const hasData = mapState.grid.some((v) => v > 0.1 && !isNaN(v));
        if (!hasData || mapState.dataStale) {
          $mapGrid.innerHTML = Array(64)
            .fill(0)
            .map(
              () =>
                `<div style="background:#444; aspect-ratio:1/1; border-radius:4px; display:flex; align-items:center; justify-content:center; color:#888; font-size:0.6rem;">N/A</div>`,
            )
            .join("");
          $mapAvgTemp.textContent = "--";
          $mapMaxTemp.textContent = "--";
          $mapMinTemp.textContent = "--";
          return;
        }
        $mapGrid.innerHTML = mapState.grid
          .map((temp, i) => {
            const color = getHeatColor(temp);
            return `<div style="background:${color}; aspect-ratio:1/1; border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:0.7rem; font-weight:700; color:#fff; text-shadow:0 0 4px rgba(0,0,0,0.7);">${isCelsius ? temp.toFixed(1) + "°" : ((temp * 9) / 5 + 32).toFixed(1) + "°"}</div>`;
          })
          .join("");
        updateMapStats();
      }

      // --- Update map statistics ---
      function updateMapStats() {
        if (!mapState.grid || mapState.grid.length === 0) return;

        // Filter out invalid/empty values if needed
        const validValues = mapState.grid.filter((v) => !isNaN(v));
        if (validValues.length === 0) return;

        const avg = validValues.reduce((a, b) => a + b, 0) / validValues.length;
        const max = Math.max(...validValues);
        const min = Math.min(...validValues);

        // Apply unit formatting check (assuming 'isCelsius' is your global state toggle)
        const formatValue = (val) => {
          const converted = isCelsius ? val : (val * 9) / 5 + 32;
          return `${converted.toFixed(1)}°${isCelsius ? "C" : "F"}`;
        };

        // Update DOM elements
        document.getElementById("mapAvgTemp").textContent = formatValue(avg);
        document.getElementById("mapMaxTemp").textContent = formatValue(max);
        document.getElementById("mapMinTemp").textContent = formatValue(min);
      }

      // --- Populate sensor dropdown ---
      function populateMapSensorSelect() {
        if (!$mapSensorSelect) return;
        const keys = Object.keys(sensorsData);
        if (!keys.length) {
          $mapSensorSelect.innerHTML = "<option>No sensors available</option>";
          return;
        }
        $mapSensorSelect.innerHTML = keys
          .map((key) => {
            const sd = sensorsData[key];
            return `<option value="${key}">${sd.roomName} › ${sd.sensorName}</option>`;
          })
          .join("");
        if (!mapState.sensorId || !sensorsData[mapState.sensorId]) {
          mapState.sensorId = keys[0];
          $mapSensorSelect.value = mapState.sensorId;
        } else {
          $mapSensorSelect.value = mapState.sensorId;
        }
      }

      // --- Generate heat distribution around a base temperature (real data) ---
      function generateHeatDistribution(baseTemp) {
        const center = 3.5;
        mapState.grid = Array(64)
          .fill(0)
          .map((_, i) => {
            const row = Math.floor(i / 8);
            const col = i % 8;
            const centerDist = Math.sqrt(
              Math.pow(row - center, 2) + Math.pow(col - center, 2),
            );
            // Simple linear falloff – no random jitter
            let temp = baseTemp - centerDist * 1.5; // adjust the falloff rate to taste
            return Math.max(15, Math.min(70, temp));
          });
      }

      // --- Load real sensor data into the map (Generates/Updates Thermal Map) ---
      function loadSensorToMap(sensorKey) {
        const sd = sensorsData[sensorKey];

        // Check if sensor exists
        if (!sd) {
          mapState.dataStale = true;
          const mapSensorLabel = document.getElementById("mapSensorLabel");
          if (mapSensorLabel) mapSensorLabel.textContent = "Sensor not found";
          renderThermalGrid();
          return;
        }

        // Use the latest currentTemp (real ESP32 reading)
        let baseTemp = sd.currentTemp;

        // If currentTemp is null/undefined/zero, fallback to last history entry
        if (baseTemp === null || baseTemp === undefined || baseTemp <= 0.1) {
          const history = sd.dataLog;
          if (history && history.length > 0) {
            baseTemp = history[history.length - 1];
          }
        }

        // Check if we still have no valid temperature data
        if (baseTemp === null || baseTemp === undefined || baseTemp <= 0.1) {
          mapState.dataStale = true;
          const mapSensorLabel = document.getElementById("mapSensorLabel");
          if (mapSensorLabel)
            mapSensorLabel.textContent = `${sd.roomName} › ${sd.sensorName} — No Data`;
          renderThermalGrid();
          return;
        }

        // Valid data found: Generate map distribution and render
        mapState.dataStale = false;
        generateHeatDistribution(baseTemp);

        const mapSensorLabel = document.getElementById("mapSensorLabel");
        if (mapSensorLabel)
          mapSensorLabel.textContent = `${sd.roomName} › ${sd.sensorName} (${baseTemp.toFixed(1)}°C)`;

        renderThermalGrid();
      }

      // --- Fixed Refresh Map Event Listener ---
      document
        .getElementById("refreshMapBtn")
        ?.addEventListener("click", () => {
          // 1. Ensure we grab the currently selected sensor from the dropdown to avoid state mismatches
          const mapSensorSelect = document.getElementById("mapSensorSelect");
          if (mapSensorSelect && mapSensorSelect.value) {
            mapState.sensorId = mapSensorSelect.value;
          }

          // 2. Validate sensor and update map
          if (mapState.sensorId && sensorsData[mapState.sensorId]) {
            loadSensorToMap(mapState.sensorId);

            // 3. FIX: Only record a snapshot to the log if the data successfully loaded and is not stale
            if (!mapState.dataStale) {
              recordMapSnapshot();
            }
          } else {
            const mapSensorLabel = document.getElementById("mapSensorLabel");
            if (mapSensorLabel) {
              mapSensorLabel.textContent = "No sensor selected";
            }
            mapState.dataStale = true;
            renderThermalGrid();
          }
        });
      // --- Record snapshot to history ---
      function recordMapSnapshot() {
        const data = mapState.grid.filter((v) => !isNaN(v) && v > 0.1);
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
        $mapLogBody.innerHTML = mapState.history
          .slice(0, 30)
          .map(
            (e) => `
          <tr>
              <td>${e.time}</td>
              <td>${e.sensor}</td>
              <td>${e.avg}°C</td>
              <td>${e.max}°C</td>
              <td>${e.min}°C</td>
          </tr>
      `,
          )
          .join("");
      }

      // --- Initialize thermal mapping (no simulation) ---
      function initThermalMapping() {
        populateMapSensorSelect();
        mapState.dataStale = true;
        mapState.grid = Array(64).fill(0);
        $mapSensorLabel.textContent = "No data – select a sensor";
        renderThermalGrid();

        // Clear any existing interval
        if (mapState.interval) clearInterval(mapState.interval);
        if (
          document.getElementById("thermalMappingPage")?.style.display !==
          "none"
        ) {
          if (mapState.sensorId && sensorsData[mapState.sensorId]) {
            loadSensorToMap(mapState.sensorId);
            if (!mapState.dataStale) {
              recordMapSnapshot();
            }
          }
        }
      }

      // ---- EVENT BINDINGS (single execution) ----
      (function bindMapEvents() {
        const dashboard = document
          .getElementById("dashboard-container")
          .querySelector(".dashboard");
        const sensorGrid = document.getElementById("sensorCardsGrid");
        const mapPage = document.getElementById("thermalMappingPage");
        const simulationPage = document.getElementById("simulationPage");
        const dashboardBrand = document.getElementById("dashboardBrand");
        const dashboardHeader = document.getElementById("dashboardHeader");

        function setDashboardVisibility(isVisible) {
          const display = isVisible ? "" : "none";
          if (dashboard) dashboard.style.display = display;
          if (sensorGrid) sensorGrid.style.display = display;
          if (dashboardBrand) dashboardBrand.style.display = display;
          if (dashboardHeader) dashboardHeader.style.display = display;
        }

        function updateSimulationControls() {
          const sd = getActiveSensorData();
          const label = document.getElementById("simulationSensorLabel");
          const limit = document.getElementById("simulationLimitValue");
          const sensorSelect = document.getElementById("simulationSensorSelect");
          if (sensorSelect) {
            sensorSelect.innerHTML = Object.keys(sensorsData)
              .map((key) => {
                const sensor = sensorsData[key];
                return `<option value="${key}">${sensor.roomName} > ${sensor.sensorName}</option>`;
              })
              .join("");
            sensorSelect.value = getActiveKey();
          }
          if (label) {
            label.textContent = sd
              ? `Selected sensor: ${sd.roomName} > ${sd.sensorName}`
              : "Selected sensor: --";
          }
          if (limit) {
            limit.textContent = sd ? formatTemp(sd.safeLimit) : "--.-°C";
          }
        }

        document.getElementById("simulationSensorSelect")?.addEventListener("change", (event) => {
          const [roomId, ...sensorParts] = event.target.value.split("_");
          activeRoomId = roomId;
          activeSensorId = sensorParts.join("_");
          const sensor = getActiveSensorData();
          updateSimulationControls();
          syncSimulationTemperature(sensor?.currentTemp ?? 15);
          renderSimulationPreview();
        });

        function setSimulationConnectionStatus(message, isError = false) {
          const status = document.getElementById("simulationConnectionStatus");
          if (status) {
            status.textContent = message;
            status.style.color = isError ? "var(--danger)" : "var(--success)";
          }
        }

        function renderSimulationPreview() {
          const sd = getActiveSensorData();
          if (!sd || sd.currentTemp === null) return;

          const values = sd.dataLog.length ? sd.dataLog : [sd.currentTemp];
          const statusBadge = document.getElementById("simulationStateBadge");
          const currentTemp = document.getElementById("simulationCurrentTemp");
          const statusText = document.getElementById("simulationStatusText");
          const alert = document.getElementById("simulationAlert");
          const limit = document.getElementById("simulationLimitValue");

          document.getElementById("simulationHighTemp").textContent = formatTemp(Math.max(...values));
          document.getElementById("simulationLowTemp").textContent = formatTemp(Math.min(...values));
          document.getElementById("simulationAvgTemp").textContent = formatTemp(values.reduce((sum, value) => sum + value, 0) / values.length);
          if (limit) limit.textContent = formatTemp(sd.safeLimit);
          currentTemp.textContent = formatTemp(sd.currentTemp);
          currentTemp.className = "temp-display";
          statusBadge.className = "state-badge";
          alert.style.display = "none";

          if (sd.status === "CRITICAL") {
            currentTemp.classList.add("status-danger");
            statusBadge.classList.add("critical");
            statusBadge.textContent = "CRITICAL BREACH";
            statusText.textContent = "Simulated appliance temperature is critical";
            statusText.className = "status-danger";
            alert.style.display = "block";
          } else if (sd.status === "HIGH_HEAT") {
            currentTemp.classList.add("status-warning");
            statusBadge.classList.add("high-heat");
            statusBadge.textContent = "HIGH HEAT";
            statusText.textContent = "Simulated temperature is approaching the limit";
            statusText.className = "status-warning";
          } else {
            currentTemp.classList.add("status-safe");
            statusBadge.classList.add("normal");
            statusBadge.textContent = "NORMAL";
            statusText.textContent = "Simulated appliance temperature is stable";
            statusText.className = "status-safe";
          }
        }

        const simulationRange = document.getElementById("simulationTempRange");
        const simulationInput = document.getElementById("simulationTempInput");
        const simulationValue = document.getElementById("simulationTempValue");
        const randomSimulationButton = document.getElementById("randomSimulationBtn");

        function syncSimulationTemperature(value) {
          if (String(value).trim() === "") return;
          const numericValue = Number(value);
          if (!Number.isFinite(numericValue)) return;
          const boundedValue = Math.max(10, Math.min(100, numericValue));
          simulationRange.value = boundedValue;
          simulationInput.value = boundedValue;
          simulationValue.textContent = `${boundedValue.toFixed(1)}°C`;
        }

        function stopRandomSimulation() {
          if (randomSimulationInterval) {
            clearInterval(randomSimulationInterval);
            randomSimulationInterval = null;
          }
          randomSimulationButton?.classList.remove("active");
          if (randomSimulationButton) {
            randomSimulationButton.innerHTML = `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m8 5-5 7 5 7V5ZM16 5l5 7-5 7V5ZM8 12h8"/></svg> Start Random Simulation`;
          }
        }

        function sendSimulationToEsp32(
          isActive,
          temperature = null,
          sensorId = activeSensorId,
        ) {
          esp32Sockets.forEach((socket) => {
            if (socket && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({
                simulation: isActive,
                sensorId,
                temperature,
              }));
            }
          });
        }

        window.stopEsp32Simulation = () => sendSimulationToEsp32(false);

        function startRandomSimulation() {
          stopRandomSimulation();
          const simulatedTemperatures = {};
          Object.keys(sensorsData).forEach((key) => {
            const currentTemperature = Number(sensorsData[key].currentTemp);
            simulatedTemperatures[key] = Number.isFinite(currentTemperature)
              ? Math.max(10, Math.min(100, currentTemperature))
              : 55;
          });
          const generateReading = () => {
            Object.keys(sensorsData).forEach((key) => {
              const sensor = sensorsData[key];
              const change = (Math.random() - 0.5) * 6;
              simulatedTemperatures[key] = Math.max(
                10,
                Math.min(100, simulatedTemperatures[key] + change),
              );
              evaluateMetrics(sensor.roomId, sensor.sensorId, simulatedTemperatures[key], {
                publishTelemetry: false,
                publishHistory: false,
                refreshDashboard: false,
                recordHistory: false,
              });
              sendSimulationToEsp32(true, simulatedTemperatures[key], sensor.sensorId);
              if (typeof window.publishSimulationReading === "function") {
                window.publishSimulationReading(
                  sensor.roomId,
                  sensor.sensorId,
                  simulatedTemperatures[key],
                  simulationClientId,
                );
              }
            });
            syncSimulationTemperature(simulatedTemperatures[getActiveKey()]);
            refreshHeroDisplay();
            renderSimulationPreview();
            const status = document.getElementById("simulationStatus");
            if (status) status.textContent = "Random readings active for both sensors";
          };
          generateReading();
          randomSimulationInterval = setInterval(generateReading, 1000);
          randomSimulationButton?.classList.add("active");
          if (randomSimulationButton) {
            randomSimulationButton.innerHTML = `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg> Stop Random Simulation`;
          }
        }

        function updateSimulationReading(shouldBroadcast = false) {
          const rawValue = simulationInput.value.trim();
          const temperature = Number(rawValue);
          const sd = getActiveSensorData();
          const status = document.getElementById("simulationStatus");
          if (!sd || rawValue === "" || !Number.isFinite(temperature)) {
            if (status) status.textContent = "Enter a valid temperature first.";
            return;
          }

          syncSimulationTemperature(temperature);
          sendSimulationToEsp32(true, temperature);
          evaluateMetrics(activeRoomId, activeSensorId, temperature, {
            publishTelemetry: false,
            publishHistory: false,
            refreshDashboard: false,
            recordHistory: false,
          });
          renderSimulationPreview();

          if (shouldBroadcast && typeof window.publishSimulationReading === "function") {
            window.publishSimulationReading(
              activeRoomId,
              activeSensorId,
              temperature,
              simulationClientId,
            );
            setSimulationConnectionStatus("Shared reading sent to connected devices");
            status.textContent = `Test reading applied: ${temperature.toFixed(1)}°C`;
          } else if (shouldBroadcast) {
            setSimulationConnectionStatus("Firebase is not connected; reading is local only", true);
          }
        }

        simulationRange?.addEventListener("input", (event) => {
          syncSimulationTemperature(event.target.value);
          updateSimulationReading();
        });
        simulationInput?.addEventListener("input", (event) => {
          syncSimulationTemperature(event.target.value);
          updateSimulationReading();
        });

        document.getElementById("applySimulationBtn")?.addEventListener("click", () => {
          updateSimulationReading(true);
        });

        randomSimulationButton?.addEventListener("click", () => {
          if (randomSimulationInterval) stopRandomSimulation();
          else startRandomSimulation();
        });

        document.getElementById("showSimulationBtn")?.addEventListener("click", () => {
          simulationMode = true;
          setDashboardVisibility(false);
          if (mapPage) mapPage.style.display = "none";
          if (simulationPage) simulationPage.style.display = "block";
          updateSimulationControls();
          renderSimulationPreview();
          setSimulationConnectionStatus("Shared control ready");
          startRandomSimulation();
        });

        window.receiveSimulationReading = function (reading) {
          if (!reading || reading.source === simulationClientId) return;
          const temperature = Number(reading.temperature);
          if (!Number.isFinite(temperature) || !reading.roomId || !reading.sensorId) {
            return;
          }

          activeRoomId = reading.roomId;
          activeSensorId = reading.sensorId;
          sendSimulationToEsp32(true, temperature);
          evaluateMetrics(reading.roomId, reading.sensorId, temperature, {
            publishTelemetry: false,
            publishHistory: false,
            refreshDashboard: true,
            recordHistory: false,
          });

          if (simulationMode) {
            syncSimulationTemperature(temperature);
            renderSimulationPreview();
            setSimulationConnectionStatus("Reading received from another device");
            document.getElementById("simulationStatus").textContent =
              `Remote reading applied: ${temperature.toFixed(1)}°C`;
          }
        };

        document.getElementById("backFromSimulationBtn")?.addEventListener("click", () => {
          stopRandomSimulation();
          window.stopEsp32Simulation();
          simulationMode = false;
          if (simulationPage) simulationPage.style.display = "none";
          setDashboardVisibility(true);
          refreshHeroDisplay();
        });

        // Show map page
        document.getElementById("showMapBtn")?.addEventListener("click", () => {
          simulationMode = false;
          stopRandomSimulation();
          window.stopEsp32Simulation();
          setDashboardVisibility(false);
          if (simulationPage) simulationPage.style.display = "none";
          if (mapPage) mapPage.style.display = "block";
          initThermalMapping();
        });

        // Back to dashboard
        document
          .getElementById("backToDashboardBtn")
          ?.addEventListener("click", () => {
            setDashboardVisibility(true);
            if (mapPage) mapPage.style.display = "none";
            if (mapState.interval) clearInterval(mapState.interval);
          });

        // Sensor select change
        document
          .getElementById("mapSensorSelect")
          ?.addEventListener("change", (e) => {
            mapState.sensorId = e.target.value;
            if (mapState.sensorId && sensorsData[mapState.sensorId]) {
              loadSensorToMap(mapState.sensorId);
              recordMapSnapshot();
            }
          });

        // Refresh map
        document
          .getElementById("refreshMapBtn")
          ?.addEventListener("click", () => {
            if (mapState.sensorId && sensorsData[mapState.sensorId]) {
              loadSensorToMap(mapState.sensorId);
              recordMapSnapshot();
            } else {
              $mapSensorLabel.textContent = "No sensor selected";
              mapState.dataStale = true;
              renderThermalGrid();
            }
          });

        // Clear map log
        document
          .getElementById("clearMapLogBtn")
          ?.addEventListener("click", () => {
            if (confirm("Clear mapping history?")) {
              mapState.history = [];
              renderMapLog();
            }
          });
      })();

// Expose for use elsewhere
window.mapState = mapState;
window.loadSensorToMap = loadSensorToMap;
window.renderThermalGrid = renderThermalGrid;
window.recordMapSnapshot = recordMapSnapshot;
      // ─────────────────────────────────────
      // ESP32 WEBSOCKET
      // ─────────────────────────────────────
      // Updates the ESP32 connection badge label and styling based on the current device state.
      function setDeviceBadge(index, text, cls) {
        const badge = $deviceBadges[index];
        if (!badge) return;
        badge.innerText = text;
        badge.className = cls;
      }

      // ─────────────────────────────────────
      // CONNECTION WATCHDOG (Zero out if no data)
      // ──────────────────────────────────────
      let lastDataReceivedTime = Date.now();
      let watchdogInterval = null;

      function zeroOutSensorReadings() {
        Object.keys(sensorsData).forEach((key) => {
          const sd = sensorsData[key];
          // Only trigger if it isn't already zero
          if (sd.currentTemp !== 0) {
            sd.currentTemp = 0;
            sd.status = "NORMAL"; // Clears any active alarms

            // Visually update the mini cards
            if (typeof updateSensorCardUI === "function") {
              updateSensorCardUI(sd.roomId, sd.sensorId, 0, "NORMAL");
            }
          }
        });
        // Update the main hero display
        refreshHeroDisplay();
      }

      function startDataWatchdog() {
        if (watchdogInterval) clearInterval(watchdogInterval);
        lastDataReceivedTime = Date.now();

        // Check every 500 milliseconds for a super fast response
        watchdogInterval = setInterval(() => {
          // If 3 seconds pass with NO data, zero out readings and reconnect
          if (Date.now() - lastDataReceivedTime > 3000) {
            zeroOutSensorReadings();
            
            // Force reconnect if the connection is a "zombie"
            esp32Sockets.forEach((socket, index) => {
              if (socket && socket.readyState === WebSocket.OPEN) {
                console.log(`[Watchdog] No data from ESP32 #${index + 1} for 3s. Forcing reconnect...`);
                socket.close(); // This triggers the auto-reconnect timer
              }
            });
          }
        }, 500); // Check the clock every 0.5 seconds
      }


      // Opens a WebSocket connection to the configured ESP32 endpoint and handles live telemetry messages.
      function connectToEsp32(index) {
        if (!isAuthenticated || !monitoringEnabled) {
          setDeviceBadge(index, "Not Connected", "badge offline");
          return;
        }

        const host = ($esp32HostInputs[index].value || "").trim();

        if (!host) {
          esp32Connections[index] = false;
          setDeviceBadge(index, "Not Connected", "badge offline");
          if (esp32Sockets[index]) {
            try {
              esp32Sockets[index].close();
            } catch (e) {}
            esp32Sockets[index] = null;
          }
          return;
        }

        const wsUrl =
          host.startsWith("ws://") || host.startsWith("wss://")
            ? host
            : `ws://${host}:81`;
        if (
          esp32Sockets[index] &&
          (esp32Sockets[index].readyState === WebSocket.OPEN ||
            esp32Sockets[index].readyState === WebSocket.CONNECTING)
        ) {
          return;
        }

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
              socket.send(
                JSON.stringify({
                  type: "connected",
                  safeLimit: toCelsius(currentLimit),
                }),
              );
              socket.send(JSON.stringify({ type: "requestTelemetry" }));
              console.log(
                `[ESP32 #${index + 1}] Connected and requested initial sync.`,
              );
            }

            // Push all current sensor names to the ESP32 OLED
            Object.values(sensorsData).forEach((sd) => {
              socket.send(
                JSON.stringify({
                  type: "updateSensorName",
                  sensorId: sd.sensorId,
                  sensorName: sd.sensorName,
                }),
              );
            });
          });

          socket.addEventListener("message", (event) => {
            lastDataReceivedTime = Date.now();
            try {
              const payload = JSON.parse(event.data);
// Handle full AMG8833 thermal grid (64‑pixel array from ESP32)
if (payload.thermalGrid && Array.isArray(payload.thermalGrid) && payload.thermalGrid.length === 64) {
    const gridData = payload.thermalGrid.map(v => parseFloat(v)).filter(v => !isNaN(v));
    if (gridData.length === 64) {
        // Only update if the map is visible and the sensor matches
        const mapKey = payload.sensorId 
            ? `${payload.roomId || activeRoomId}_${payload.sensorId}` 
            : null;
        if (mapKey && window.mapState.sensorId === mapKey) {
            window.mapState.grid = gridData;
            if (typeof window.renderThermalGrid === 'function') {
                window.renderThermalGrid();
            }
            if (!window.mapState.dataStale && typeof window.recordMapSnapshot === 'function') {
                window.recordMapSnapshot();
            }
        }
    }
}
              if (payload.safeLimit !== undefined) {
                const syncedLimit = parseFloat(payload.safeLimit);
                if (!isNaN(syncedLimit)) {
                  const activeSensor = getActiveSensorData();
                  if (activeSensor) {
                    activeSensor.safeLimit = syncedLimit;
                  }
                  $limitInput.value = fromCelsius(syncedLimit).toFixed(1);
                  console.log(
                    `[ESP32 #${index + 1}] Received synced threshold from ESP32: ${syncedLimit}°C`,
                  );
                }
              }

              if (payload.temperature !== undefined) {
                let numericTemp = parseFloat(payload.temperature);
                if (!isNaN(numericTemp)) {
                  // --- BUG FIX: Convert incoming Fahrenheit back to Celsius ---
                  if (!isCelsius) {
                    numericTemp = ((numericTemp - 32) * 5) / 9;
                  }
                  // ------------------------------------------------------------

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

            // Automatically attempt to reconnect every 5 seconds
            setTimeout(() => {
              if (monitoringEnabled) {
                connectToEsp32(index);
              }
            }, 5000);
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
        input.addEventListener("change", () => {
          localStorage.setItem(`esp32Host${index + 1}`, input.value.trim());
          connectToEsp32(index);
        });
      });

      $esp32HostInputs.forEach((input, index) => {
        const savedHost = localStorage.getItem(`esp32Host${index + 1}`) || "";
        if (savedHost) {
          input.value = savedHost;
          connectToEsp32(index);
        } else {
          setDeviceBadge(index, "Not Connected", "badge offline");
        }
      });

      // ─────────────────────────────────────
      // INITIAL UI RENDER
      // ─────────────────────────────────────
      renderSensorCards();
      refreshHeroDisplay();
      renderTableLog();
      updateLimitInputForActiveSensor();
      // Event listener for the print button
      // Print Log – show only the log table
      document
        .getElementById("printLogBtn")
        ?.addEventListener("click", function () {
          document.body.classList.add("print-log-mode");
          window.print();
          document.body.classList.remove("print-log-mode");
        });

      // Print Map – show only the thermal map
      document
        .getElementById("printMapBtn")
        ?.addEventListener("click", function () {
          document.body.classList.add("print-map-mode");
          window.print();
          document.body.classList.remove("print-map-mode");
        });
      // ── FADE OUT LOADING SCREEN AFTER 3 SECONDS ──
      setTimeout(() => {
        const ls = document.getElementById("loading-screen");
        if (ls) ls.classList.add("fade-out");
      }, 6000);
      // ── STARTUP SOUND (gentle ascending chime) ──
      function playStartupSound() {
        if (!audioCtx) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        const now = audioCtx.currentTime;

        // Helper to create a smooth tone
        function playTone(freq, start, dur, type = "sine", gain = 0.15) {
          const osc = audioCtx.createOscillator();
          const gainNode = audioCtx.createGain();
          osc.type = type;
          osc.frequency.setValueAtTime(freq, now + start);
          gainNode.gain.setValueAtTime(0, now + start);
          gainNode.gain.linearRampToValueAtTime(gain, now + start + 0.05);
          gainNode.gain.exponentialRampToValueAtTime(0.001, now + start + dur);
          osc.connect(gainNode);
          gainNode.connect(audioCtx.destination);
          osc.start(now + start);
          osc.stop(now + start + dur);
        }

        // Gentle bass undertone
        playTone(130.81, 0, 1.2, "sine", 0.1); // C3

        // Main melody – slightly overlapping
        playTone(523.25, 0.1, 0.6, "sine", 0.18); // C5
        playTone(659.25, 0.25, 0.6, "sine", 0.18); // E5
        playTone(783.99, 0.4, 0.7, "sine", 0.2); // G5
        playTone(1046.5, 0.55, 0.9, "sine", 0.22); // C6

        // Soft “shimmer” chord at the end
        playTone(1318.5, 0.7, 0.8, "sine", 0.1); // E6
        playTone(1568.0, 0.75, 0.7, "sine", 0.08); // G6
      }
      // ─────────────────────────────────────
      // AUTH SCREEN LOGIC (before Firebase)
      // ─────────────────────────────────────
      const $passwordToggleBtn = document.getElementById("passwordToggleBtn");
      const $forgotPasswordBtn = document.getElementById("forgotPasswordBtn");

      $passwordToggleBtn.addEventListener("click", () => {
        const isPassword = $authPassword.type === "password";
        $authPassword.type = isPassword ? "text" : "password";
        $passwordToggleBtn.innerText = isPassword ? "Hide" : "Show";
      });

      $tabSignIn.addEventListener("click", () => {
        window.authMode = "signin";
        $authSubmitBtn.innerText = "Sign In";
        $authError.innerText = "";
        $authSuccess.innerText = "";
      });

      // Reveals the authenticated dashboard and enables monitoring after a valid admin sign-in.
      function showDashboard() {
        isAuthenticated = true;
        monitoringEnabled = true;
        renderSensorCards();
        refreshHeroDisplay();
        renderTableLog();
        updateLimitInputForActiveSensor();
        playStartupSound();
        $authScreen.classList.add("hidden");
        $dashboardContainer.classList.add("visible");
        $esp32HostInputs.forEach((input, index) => {
          const savedHost = localStorage.getItem(`esp32Host${index + 1}`) || "";
          if (savedHost) {
            input.value = savedHost;
            connectToEsp32(index);
          }
        });
        startDataWatchdog();
      }

      // Hides the dashboard and restores the admin authentication screen when the session is signed out.
      function showAuthScreen() {
        isAuthenticated = false;
        monitoringEnabled = false;
        if (typeof window.stopEsp32Simulation === "function") {
          window.stopEsp32Simulation();
        }
        $authScreen.classList.remove("hidden");
        $dashboardContainer.classList.remove("visible");
        stopSiren();
      }

      // Expose for Firebase auth module
      window.showDashboard = showDashboard;
      window.showAuthScreen = showAuthScreen;
      window.setUserBadge = function (email) {
        $userBadge.innerText = email || "Authenticated";
        $userBadge.className = "badge connected";
      };
