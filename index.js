// index.js
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

const lastBusState = {}; // { [readerUsername]: { lat, lng, speed, emergency } }
const batchLogsFile = path.join(__dirname, "batchLogs.json");
let batchLogs = {};

// Load persisted batch logs if file exists
if (fs.existsSync(batchLogsFile)) {
  try {
    const data = fs.readFileSync(batchLogsFile);
    batchLogs = JSON.parse(data);
  } catch (err) {
    console.error("Error reading batchLogs.json:", err);
    batchLogs = {};
  }
}

const GPS_THRESHOLD = 0.00005; // ~5 meters

function hasLocationChanged(oldLoc, newLoc) {
  if (!oldLoc || !newLoc) return true;
  const latDiff = Math.abs(oldLoc.lat - newLoc.lat);
  const lngDiff = Math.abs(oldLoc.lng - newLoc.lng);
  return latDiff > GPS_THRESHOLD || lngDiff > GPS_THRESHOLD;
}

// Batch push logs every 1 second
setInterval(async () => {
  const logsRef = db.ref("logs");
  for (const busKey in batchLogs) {
    const logsArray = batchLogs[busKey];
    while (logsArray.length > 0) {
      const log = logsArray.shift();
      try {
        await logsRef.push(log);
      } catch (err) {
        console.error("Error pushing log to Firebase:", err);
        // Push back to array and break to retry later
        logsArray.unshift(log);
        break;
      }
    }
  }
  // Save remaining batch logs to file
  try {
    fs.writeFileSync(batchLogsFile, JSON.stringify(batchLogs, null, 2));
  } catch (err) {
    console.error("Error writing batchLogs.json:", err);
  }
}, 1000);

app.get("/", (req, res) => {
  res.send("IoT Bus RTDB Backend is live 🚀");
});

app.post("/rfid-scan", async (req, res) => {
  try {
    const { tagId, readerUsername, location, speed, emergency } = req.body;

    if (!readerUsername) {
      return res.status(400).json({ error: "Missing readerUsername" });
    }

    const busesRef = db.ref("buses");
    const studentsRef = db.ref("students");
    const driversRef = db.ref("drivers");

    const busesSnap = await busesRef
      .orderByChild("rfidReaderUsername")
      .equalTo(readerUsername)
      .once("value");

    if (!busesSnap.exists()) {
      return res.status(404).json({ error: "Bus not found" });
    }

    let busKey, busData;
    busesSnap.forEach((snap) => {
      busKey = snap.key;
      busData = snap.val();
    });

    const lastState = lastBusState[readerUsername] || {};
    const locationChanged = hasLocationChanged(lastState, location);
    const speedChanged = lastState.speed !== speed;
    const emergencyChanged = lastState.emergency !== emergency;

    if (tagId || locationChanged || speedChanged || emergencyChanged) {
      const busUpdates = {};
      if (locationChanged && location) {
        busUpdates.latitude = location.lat;
        busUpdates.longitude = location.lng;
      }
      if (speedChanged && typeof speed === "number") busUpdates.speed = speed;
      if (emergencyChanged && typeof emergency === "boolean") busUpdates.emergency = emergency;

      await busesRef.child(busKey).update(busUpdates);

      lastBusState[readerUsername] = {
        lat: location?.lat,
        lng: location?.lng,
        speed,
        emergency
      };

      const logData = {
        busId: busKey,
        busName: busData.plateNumber || "",
        driverName: busData.driverName || "",
        driverPhone: busData.driverPhone || "",
        tagId: tagId || null,
        status: null,
        studentName: null,
        timestamp: Date.now(),
        location: location || null,
        speed: speed || 0,
        emergency: emergency || false
      };

      if (tagId) {
        const studentsSnap = await studentsRef
          .orderByChild("studentId")
          .equalTo(tagId)
          .once("value");

        if (studentsSnap.exists()) {
          let studentKey, studentData;
          studentsSnap.forEach((snap) => {
            studentKey = snap.key;
            studentData = snap.val();
          });

          const lastBusId = studentData.lastBusId || null;
          const lastStatus = studentData.lastStatus || "check-out";
          let newStatus;

          if (lastStatus === "check-in") {
            if (lastBusId === busKey) {
              newStatus = "check-out";
            } else {
              return res.status(400).json({
                error: "Student is already checked in on another bus",
                studentId: tagId,
                lastBusId: lastBusId
              });
            }
          } else {
            newStatus = "check-in";
          }

          logData.studentName = studentData.name || "";
          logData.status = newStatus;
          logData.tagId = tagId;

          await studentsRef.child(studentKey).update({
            lastStatus: newStatus,
            lastBusId: busKey
          });

        } else {
          const driversSnap = db.ref("drivers");
          const driverSnap = await driversSnap
            .orderByChild("driverId")
            .equalTo(tagId)
            .once("value");

          if (driverSnap.exists()) {
            let driverKey, driverData;
            driverSnap.forEach((snap) => {
              driverKey = snap.key;
              driverData = snap.val();
            });

            await busesRef.child(busKey).update({
              driverId: driverKey,
              driverName: driverData.name || "",
              driverPhone: driverData.phone || "",
            });

            await driversSnap.child(driverKey).update({
              currentBusReaderUsername: readerUsername,
            });

            logData.driverName = driverData.name || "";
            logData.driverPhone = driverData.phone || "";
          } else {
            return res.status(404).json({ error: "Tag not recognized" });
          }
        }
      }

      if (!batchLogs[busKey]) batchLogs[busKey] = [];
      batchLogs[busKey].push(logData);

      // Persist immediately to file to prevent loss
      try {
        fs.writeFileSync(batchLogsFile, JSON.stringify(batchLogs, null, 2));
      } catch (err) {
        console.error("Error writing batchLogs.json:", err);
      }
    }

    return res.status(200).json({ message: "Update processed successfully" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
