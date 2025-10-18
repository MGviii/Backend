const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const geolib = require("geolib");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ruhire-default-rtdb.firebaseio.com/"
});

const db = admin.database();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const lastBusState = {}; // { [readerUsername]: { lat, lng } }
const batchLogsFile = path.join(__dirname, "batchLogs.json");
let batchLogs = {};

// Load persisted batch logs
if (fs.existsSync(batchLogsFile)) {
  try {
    batchLogs = JSON.parse(fs.readFileSync(batchLogsFile));
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
      } catch (err) {
        logsArray.unshift(log);
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

// RFID scan endpoint
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
    const busLocationsRef = db.ref("busLocations");
    const emergencyRef = db.ref("Emergency");

    // Find the bus
    const busesSnap = await busesRef.orderByChild("rfidReaderUsername").equalTo(readerUsername).once("value");
    if (!busesSnap.exists()) return res.status(404).json({ error: "Bus not found" });

    let busKey, busData;
    busesSnap.forEach(snap => { busKey = snap.key; busData = snap.val(); });

    const updates = {};
    const timestamp = Date.now();
    let eta_minutes = null;

    // Determine GPS coordinates
    const lat = Latitude || (location && location.lat);
    const lng = Longitude || (location && location.lng);
    const speedMs = Speed ? Speed / 3.6 : 0;

    // Update bus locations if GPS is present
    if (lat != null && lng != null) {
      lastBusState[readerUsername] = { lat, lng };

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

      updates[`busLocations/${busKey}/current`] = locData;
      updates[`busLocations/${busKey}/history/${timestamp}`] = locData;

      // Async prune old history
      (async () => {
        try {
          const HISTORY_LIMIT = 500;
          const ONE_DAY = 24 * 60 * 60 * 1000;
          const cutoff = Date.now() - ONE_DAY;
          const historySnap = await busLocationsRef.child(`${busKey}/history`).once("value");
          const historyData = historySnap.val() || {};
          const timestamps = Object.keys(historyData).sort((a, b) => a - b);
          const pruneUpdates = {};
          for (const ts of timestamps) if (Number(ts) < cutoff) pruneUpdates[ts] = null;
          if (timestamps.length > HISTORY_LIMIT) timestamps.slice(0, timestamps.length - HISTORY_LIMIT).forEach(t => pruneUpdates[t] = null);
          if (Object.keys(pruneUpdates).length > 0) await busLocationsRef.child(`${busKey}/history`).update(pruneUpdates);
        } catch (err) { console.error("Async pruning error:", err); }
      })();
    }

    // Emergency handling
    if (emergency === true && lat != null && lng != null) {
      await emergencyRef.child(readerUsername).set({
        readerUsername,
        emergency: true,
        location: { lat, lng },
        timestamp
      });
    }

    // RFID / Tag handling
    if (tagId) {
      let logData = {
        busId: busKey,
        busName: busData.plateNumber || "",
        driverName: busData.driverName || "",
        driverPhone: busData.driverPhone || "",
        tagId,
        status: null,
        studentName: null,
        timestamp,
        location: { lat, lng },
        Latitude: lat,
        Longitude: lng,
        Altitude: Altitude || null,
        Speed: Speed || 0,
        Heading: Heading || null,
        Satellites: Satellites || null,
        Date: dateStr || null,
        "Time (UTC)": timeStr || null
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

        // ✅ Call ETA only if useful
        if (
          lat != null && lng != null &&
          lastBusState[readerUsername] &&
          newStatus // valid check-in/out
        ) {
          const busLoc = lastBusState[readerUsername];
          const distance_m = geolib.getDistance(
            { latitude: busLoc.lat, longitude: busLoc.lng },
            { latitude: lat, longitude: lng }
          );
          const distance_km = distance_m / 1000;
          const speed_kmh = Speed || 0;

          try {
            const etaResp = await axios.post(process.env.ETA_SERVICE_URL || "https://eta-service.onrender.com/predict_eta", {
              distance_km,
              speed_kmh,
              status: newStatus === "check-in" ? 1 : 0
            });
            eta_minutes = etaResp.data.eta_minutes;
            updates[`students/${studentKey}/eta`] = eta_minutes;
          } catch (err) {
            console.error("ETA service error:", err.message);
          }
        }

      } else if (driversSnap.exists()) {
        let driverKey, driverData;
        driversSnap.forEach(snap => { driverKey = snap.key; driverData = snap.val(); });
        updates[`buses/${busKey}/driverId`] = driverKey;
        updates[`buses/${busKey}/driverName`] = driverData.name || "";
        updates[`buses/${busKey}/driverPhone`] = driverData.phone || "";
        updates[`drivers/${driverKey}/currentBusReaderUsername`] = readerUsername;
        logData.driverName = driverData.name || "";
        logData.driverPhone = driverData.phone || "";
      } else {
        return res.status(404).json({ error: "Tag not recognized" });
      }

      if (!batchLogs[busKey]) batchLogs[busKey] = [];
      batchLogs[busKey].push(logData);
    }

    // Push updates to Firebase
    if (Object.keys(updates).length > 0) await db.ref().update(updates);

    res.status(200).json({ message: "RFID/GPS scan processed ✅", eta_minutes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));