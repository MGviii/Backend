
const express = require("express");
const app = express();  // <--- THIS
const cors = require("cors");
const bodyParser = require("body-parser");

app.use(cors());

app.use(bodyParser.json());app.post("https://eta-service.onrender.com/rfid-scan", async (req, res) => {
  const {
    tagId,
    readerUsername,
    location,
    speed,
    emergency,
    heading,
    altitude,
    satellites,
    accuracy,
    fixQuality
  } = req.body;

  if (!readerUsername)
    return res.status(400).json({ error: "Missing readerUsername" });

  try {
    const busesRef = db.ref("buses");
    const studentsRef = db.ref("students");
    const driversRef = db.ref("drivers");
    const busLocationsRef = db.ref("busLocations");
    const emergencyRef = db.ref("Emergency");

    const busesSnap = await busesRef
      .orderByChild("rfidReaderUsername")
      .equalTo(readerUsername)
      .once("value");

    if (!busesSnap.exists())
      return res.status(404).json({ error: "Bus not found" });

    let busKey, busData;
    busesSnap.forEach((snap) => {
      busKey = snap.key;
      busData = snap.val();
    });

    const updates = {};
    const timestamp = Date.now();

    // ------------------------------------------------------
    // 🛰️ GPS Update
    // ------------------------------------------------------
    if (location) {
      const speedMs = speed ? speed / 3.6 : 0;

      updates[`buses/${busKey}/latitude`] = location.lat;
      updates[`buses/${busKey}/longitude`] = location.lng;

      lastBusState[readerUsername] = { lat: location.lat, lng: location.lng };

      const locData = {
        latitude: location.lat,
        longitude: location.lng,
        altitude: altitude || null,
        speed: speedMs,
        heading: heading || null,
        timestamp,
        satellites: satellites || null,
        accuracy: accuracy || null,
        fixQuality: fixQuality || null
      };

      updates[`busLocations/${busKey}/current`] = locData;
      updates[`busLocations/${busKey}/history/${timestamp}`] = locData;

      // prune old history asynchronously
      (async () => {
        try {
          const HISTORY_LIMIT = 500;
          const ONE_DAY = 24 * 60 * 60 * 1000;
          const cutoff = Date.now() - ONE_DAY;
          const historySnap = await busLocationsRef
            .child(`${busKey}/history`)
            .once("value");
          const historyData = historySnap.val() || {};
          const timestamps = Object.keys(historyData).sort((a, b) => a - b);
          const pruneUpdates = {};
          for (const ts of timestamps)
            if (Number(ts) < cutoff) pruneUpdates[ts] = null;
          if (timestamps.length > HISTORY_LIMIT) {
            timestamps
              .slice(0, timestamps.length - HISTORY_LIMIT)
              .forEach((t) => (pruneUpdates[t] = null));
          }
          if (Object.keys(pruneUpdates).length > 0)
            await busLocationsRef.child(`${busKey}/history`).update(pruneUpdates);
        } catch (err) {
          console.error("Async pruning error:", err);
        }
      })();
    }

    // ------------------------------------------------------
    // 🚨 Emergency Handling
    // ------------------------------------------------------
    if (emergency === true) {
      await emergencyRef.child(readerUsername).set({
        readerUsername,
        location: location || null,
        emergency: true,
        timestamp
      });
    }

    // ------------------------------------------------------
    // 🏷️ RFID Handling (Student or Driver)
    // ------------------------------------------------------
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
        location: location || null
      };

      const [studentsSnap, driversSnap] = await Promise.all([
        studentsRef.orderByChild("studentId").equalTo(tagId).once("value"),
        driversRef.orderByChild("driverId").equalTo(tagId).once("value")
      ]);

      // ------------------------
      // 👩‍🎓 Student RFID Scan
      // ------------------------
      if (studentsSnap.exists()) {
        let studentKey, studentData;
        studentsSnap.forEach((snap) => {
          studentKey = snap.key;
          studentData = snap.val();
        });

        const lastBusId = studentData.lastBusId || null;
        const lastStatus = studentData.lastStatus || "check-out";

        // Toggle between check-in & check-out
        let newStatus =
          lastStatus === "check-in" && lastBusId === busKey
            ? "check-out"
            : lastStatus === "check-in"
            ? null
            : "check-in";

        if (!newStatus)
          return res.status(400).json({
            error: "Student is already checked in on another bus",
            studentId: tagId,
            lastBusId
          });

        logData.studentName = studentData.name || "";
        logData.status = newStatus;

        updates[`students/${studentKey}/lastStatus`] = newStatus;
        updates[`students/${studentKey}/lastBusId`] = busKey;

        // -------------------------------
        // 🧠 ETA Prediction Integration
        // -------------------------------
        if (location && lastBusState[readerUsername]) {
          const busLoc = lastBusState[readerUsername];

          // Compute distance (meters → km)
          const distance_m = require("geolib").getDistance(
            { latitude: busLoc.lat, longitude: busLoc.lng },
            { latitude: location.lat, longitude: location.lng }
          );
          const distance_km = distance_m / 1000;

          // Convert IoT m/s → km/h
          const speed_kmh = speed ? speed : 0;

          try {
            const etaResp = await axios.post(
              "http://localhost:8000/predict_eta", // Change to Render URL when deployed
              {
                distance_km,
                speed_kmh,
                status: newStatus === "check-in" ? 1 : 0
              }
            );

            logData.eta_minutes = etaResp.data.eta_minutes;
            updates[`students/${studentKey}/eta`] = etaResp.data.eta_minutes;
          } catch (err) {
            console.error("ETA service error:", err.message);
            logData.eta_minutes = null;
          }
        }

        // -------------------------------
        // 🗃️ Batch Logging
        // -------------------------------
        if (!batchLogs[busKey]) batchLogs[busKey] = [];
        batchLogs[busKey].push(logData);
      }

      // ------------------------
      // 🧍 Driver RFID Scan
      // ------------------------
      else if (driversSnap.exists()) {
        let driverKey, driverData;
        driversSnap.forEach((snap) => {
          driverKey = snap.key;
          driverData = snap.val();
        });

        updates[`buses/${busKey}/driverId`] = driverKey;
        updates[`buses/${busKey}/driverName`] = driverData.name || "";
        updates[`buses/${busKey}/driverPhone`] = driverData.phone || "";
        updates[
          `drivers/${driverKey}/currentBusReaderUsername`
        ] = readerUsername;

        logData.driverName = driverData.name || "";
        logData.driverPhone = driverData.phone || "";
      } else {
        return res.status(404).json({ error: "Tag not recognized" });
      }
    }

    // ------------------------------------------------------
    // 💾 Apply Firebase Updates
    // ------------------------------------------------------
    if (Object.keys(updates).length > 0) {
      await db.ref().update(updates);
    }

    res.status(200).json({ message: "Update processed successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});
