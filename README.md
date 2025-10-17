IoT Bus RTDB Backend

This backend manages real-time bus tracking, student check-ins/check-outs, and driver association using RFID readers, GPS, and emergency alerts. It integrates with Firebase Realtime Database and supports efficient, persistent logging for high-frequency updates.

Table of Contents

Features

Data Flow & Logic

Endpoint

Student Check-in/Check-out Rules

Driver Handling

GPS & Emergency Updates

Batch Logging & Persistence

Setup & Environment

Features

RFID integration for students and drivers.

Real-time GPS updates every second.

Emergency button support from buses.

Student status validation to prevent multiple bus check-ins.

Driver-bus association.

Persistent batch logging to reduce Firebase writes and prevent data loss.

Historical logs for all bus movements and events.

Data Flow & Logic

ESP32 sends JSON every second to /rfid-scan containing:

{
  "tagId": "OPTIONAL",         // Student or driver RFID
  "readerUsername": "Bus1",
  "location": { "lat": 0.0, "lng": 0.0 },
  "speed": 0.0,
  "emergency": false
}


Backend processes:

Finds the bus in Firebase by readerUsername.

Compares current GPS, speed, and emergency with last known state.

Updates Firebase only if meaningful changes occur or a tag is scanned.

Creates a log entry for all meaningful updates.

Student or driver tag processing:

Checks if the tag belongs to a student or a driver.

Updates student status or driver-bus association.

Adds student or driver info to the log entry.

Endpoint
POST /rfid-scan

Request Body:

tagId (optional) – RFID tag of student or driver.

readerUsername (required) – Identifier of the bus reader.

location (required) – Current latitude and longitude.

speed (optional) – Bus speed.

emergency (optional) – Emergency button state (true/false).

Response:

200 OK – Update processed successfully.

400 Bad Request – Missing readerUsername or student already checked in on another bus.

404 Not Found – Bus not found or tag not recognized.

500 Internal Server Error – Unexpected server error.

Student Check-in/Check-out Rules

Each student has lastStatus and lastBusId.

Rules:

check-in on the same bus → toggle to check-out.

check-in on a different bus → rejected, cannot check in on multiple buses.

check-out → allow check-in on the current bus.

Logs include student name, status, bus info, location, speed, and emergency state.

Driver Handling

Tags belonging to drivers:

Associate the driver with the bus.

Update driver info (currentBusReaderUsername).

Log the event with driver name and phone.

GPS & Emergency Updates

Tag-less updates are supported.

Bus GPS, speed, and emergency status are updated only if changed significantly.

Logs every update for historical tracking.

Batch Logging & Persistence

Logs are batched in memory per bus and pushed every second.

Persistent storage (JSON file) ensures logs survive server restarts.

Each log includes bus info, driver info, student info (if tag exists), location, speed, and emergency.

Setup & Environment

Install dependencies:

npm install express cors body-parser firebase-admin


Set Firebase Admin credentials as environment variable:

export FIREBASE_SERVICE_ACCOUNT_KEY='{"type":"service_account", ...}'


Start the server:

node index.js


Default port: 8080.

Endpoint: POST http://localhost:8080/rfid-scan

⚠️ Note: Replace all placeholders in environment variables and JSON bodies with your own project values. Do not commit private keys or passwords to GitHub.

Summary

This backend provides a robust, real-time bus tracking system with:

Student check-in/out rules tied to bus history.

Driver management.

Efficient GPS & emergency logging.

Persistent batch logging for reliability.
