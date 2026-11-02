/*
 * THERM E.Y.E - ESP32 Firmware (WebSocket + Dual MLX90614 + Auto-Sweep)
 *
 * Hardware:
 * - ESP32 DevKit V1
 * - 2x MLX90614 (I2C Bus A and Bus B)
 * - 2x SG90 Servos (auto-sweep)
 * - LEDs (Green, Red), Buzzer
 *
 * Integrates with the ThermE.Y.E web dashboard over WebSocket (port 81).
 *
 * REQUIRED LIBRARIES (Arduino Library Manager):
 *   - Adafruit MLX90614 Library
 *   - ESP32Servo
 *   - WebSockets         (by Markus Sattler)
 *   - ArduinoJson        (v6.21+)
 *
 * WARNING FROM SCHEMATIC:
 *   Do NOT plug in USB while VIN is powered.
 *   Disconnect battery before programming.
 *
 * NOTE ON THE DASHBOARD'S UNIT BUG:
 *   script.js converts incoming WebSocket temperatures from °F back to °C
 *   when the UI is in Fahrenheit. To stay compatible, this firmware sends
 *   readings in whichever unit the dashboard is currently displaying.
 */

#include <WiFi.h>
#include <WebSocketsServer.h>
#include <Wire.h>
#include <Adafruit_MLX90614.h>
#include <ESP32Servo.h>
#include <ArduinoJson.h>

// ================= USER CONFIG =================
const char* WIFI_SSID     = "ADMIN_SERVER";
const char* WIFI_PASSWORD = "G5CMgUD6";

// Must match the dashboard's DEFAULT_ROOMS keys
const char* ROOM_ID    = "room1";
const char* SENSOR1_ID = "AMG8833_1";
const char* SENSOR2_ID = "AMG8833_2";

const uint16_t WS_PORT = 81;
const unsigned long TELEMETRY_INTERVAL_MS = 1000;  // 1 Hz broadcast

// ================= PIN DEFINITIONS =================
// I2C Bus A (MLX90614 #1)
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

float currentSafeLimit  = 50.0f;    // °C — matches dashboard default
bool  displayFahrenheit = false;    // set by dashboard unit toggle

// Simulation (from dashboard)
bool  simulationActive = false;
float simulatedTemp1   = 0.0f;
float simulatedTemp2   = 0.0f;
bool  sim1Valid        = false;
bool  sim2Valid        = false;

// Servo sweep (Independent variables for each servo)
int servo1Pos = 0;
int servo1Dir = 1;
int servo2Pos = 0;
int servo2Dir = 1;
unsigned long lastServoUpdate = 0;
const int servoInterval = 20;

unsigned long lastTelemetry = 0;

// ================= HELPERS =================
// Converts a Celsius reading into whatever the dashboard is displaying.
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

void onWebSocketEvent(uint8_t clientNum, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("[WS] Client %u connected\n", clientNum);
      broadcastTelemetry(temp1, temp2);            // initial snapshot
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

      // Bare safeLimit (sent when user edits the limit input)
      if (doc.containsKey("safeLimit")) {
        float v = doc["safeLimit"].as<float>();
        if (!isnan(v) && v > 0) currentSafeLimit = v;
      }

      // Unit toggle
      if (doc.containsKey("unit")) {
        String u = doc["unit"].as<String>();
        displayFahrenheit = (u == "F" || u == "f");
      }

      String msgType = doc["type"] | "";
      if (msgType == "connected") {
        // Dashboard sends {type:"connected", safeLimit:…} on socket open
        if (doc.containsKey("safeLimit")) {
          float v = doc["safeLimit"].as<float>();
          if (!isnan(v) && v > 0) currentSafeLimit = v;
        }
      } else if (msgType == "requestTelemetry") {
        broadcastTelemetry(temp1, temp2);
      } else if (msgType == "updateSensorName") {
        // No OLED on this board — just log it so the dashboard's push is acknowledged
        String sid  = doc["sensorId"]   | "";
        String name = doc["sensorName"] | "";
        Serial.printf("[WS] Sensor name: %s -> %s\n", sid.c_str(), name.c_str());
      }

      // Simulation envelope
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
  digitalWrite(LED_G_PIN, LOW);
  digitalWrite(LED_R_PIN, LOW);
  digitalWrite(BUZ_PIN, LOW);

  // 2. Servos (SG90 pulse width 500–2400 µs)
  servo1.attach(SERVO1_PIN, 500, 2400);
  servo2.attach(SERVO2_PIN, 500, 2400);
  servo1.write(0);
  servo2.write(0);

  // 3. I2C Bus A — MLX90614 #1
  Wire.begin(SDA_A, SCL_A);
  if (!mlx1.begin(0x5A, &Wire)) {
    Serial.println("Error: MLX90614 #1 (Bus A) not found. Check wiring!");
  } else {
    sensor1Ok = true;
    Serial.println("MLX90614 #1 Initialized.");
  }

  // 4. I2C Bus B — MLX90614 #2
  Wire1.begin(SDA_B, SCL_B);
  if (!mlx2.begin(0x5A, &Wire1)) {
    Serial.println("Error: MLX90614 #2 (Bus B) not found. Check wiring!");
  } else {
    sensor2Ok = true;
    Serial.println("MLX90614 #2 Initialized.");
  }

  // 5. WiFi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWiFi connected. IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nWiFi failed — running offline (local alarm only).");
  }

  // 6. WebSocket server
  webSocket.begin();
  webSocket.onEvent(onWebSocketEvent);

  Serial.println("Setup complete. Enter this IP in the dashboard's 'ESP32 Host / IP' field.");
  Serial.printf("  -> %s\n", WiFi.localIP().toString().c_str());
}

// ================= LOOP =================
void loop() {
  webSocket.loop();

  // --- 1. Read temperatures ---
  if (sensor1Ok) temp1 = mlx1.readObjectTempC();
  if (sensor2Ok) temp2 = mlx2.readObjectTempC();

  bool t1Valid = sensor1Ok && !isnan(temp1);
  bool t2Valid = sensor2Ok && !isnan(temp2);
  
  // Independent heating flags
  bool isHeating1 = false; 
  bool isHeating2 = false; 

  if (!t1Valid || !t2Valid) {
    digitalWrite(LED_G_PIN, LOW);
    digitalWrite(LED_R_PIN, LOW);
    noTone(BUZ_PIN);
  } else {
    // Effective temperature used for the local alarm (respects simulation)
    float eff1 = (simulationActive && sim1Valid) ? simulatedTemp1 : temp1;
    float eff2 = (simulationActive && sim2Valid) ? simulatedTemp2 : temp2;

    // --- 2. Local alarm logic ---
    // Check each sensor independently
    if (eff1 > currentSafeLimit) isHeating1 = true;
    if (eff2 > currentSafeLimit) isHeating2 = true;

    // Buzzer and LEDs trigger if EITHER sensor is heating
    if (isHeating1 || isHeating2) {
      digitalWrite(LED_G_PIN, LOW);
      digitalWrite(LED_R_PIN, HIGH);
      tone(BUZ_PIN, 1000);
    } else {
      digitalWrite(LED_G_PIN, HIGH);
      digitalWrite(LED_R_PIN, LOW);
      noTone(BUZ_PIN);
    }

    // --- 3. Telemetry broadcast ---
    unsigned long now = millis();
    if (!simulationActive && now - lastTelemetry >= TELEMETRY_INTERVAL_MS) {
      lastTelemetry = now;
      broadcastTelemetry(temp1, temp2);
    }
  }

  // --- 4. Independent Non-blocking servo sweep ---
  unsigned long now = millis();
  if (now - lastServoUpdate >= servoInterval) {
    lastServoUpdate = now;
    
    // Servo 1 Logic (Controlled by Sensor 2 to fix crossed wiring)
    if (!isHeating2) {
      servo1Pos += servo1Dir;
      if (servo1Pos >= 180) { servo1Pos = 180; servo1Dir = -1; }
      else if (servo1Pos <= 0) { servo1Pos = 0; servo1Dir = 1; }
      servo1.write(servo1Pos);
    }
    
    // Servo 2 Logic (Controlled by Sensor 1 to fix crossed wiring)
    if (!isHeating1) {
      servo2Pos += servo2Dir;
      if (servo2Pos >= 180) { servo2Pos = 180; servo2Dir = -1; }
      else if (servo2Pos <= 0) { servo2Pos = 0; servo2Dir = 1; }
      servo2.write(servo2Pos);
    }
  }
}
