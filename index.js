const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

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

// Load persisted batch logs if file exists
if (fs.existsSync(batchLogsFile)) {
  try {
    batchLogs = JSON.parse(fs.readFileSync(batchLogsFile));
  } catch (err) {
    console.error("Error reading batchLogs.json:", err);
    batchLogs = {};
  }
}

const GPS_THRESHOLD = 0.00005; // ~5 meters

function hasLocationChanged(oldLoc, newLoc) {
  if (!oldLoc || !newLoc) return true;
  return Math.abs(oldLoc.lat - newLoc.lat) > GPS_THRESHOLD ||
         Math.abs(oldLoc.lng - newLoc.lng) > GPS_THRESHOLD;
}

// Batch push logs every 2 seconds
setInterval(async () => {
  const logsRef = db.ref("logs");
  for (const busKey in batchLogs) {
    const logsArray = batchLogs[busKey];
    while (logsArray.length > 0) {
      const log = logsArray.shift();
      try { await logsRef.push(log); } 
      catch (err) { logsArray.unshift(log); break; }
    }
  }
  try { fs.writeFileSync(batchLogsFile, JSON.stringify(batchLogs, null, 2)); }
  catch (err) { console.error("Error writing batchLogs.json:", err); }
}, 2000);

app.get("/", (_, res) => res.send("IoT Bus RTDB Backend is live 🚀"));

app.post("/rfid-scan", async (req, res) => {
  const { tagId, readerUsername, location, speed, emergency } = req.body;
  if (!readerUsername) return res.status(400).json({ error: "Missing readerUsername" });

  try {
    const busesRef = db.ref("buses");
    const studentsRef = db.ref("students");
    const driversRef = db.ref("drivers");
    const busLocationsRef = db.ref("busLocations");
    const emergencyRef = db.ref("Emergency");

    const busesSnap = await busesRef.orderByChild("rfidReaderUsername").equalTo(readerUsername).once("value");
    if (!busesSnap.exists()) return res.status(404).json({ error: "Bus not found" });

    let busKey, busData;
    busesSnap.forEach(snap => { busKey = snap.key; busData = snap.val(); });

    const lastState = lastBusState[readerUsername] || {};
    const locationChanged = hasLocationChanged(lastState, location);

    // Only proceed if meaningful update exists
    if (!tagId && !locationChanged && emergency !== true) {
      return res.status(200).json({ message: "No update needed" });
    }

    const updates = {};

    // Update bus location only if changed
    if (locationChanged && location) {
      updates[`buses/${busKey}/latitude`] = location.lat;
      updates[`buses/${busKey}/longitude`] = location.lng;

      lastBusState[readerUsername] = { lat: location.lat, lng: location.lng };

      const timestamp = Date.now();
      const locData = {
        latitude: location.lat,
        longitude: location.lng,
        altitude: location.altitude || null,
        speed: speed || 0,
        heading: location.heading || null,
        timestamp,
        satellites: location.satellites || null,
        accuracy: location.accuracy || null,
        fixQuality: location.fixQuality || null
      };
      updates[`busLocations/${busKey}/current`] = locData;
      updates[`busLocations/${busKey}/history/${timestamp}`] = {
        latitude: location.lat,
        longitude: location.lng,
        speed: speed || 0,
        heading: location.heading || null,
        timestamp
      };

      // Async pruning
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
          if (timestamps.length > HISTORY_LIMIT) {
            timestamps.slice(0, timestamps.length - HISTORY_LIMIT).forEach(t => pruneUpdates[t] = null);
          }
          if (Object.keys(pruneUpdates).length > 0)
            await busLocationsRef.child(`${busKey}/history`).update(pruneUpdates);
        } catch (err) { console.error("Async pruning error:", err); }
      })();
    }

    // Emergency updates go separately
    if (emergency === true) {
      await emergencyRef.child(readerUsername).set({
        readerUsername,
        location: location || null,
        emergency: true,
        timestamp: Date.now()
      });
    }

    // Handle student/driver tag scans
    if (tagId) {
      const timestamp = Date.now();
      let logData = {
        busId: busKey,
        busName: busData.plateNumber || "",
        driverName: busData.driverName || "",
        driverPhone: busData.driverPhone || "",
        tagId,
        status: null,
        studentName: null,
        timestamp,
        location: location || null
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
        let newStatus = (lastStatus === "check-in" && lastBusId === busKey) ? "check-out" :
                        (lastStatus === "check-in") ? null : "check-in";

        if (!newStatus) return res.status(400).json({
          error: "Student is already checked in on another bus",
          studentId: tagId,
          lastBusId
        });

        logData.studentName = studentData.name || "";
        logData.status = newStatus;

        updates[`students/${studentKey}/lastStatus`] = newStatus;
        updates[`students/${studentKey}/lastBusId`] = busKey;

      } else if (driversSnap.exists()) {
        let driverKey, driverData;
        driversSnap.forEach(snap => { driverKey = snap.key; driverData = snap.val(); });

        updates[`buses/${busKey}/driverId`] = driverKey;
        updates[`buses/${busKey}/driverName`] = driverData.name || "";
        updates[`buses/${busKey}/driverPhone`] = driverData.phone || "";
        updates[`drivers/${driverKey}/currentBusReaderUsername`] = readerUsername;

        logData.driverName = driverData.name || "";
        logData.driverPhone = driverData.phone || "";

      } else return res.status(404).json({ error: "Tag not recognized" });

      // Batch logs
      if (!batchLogs[busKey]) batchLogs[busKey] = [];
      batchLogs[busKey].push(logData);
    }

    // Apply updates atomically if any
    if (Object.keys(updates).length > 0) {
      await db.ref().update(updates);
    }

    res.status(200).json({ message: "Update processed successfully" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
