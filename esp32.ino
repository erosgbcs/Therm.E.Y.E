/*
 * THERM E.Y.E - ESP32 Firmware (WebSocket + Dual MLX90614 + Auto-Sweep + OLED)
 *
 * Hardware:
 * - ESP32 DevKit V1
 * - 2x MLX90614 (I2C Bus A and Bus B)
 * - SSD1306 OLED (128x64, I2C 0x3C, on Bus A)
 * - 2x SG90 Servos (auto-sweep)
 * - LEDs (Green, Red), Buzzer
 *
 * REQUIRED LIBRARIES (Arduino Library Manager):
 *   - Adafruit MLX90614 Library
 *   - Adafruit SSD1306  (pulls in Adafruit GFX)
 *   - ESP32Servo
 *   - WebSockets         (by Markus Sattler)
 *   - ArduinoJson        (v6.21+)
 *
 * WARNING FROM SCHEMATIC:
 *   Do NOT plug in USB while VIN is powered.
 *   Disconnect battery before programming.
 */

#include <WiFi.h>
#include <WebSocketsServer.h>
#include <Wire.h>
#include <Adafruit_MLX90614.h>
#include <ESP32Servo.h>
#include <ArduinoJson.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ================= USER CONFIG =================
struct NetworkConfig {
  const char* ssid;
  const char* password;
};

const NetworkConfig WIFI_NETWORKS[] = {
  {"ADMIN_SERVER", "G5CMgUD6"},
  {"HonorM", "hahawalangnett"},
  {"HonorM", "hahawalangnett"}
};
const int NUM_NETWORKS = sizeof(WIFI_NETWORKS) / sizeof(WIFI_NETWORKS[0]);

const char* ROOM_ID    = "room1";
const char* SENSOR1_ID = "AMG8833_1";
const char* SENSOR2_ID = "AMG8833_2";

const uint16_t WS_PORT = 81;
const unsigned long TELEMETRY_INTERVAL_MS = 1000;

// ================= PIN DEFINITIONS =================
// I2C Bus A (MLX90614 #1 + OLED)
#define SDA_A 21
#define SCL_A 22

// I2C Bus B (MLX90614 #2)
#define SDA_B 18
#define SCL_B 19

// Servos
#define SERVO1_PIN 13
#define SERVO2_PIN 14

// Outputs
#define LED_G_PIN 25
#define LED_R_PIN 26
#define BUZ_PIN   33
#define BTN_PIN   27  // ON/OFF Button

// ================= OLED =================
#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
#define SCREEN_ADDRESS 0x3C
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

bool          displayOk         = false;
unsigned long lastDisplayUpdate = 0;
unsigned long displayBootTime   = 0;              // Tracks time for the 3-second splash
const unsigned long DISPLAY_INTERVAL_MS = 1000;   // 1 Hz

// Button State
bool systemActive = true;
bool lastBtnState = HIGH;
unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 50;

// ================= OBJECTS =================
Adafruit_MLX90614 mlx1;
Adafruit_MLX90614 mlx2;

Servo servo1;
Servo servo2;

WebSocketsServer webSocket(WS_PORT);

// ================= STATE =================
float temp1 = 0.0f;
float temp2 = 0.0f;
bool  sensor1Ok = false;
bool  sensor2Ok = false;

float currentSafeLimit  = 50.0f;
bool  displayFahrenheit = false;

bool  simulationActive = false;
float simulatedTemp1   = 0.0f;
float simulatedTemp2   = 0.0f;
bool  sim1Valid        = false;
bool  sim2Valid        = false;

int servo1Pos = 0;
int servo1Dir = 1;
int servo2Pos = 0;
int servo2Dir = 1;
unsigned long lastServoUpdate = 0;
const int servoInterval = 20;

unsigned long lastTelemetry = 0;

// ================= HELPERS =================
float toDisplayUnit(float c) {
  return displayFahrenheit ? (c * 9.0f / 5.0f + 32.0f) : c;
}

void sendSensorReading(const char* sensorId, float celsius) {
  DynamicJsonDocument doc(128);
  doc["roomId"]      = ROOM_ID;
  doc["sensorId"]    = sensorId;
  doc["temperature"] = toDisplayUnit(celsius);
  String out;
  serializeJson(doc, out);
  webSocket.broadcastTXT(out);
}

void broadcastTelemetry(float t1, float t2) {
  if (webSocket.connectedClients() == 0) return;
  sendSensorReading(SENSOR1_ID, t1);
  sendSensorReading(SENSOR2_ID, t2);
}

void handleSimulationMessage(JsonDocument& doc) {
  if (!doc.containsKey("simulation")) return;
  simulationActive = doc["simulation"].as<bool>();

  if (simulationActive && doc.containsKey("temperature") && !doc["temperature"].isNull()) {
    float t = doc["temperature"].as<float>();
    String sid = doc["sensorId"] | "";
    if (sid == SENSOR1_ID)      { simulatedTemp1 = t; sim1Valid = true; }
    else if (sid == SENSOR2_ID) { simulatedTemp2 = t; sim2Valid = true; }
  }
  if (!simulationActive) { sim1Valid = false; sim2Valid = false; }

  Serial.printf("[WS] Simulation %s\n", simulationActive ? "START" : "STOP");
}

// ================= OLED DISPLAY =================
void updateDisplay() {
  if (!displayOk) return;

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  // --- 1. BOOT SPLASH SCREEN (Shows for first 3 seconds) ---
  if (millis() - displayBootTime < 3000) {
    display.setTextSize(2);
    display.setCursor(0, 0);
    display.println("THERM");
    display.println("E.Y.E");
    
    display.setTextSize(1);
    display.setCursor(0, 40);
    display.println("WiFi Connected!");
    
    display.setCursor(0, 54);
    display.print("IP: ");
    display.println(WiFi.localIP().toString());
    
    display.display();
    return; // Stop here, don't draw the dashboard yet
  }

  // --- 2. SYSTEM OFF SCREEN ---
  if (!systemActive) {
    display.setTextSize(2);
    display.setCursor(16, 16);
    display.println("SYSTEM");
    display.setCursor(36, 36);
    display.println("OFF");
    display.display();
    return; // Skip the rest of the dashboard drawing
  }

  // --- 3. MAIN DASHBOARD (Shows after 3 seconds) ---
  bool t1ok = sensor1Ok && !isnan(temp1);
  bool t2ok = sensor2Ok && !isnan(temp2);

  float eff1 = (simulationActive && sim1Valid) ? simulatedTemp1 : temp1;
  float eff2 = (simulationActive && sim2Valid) ? simulatedTemp2 : temp2;
  bool  alarm = (t1ok && eff1 > currentSafeLimit) || (t2ok && eff2 > currentSafeLimit);

  char line[24];

  // Title (Small)
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("THERM E.Y.E");
  display.drawLine(0, 10, SCREEN_WIDTH - 1, 10, SSD1306_WHITE);

  // T1 Temperature (BIG)
  display.setTextSize(2);
  display.setCursor(0, 12); // Moved up slightly
  if (t1ok) {
    snprintf(line, sizeof(line), "T1:%.1f%c", toDisplayUnit(temp1), displayFahrenheit ? 'F' : 'C');
  } else {
    snprintf(line, sizeof(line), "T1:--");
  }
  display.println(line);

  // T2 Temperature (BIG)
  display.setCursor(0, 30); // Moved up slightly
  if (t2ok) {
    snprintf(line, sizeof(line), "T2:%.1f%c", toDisplayUnit(temp2), displayFahrenheit ? 'F' : 'C');
  } else {
    snprintf(line, sizeof(line), "T2:--");
  }
  display.println(line);

  // Limit and Status (Small)
  display.setTextSize(1);
  display.setCursor(0, 48); // Moved up
  snprintf(line, sizeof(line), "Limit:%.1f%c", toDisplayUnit(currentSafeLimit), displayFahrenheit ? 'F' : 'C');
  display.print(line);

  display.setCursor(85, 48); // Moved up
  if (!t1ok || !t2ok) {
    display.println("ERR");
  } else if (alarm) {
    display.println("ALARM");
  } else {
    display.println("OK");
  }

  // Bottom Line (Small) - IP REMOVED
  display.setCursor(0, 56); // Moved up to fit perfectly on the screen
  if (simulationActive) {
    display.println("SIM ACTIVE");
  } else {
    display.println("MONITORING"); 
  }

  display.display();
}

// ================= WEBSOCKET =================
void onWebSocketEvent(uint8_t clientNum, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("[WS] Client %u connected\n", clientNum);
      broadcastTelemetry(temp1, temp2);
      break;

    case WStype_DISCONNECTED:
      Serial.printf("[WS] Client %u disconnected\n", clientNum);
      break;

    case WStype_TEXT: {
      DynamicJsonDocument doc(256);
      DeserializationError err = deserializeJson(doc, payload, length);
      if (err) {
        Serial.printf("[WS] JSON parse error: %s\n", err.c_str());
        break;
      }

      if (doc.containsKey("safeLimit")) {
        float v = doc["safeLimit"].as<float>();
        if (!isnan(v) && v > 0) currentSafeLimit = v;
      }

      if (doc.containsKey("unit")) {
        String u = doc["unit"].as<String>();
        displayFahrenheit = (u == "F" || u == "f");
      }

      String msgType = doc["type"] | "";
      if (msgType == "connected") {
        if (doc.containsKey("safeLimit")) {
          float v = doc["safeLimit"].as<float>();
          if (!isnan(v) && v > 0) currentSafeLimit = v;
        }
      } else if (msgType == "requestTelemetry") {
        broadcastTelemetry(temp1, temp2);
      } else if (msgType == "updateSensorName") {
        String sid  = doc["sensorId"]   | "";
        String name = doc["sensorName"] | "";
        Serial.printf("[WS] Sensor name: %s -> %s\n", sid.c_str(), name.c_str());
      }

      if (doc.containsKey("simulation")) {
        handleSimulationMessage(doc);
      }
      break;
    }

    default:
      break;
  }
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("THERM E.Y.E Booting...");

  // 1. Outputs
  pinMode(LED_G_PIN, OUTPUT);
  pinMode(LED_R_PIN, OUTPUT);
  pinMode(BUZ_PIN, OUTPUT);
  pinMode(BTN_PIN, INPUT_PULLUP); // Button with internal pull-up resistor
  digitalWrite(LED_G_PIN, LOW);
  digitalWrite(LED_R_PIN, LOW);
  digitalWrite(BUZ_PIN, LOW);

  // 2. Servos
  servo1.attach(SERVO1_PIN, 500, 2400);
  servo2.attach(SERVO2_PIN, 500, 2400);
  servo1.write(0);
  servo2.write(0);

  // 3. I2C Bus A — MLX90614 #1 + OLED
  Wire.begin(SDA_A, SCL_A);
  // Optional: speed up OLED refresh (may break some MLX90614 clones):
  // Wire.setClock(400000);

  // 4. OLED init (same bus)
  if (!display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println("Error: SSD1306 OLED not found. Check wiring!");
    displayOk = false;
  } else {
    displayOk = true;
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.println("THERM E.Y.E");
    display.println("Booting...");
    display.display();
    Serial.println("SSD1306 OLED Initialized.");
  }

  // 5. MLX90614 #1 (Bus A)
  if (!mlx1.begin(0x5A, &Wire)) {
    Serial.println("Error: MLX90614 #1 (Bus A) not found. Check wiring!");
  } else {
    sensor1Ok = true;
    Serial.println("MLX90614 #1 Initialized.");
  }

  // 6. I2C Bus B — MLX90614 #2
  Wire1.begin(SDA_B, SCL_B);
  if (!mlx2.begin(0x5A, &Wire1)) {
    Serial.println("Error: MLX90614 #2 (Bus B) not found. Check wiring!");
  } else {
    sensor2Ok = true;
    Serial.println("MLX90614 #2 Initialized.");
  }

  // 7. WiFi (Multi-Network Fallback)
  WiFi.mode(WIFI_STA);
  bool wifiConnected = false;

  for (int i = 0; i < NUM_NETWORKS; i++) {
    Serial.printf("Connecting to WiFi: %s", WIFI_NETWORKS[i].ssid);
    WiFi.begin(WIFI_NETWORKS[i].ssid, WIFI_NETWORKS[i].password);

    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 10000) {
      delay(500);
      Serial.print(".");
    }

    if (WiFi.status() == WL_CONNECTED) {
      wifiConnected = true;
      Serial.printf("\nWiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());
      break;
    } else {
      Serial.println("\nFailed to connect. Trying next network...");
      WiFi.disconnect();
    }
  }

  if (!wifiConnected) {
    Serial.println("\nAll WiFi networks failed — running offline (local alarm only).");
  }

  // 8. WebSocket server
  webSocket.begin();
  webSocket.onEvent(onWebSocketEvent);

  Serial.println("Setup complete. Enter this IP in the dashboard's 'ESP32 Host / IP' field.");
  Serial.printf("  -> %s\n", WiFi.localIP().toString().c_str());

  // 9. Show final state on OLED (Starts the 3-second IP splash screen)
  displayBootTime = millis();
  updateDisplay();
}

// ================= LOOP =================
void loop() {
  webSocket.loop();

  // --- 0. Read ON/OFF Button (Debounced) ---
  bool reading = digitalRead(BTN_PIN);
  if (reading != lastBtnState) {
    lastDebounceTime = millis();
  }
  if ((millis() - lastDebounceTime) > debounceDelay) {
    static bool btnState = HIGH;
    if (reading != btnState) {
      btnState = reading;
      if (btnState == LOW) { // Button was pressed
        systemActive = !systemActive; // Toggle state
        Serial.printf("\n[BTN] System %s\n", systemActive ? "ON" : "OFF");
        lastDisplayUpdate = 0; // Force immediate OLED refresh
      }
    }
  }
  lastBtnState = reading;

  // --- SYSTEM OFF STATE ---
  if (!systemActive) {
    digitalWrite(LED_G_PIN, LOW);
    digitalWrite(LED_R_PIN, LOW);
    noTone(BUZ_PIN);
    servo1.write(90); // Center servos
    servo2.write(90);
    
    unsigned long nowOff = millis();
    if (displayOk && (nowOff - lastDisplayUpdate >= DISPLAY_INTERVAL_MS)) {
      lastDisplayUpdate = nowOff;
      updateDisplay();
    }
    return; // Skips all sensor reading, alarms, and telemetry
  }

  // --- 1. Read temperatures ---
  if (sensor1Ok) temp1 = mlx1.readObjectTempC();
  if (sensor2Ok) temp2 = mlx2.readObjectTempC();

  bool t1Valid = sensor1Ok && !isnan(temp1);
  bool t2Valid = sensor2Ok && !isnan(temp2);

  bool isHeating1 = false;
  bool isHeating2 = false;

  // Get effective temperatures (respecting simulation)
  float eff1 = (simulationActive && sim1Valid) ? simulatedTemp1 : temp1;
  float eff2 = (simulationActive && sim2Valid) ? simulatedTemp2 : temp2;

  // Check each sensor INDEPENDENTLY. Only trigger if the sensor is valid AND hot.
  if (t1Valid && eff1 > currentSafeLimit) isHeating1 = true;
  if (t2Valid && eff2 > currentSafeLimit) isHeating2 = true;

  // --- 2. Local alarm logic ---
  if (isHeating1 || isHeating2) {
    // ALARM: At least one working sensor is too hot!
    digitalWrite(LED_G_PIN, LOW);
    digitalWrite(LED_R_PIN, HIGH);
    tone(BUZ_PIN, 1000);
  } else if (!t1Valid && !t2Valid) {
    // BOTH SENSORS DEAD: Turn off LEDs and buzzer to prevent false alarms.
    digitalWrite(LED_G_PIN, LOW);
    digitalWrite(LED_R_PIN, LOW);
    noTone(BUZ_PIN);
  } else {
    // NORMAL: At least one sensor is working, and neither is heating.
    digitalWrite(LED_G_PIN, HIGH);
    digitalWrite(LED_R_PIN, LOW);
    noTone(BUZ_PIN);
  }

  // --- 3. Telemetry broadcast ---
  // Moved OUTSIDE the if/else block so it keeps sending data to the dashboard 
  // even if one of the sensors is disconnected.
  unsigned long now = millis();
  if (!simulationActive && now - lastTelemetry >= TELEMETRY_INTERVAL_MS) {
    lastTelemetry = now;
    broadcastTelemetry(temp1, temp2);
  }

  // --- 4. Independent non-blocking servo sweep ---
  if (now - lastServoUpdate >= servoInterval) {
    lastServoUpdate = now;

    // Servo 1 (controlled by Sensor 2 — crossed wiring)
    if (!isHeating2) {
      servo1Pos += servo1Dir;
      if (servo1Pos >= 180) { servo1Pos = 180; servo1Dir = -1; }
      else if (servo1Pos <= 0) { servo1Pos = 0; servo1Dir = 1; }
      servo1.write(servo1Pos);
    }

    // Servo 2 (controlled by Sensor 1 — crossed wiring)
    if (!isHeating1) {
      servo2Pos += servo2Dir;
      if (servo2Pos >= 180) { servo2Pos = 180; servo2Dir = -1; }
      else if (servo2Pos <= 0) { servo2Pos = 0; servo2Dir = 1; }
      servo2.write(servo2Pos);
    }
  }

  // --- 5. OLED refresh (1 Hz) ---
  if (displayOk && (now - lastDisplayUpdate >= DISPLAY_INTERVAL_MS)) {
    lastDisplayUpdate = now;
    updateDisplay();
  }
}
