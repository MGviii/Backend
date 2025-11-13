const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const axios = require("axios"); // for calling Flask ETA API

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ruhire-default-rtdb.firebaseio.com/"
});

const db = admin.database();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const lastBusState = {};
const batchLogsFile = path.join(__dirname, "batchLogs.json");
let batchLogs = {};

// Load persisted batch logs
if (fs.existsSync(batchLogsFile)) {
  try {
    batchLogs = JSON.parse(fs.readFileSync(batchLogsFile));
    console.log("Loaded existing batch logs");
  } catch (err) {
    console.error("Error reading batchLogs.json:", err);
    batchLogs = {};
  }
}

// Batch push logs every 2 seconds
setInterval(async () => {
  const logsRef = db.ref("logs");
  for (const busKey in batchLogs) {
    const logsArray = batchLogs[busKey];
    while (logsArray.length > 0) {
      const log = logsArray.shift();
      try {
        await logsRef.push(log);
        console.log(`Pushed log for bus ${busKey}`);
      } catch (err) {
        logsArray.unshift(log);
        console.error(`Failed to push log for bus ${busKey}:`, err.message);
        break;
      }
    }
  }
  try {
    fs.writeFileSync(batchLogsFile, JSON.stringify(batchLogs, null, 2));
  } catch (err) {
    console.error("Error writing batchLogs.json:", err);
  }
}, 2000);

// Health check
app.get("/", (_, res) => res.send("IoT Bus RTDB Backend is live 🚀"));

// --- RFID / GPS Scan Endpoint ---
app.post("/rfid-scan", async (req, res) => {
  try {
    const {
      tagId,
      readerUsername,
      emergency,
      location,
      Latitude,
      Longitude,
      Altitude,
      Speed,
      Heading,
      Satellites,
      Date: dateStr,
      "Time (UTC)": timeStr
    } = req.body;

    if (!readerUsername) return res.status(400).json({ error: "Missing readerUsername" });

    const busesRef = db.ref("buses");
    const studentsRef = db.ref("students");
    const driversRef = db.ref("drivers");
    const emergencyRef = db.ref("Emergency");

    // Find the bus
    const busesSnap = await busesRef.orderByChild("rfidReaderUsername").equalTo(readerUsername).once("value");
    if (!busesSnap.exists()) {
      console.log("Bus not found for readerUsername:", readerUsername);
      return res.status(404).json({ error: "Bus not found" });
    }

    let busKey, busData;
    busesSnap.forEach(snap => { busKey = snap.key; busData = snap.val(); });
    console.log(`Bus found: ${busKey}`);

    const updates = {};
    const timestamp = Date.now();

    // Option 2: always update RFID/emergency even if GPS invalid
    const lat = Latitude || (location && location.lat) || 0;
    const lng = Longitude || (location && location.lng) || 0;

    const locData = {
      Latitude: lat,
      Longitude: lng,
      Altitude: Altitude || null,
      Speed: Speed || 0,
      Heading: Heading || null,
      Satellites: Satellites || null,
      Date: dateStr || null,
      "Time (UTC)": timeStr || null,
      timestamp
    };

    if (tagId || emergency === true) {
      updates[`busLocations/${busKey}/current`] = locData;
      updates[`busLocations/${busKey}/history/${timestamp}`] = locData;
      console.log(`Updated bus location for ${busKey} (RFID or Emergency)`);
    }

    // Emergency handling
    if (emergency === true) {
      await emergencyRef.child(readerUsername).set({
        readerUsername,
        emergency: true,
        location: { lat, lng }
      });
      console.log(`Emergency logged for ${readerUsername}`);
    }

    // RFID / Tag handling
    if (tagId) {
      let logData = {
        busId: busKey,
        busName: busData.plateNumber || "",
        driverName: busData.driverName || "",
        driverPhone: busData.driverPhone || "",
        tagId,
        timestamp,
        location: { lat, lng }
      };

      const [studentsSnap, driversSnap] = await Promise.all([
        studentsRef.orderByChild("studentId").equalTo(tagId).once("value"),
        driversRef.orderByChild("driverId").equalTo(tagId).once("value")
      ]);

      if (studentsSnap.exists()) {
        let studentKey, studentData;
        studentsSnap.forEach(snap => { studentKey = snap.key; studentData = snap.val(); });

        const lastBusId = studentData.lastBusId || null;
        const lastStatus = studentData.lastStatus || "check-out";
        let newStatus = (lastStatus === "check-in" && lastBusId === busKey) ? "check-out" : (lastStatus === "check-in") ? null : "check-in";
        if (!newStatus) return res.status(400).json({ error: "Student already checked in on another bus", studentId: tagId, lastBusId });

        logData.studentName = studentData.name || "";
        logData.status = newStatus;
        updates[`students/${studentKey}/lastStatus`] = newStatus;
        updates[`students/${studentKey}/lastBusId`] = busKey;
        updates[`students/${studentKey}/lastLat`] = lat;
        updates[`students/${studentKey}/lastLng`] = lng;

      } else if (driversSnap.exists()) {
        let driverKey, driverData;
        driversSnap.forEach(snap => { driverKey = snap.key; driverData = snap.val(); });
        updates[`buses/${busKey}/driverId`] = driverKey;
        updates[`buses/${busKey}/driverName`] = driverData.name || "";
        updates[`buses/${busKey}/driverPhone`] = driverData.phone || "";
        updates[`drivers/${driverKey}/currentBusReaderUsername`] = readerUsername;
      } else {
        return res.status(404).json({ error: "Tag not recognized" });
      }

      if (!batchLogs[busKey]) batchLogs[busKey] = [];
      batchLogs[busKey].push(logData);
      console.log(`Logged tag ${tagId} for bus ${busKey}`);
    }

    // Push updates to Firebase
    if (Object.keys(updates).length > 0) {
      await db.ref().update(updates);
      console.log(`Firebase updated for bus ${busKey}`);
    }

    res.status(200).json({ message: "RFID/GPS scan processed ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Real-time ETA updates ---
const ETA_INTERVAL_MS = 5000; // every 5 seconds
setInterval(async () => {
  try {
    for (const readerUsername in lastBusState) {
      const busLoc = lastBusState[readerUsername];
      if (!busLoc) continue;

      // Find busKey
      const busesSnap = await db.ref("buses").orderByChild("rfidReaderUsername").equalTo(readerUsername).once("value");
      if (!busesSnap.exists()) continue;

      let busKey;
      busesSnap.forEach(snap => { busKey = snap.key; });

      // Get all students currently assigned to this bus
      const allStudentsSnap = await db.ref("students").once("value");
      const students = [];
      allStudentsSnap.forEach(snap => {
        const s = snap.val();
        if (s.lastBusId === busKey) {
          students.push({
            studentId: s.studentId,
            lastLat: s.lastLat || s.homeLat || 0,
            lastLng: s.lastLng || s.homeLng || 0,
            lastStatus: s.lastStatus || "check-in"
          });
        }
      });

      if (students.length === 0) continue;

      // Call Flask ETA API
      const etaResults = await getETA(busLoc.lat, busLoc.lng, busLoc.speed, busLoc.heading, students);

      // Write ETAs back to Firebase
      for (const sid in etaResults) {
        const eta = etaResults[sid];
        const studentSnap = await db.ref("students").orderByChild("studentId").equalTo(sid).once("value");
        if (studentSnap.exists()) {
          let studentKey;
          studentSnap.forEach(snap => { studentKey = snap.key; });
          await db.ref(`students/${studentKey}/ETA`).set(eta);
        }
      }

      console.log(`Updated ETAs for bus ${busKey}`);
    }
  } catch (err) {
    console.error("Error updating real-time ETAs:", err.message);
  }
}, ETA_INTERVAL_MS);

// --- Function to call Flask ETA API ---
async function getETA(busLat, busLng, speed, heading, students) {
  try {
    const response = await axios.post(`${process.env.FLASK_ETA_API}/predict`, {
      busLat,
      busLng,
      speed,
      heading,
      students
    });
    return response.data; // { studentId: ETA_in_sec, ... }
  } catch (err) {
    console.error("Flask ETA API error:", err.message);
    return {};
  }
}

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
