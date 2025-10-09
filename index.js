// index.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY); // your Firebase Admin SDK key

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ruhire-default-rtdb.firebaseio.com/" // 🔥 change this
});

const db = admin.database();
const app = express();

app.use(cors());
app.use(bodyParser.json());

// Health check
app.get("/", (req, res) => {
  res.send("IoT Bus RTDB Backend is live 🚀");
});

// RFID scan endpoint
app.post("/rfid-scan", async (req, res) => {
  try {
    const { tagId, readerUsername, location, speed } = req.body;

    if (!tagId || !readerUsername) {
      return res.status(400).json({ error: "Missing tagId or readerUsername" });
    }

    const busesRef = db.ref("buses");
    const studentsRef = db.ref("students");
    const driversRef = db.ref("drivers");
    const logsRef = db.ref("logs");

    // Find bus with this RFID reader username
    const busesSnap = await busesRef
      .orderByChild("rfidReaderUsername")
      .equalTo(readerUsername)
      .once("value");

    if (!busesSnap.exists()) {
      return res.status(404).json({ error: "Bus not found for this reader" });
    }

    let busKey, busData;
    busesSnap.forEach((snap) => {
      busKey = snap.key;
      busData = snap.val();
    });

    // 1️⃣ Check if tag belongs to a student
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

      // Determine check-in / check-out
      const newStatus =
        studentData.lastStatus === "check-in" ? "check-out" : "check-in";

      // Add log
      const logData = {
        studentName: studentData.name || "",
        studentId: tagId,
        busId: busKey,
        busName: busData.plateNumber || "",
        driverName: busData.driverName || "",
        driverPhone: busData.driverPhone || "",
        status: newStatus,
        timestamp: Date.now(),
        location: location || null,
        speed: speed || 0,
      };
      await logsRef.push(logData);

      // Update student last status
      await studentsRef.child(studentKey).update({
        lastStatus: newStatus,
      });

      // Update bus GPS and speed
      const updates = {};
      if (location && typeof location.lat === "number" && typeof location.lng === "number") {
        updates.latitude = location.lat;
        updates.longitude = location.lng;
      }
      if (typeof speed === "number") updates.speed = speed;

      await busesRef.child(busKey).update(updates);

      return res.status(200).json({ message: "Student log recorded successfully" });
    }

    // 2️⃣ Check if tag belongs to a driver
    const driverSnap = await driversRef
      .orderByChild("driverId")
      .equalTo(tagId)
      .once("value");

    if (driverSnap.exists()) {
      let driverKey, driverData;
      driverSnap.forEach((snap) => {
        driverKey = snap.key;
        driverData = snap.val();
      });

      // Associate driver with bus
      await busesRef.child(busKey).update({
        driverId: driverKey,
        driverName: driverData.name || "",
        driverPhone: driverData.phone || "",
      });

      // Update driver with current bus reader
      await driversRef.child(driverKey).update({
        currentBusReaderUsername: readerUsername,
      });

      return res.status(200).json({
        message: "Driver associated with bus successfully",
        driverId: driverKey,
        busId: busKey,
      });
    }

    // Tag not recognized
    return res.status(404).json({ error: "Tag not recognized" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
