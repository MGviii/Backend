const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const axios = require("axios"); // NEW: For calling Python ML service

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ruhire-default-rtdb.firebaseio.com/"
});

const db = admin.database();
const app = express();
app.use(cors());
app.use(bodyParser.json());

// NEW: Python ML Service Configuration
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "https://ruhire-ml-service.onrender.com";
const ML_SERVICE_TIMEOUT = 5000; // 5 seconds timeout

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

// ==================== NEW: ML PREDICTION FUNCTIONS ====================

/**
 * Call Python ML service for ETA prediction
 */
async function callMLPrediction(studentId, busLocation, studentDestination, gpsHistory, emergencyActive = false) {
  try {
    const response = await axios.post(
      `${ML_SERVICE_URL}/api/predict-eta`,
      {
        student_id: studentId,
        bus_location: busLocation,
        student_destination: studentDestination,
        gps_history: gpsHistory,
        emergency_active: emergencyActive
      },
      {
        timeout: ML_SERVICE_TIMEOUT,
        headers: { "Content-Type": "application/json" }
      }
    );

    if (response.data.success) {
      console.log(`✓ ML Prediction for student ${studentId}: ${response.data.prediction.eta_minutes} min`);
      return response.data.prediction;
    } else {
      throw new Error(response.data.error || "Prediction failed");
    }
  } catch (error) {
    console.error(`✗ ML Service Error for student ${studentId}:`, error.message);
    // Return fallback prediction
    return getFallbackPrediction(busLocation, studentDestination);
  }
}

/**
 * Fallback prediction if ML service is unavailable
 */
function getFallbackPrediction(busLocation, studentDestination) {
  const distance = calculateDistance(
    busLocation.lat,
    busLocation.lng,
    studentDestination.lat,
    studentDestination.lng
  );

  const avgSpeed = 20; // km/h
  const minutes = Math.round((distance / avgSpeed) * 60);
  const now = new Date();
  const arrival = new Date(now.getTime() + minutes * 60000);

  return {
    eta_minutes: Math.max(1, minutes),
    eta_seconds: Math.max(60, minutes * 60),
    eta_range_min: Math.max(1, Math.round(minutes * 0.7)),
    eta_range_max: Math.round(minutes * 1.5),
    confidence_percent: 50,
    current_speed_kmh: 20,
    distance_remaining_km: parseFloat(distance.toFixed(2)),
    traffic_status: "Unknown",
    emergency_active: false,
    estimated_arrival_time: arrival.toTimeString().split(" ")[0],
    model_type: "fallback"
  };
}

/**
 * Calculate distance using Haversine formula
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Update ETA prediction for a specific student
 */
async function updateStudentETA(studentId, busId) {
  try {
    // Get student data
    const studentSnap = await db.ref(`students/${studentId}`).once("value");
    const student = studentSnap.val();

    if (!student || student.lastStatus !== "check-in") {
      return; // Student not on bus
    }

    // Get bus current location
    const busLocationSnap = await db.ref(`busLocations/${busId}/current`).once("value");
    const busLocation = busLocationSnap.val();

    if (!busLocation) {
      console.log(`No location data for bus ${busId}`);
      return;
    }

    // Get GPS history (last 10 minutes)
    const historySnap = await db.ref(`busLocations/${busId}/history`).once("value");
    const gpsHistory = historySnap.val() || {};

    // Get student destination (geocoded address)
    // TODO: Implement geocoding for student address
    // For now, using a placeholder destination
    const studentDestination = {
      lat: parseFloat(student.homeLatitude || -1.9579),
      lng: parseFloat(student.homeLongitude || 30.091)
    };

    // Get bus data for emergency status
    const busSnap = await db.ref(`buses/${busId}`).once("value");
    const bus = busSnap.val();
    const readerUsername = bus?.rfidReaderUsername;

    // Check emergency status
    const emergencySnap = await db.ref(`Emergency/${readerUsername}`).once("value");
    const emergencyData = emergencySnap.val();
    const emergencyActive = emergencyData?.emergency || false;

    // Prepare bus location for ML service
    const busLoc = {
      lat: busLocation.Latitude,
      lng: busLocation.Longitude,
      heading: busLocation.Heading || 0,
      satellites: busLocation.Satellites || 0
    };

    // Call ML service
    const prediction = await callMLPrediction(
      studentId,
      busLoc,
      studentDestination,
      gpsHistory,
      emergencyActive
    );

    // Store prediction in Firebase
    await db.ref(`predictions/${studentId}`).set({
      ...prediction,
      student_name: student.name,
      student_id: studentId,
      bus_id: busId,
      bus_plate: bus?.plateNumber,
      updated_at: Date.now()
    });

    console.log(`✓ Updated ETA for ${student.name}: ${prediction.eta_minutes} min`);
    return prediction;
  } catch (error) {
    console.error(`Error updating student ETA:`, error.message);
  }
}

/**
 * Update ETAs for all students on a specific bus
 */
async function updateETAsForBus(busId) {
  try {
    const studentsSnap = await db.ref("students")
      .orderByChild("lastBusId")
      .equalTo(busId)
      .once("value");

    const students = studentsSnap.val();
    if (!students) return;

    const promises = [];
    Object.keys(students).forEach(studentId => {
      const student = students[studentId];
      if (student.lastStatus === "check-in") {
        promises.push(updateStudentETA(studentId, busId));
      }
    });

    await Promise.all(promises);
    console.log(`✓ Updated ETAs for ${promises.length} students on bus ${busId}`);
  } catch (error) {
    console.error("Error updating ETAs for bus:", error.message);
  }
}

/**
 * Clear prediction when student checks out
 */
async function clearStudentPrediction(studentId) {
  try {
    await db.ref(`predictions/${studentId}`).remove();
    console.log(`✓ Cleared prediction for student ${studentId}`);
  } catch (error) {
    console.error(`Error clearing prediction:`, error.message);
  }
}

// ==================== BACKGROUND ETA UPDATE SERVICE ====================

/**
 * Update all active student ETAs every 30 seconds
 */
function startETAUpdateService() {
  console.log("✓ ETA Update Service started (updates every 30 seconds)");

  setInterval(async () => {
    try {
      // Get all buses
      const busesSnap = await db.ref("buses").once("value");
      const buses = busesSnap.val();

      if (!buses) return;

      const promises = [];
      Object.keys(buses).forEach(busId => {
        promises.push(updateETAsForBus(busId));
      });

      await Promise.all(promises);
    } catch (error) {
      console.error("Error in ETA update service:", error.message);
    }
  }, 30000); // Every 30 seconds
}

// ==================== EXISTING ENDPOINTS ====================

// Health check
app.get("/", (_, res) => res.send("IoT Bus RTDB Backend is live 🚀"));

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
    if (!busesSnap.exists()) {
      console.log("Bus not found for readerUsername:", readerUsername);
      return res.status(404).json({ error: "Bus not found" });
    }

    let busKey, busData;
    busesSnap.forEach(snap => { busKey = snap.key; busData = snap.val(); });
    console.log(`Bus found: ${busKey}`);

    const updates = {};
    const timestamp = Date.now();

    const lat = Latitude || (location && location.lat);
    const lng = Longitude || (location && location.lng);

    // ----------------------
    // Update busLocations only
    // ----------------------
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
      console.log(`Updated bus location for ${busKey}`);
    }

    // ----------------------
    // Emergency handling (UPDATED)
    // ----------------------
    if (emergency === true && lat != null && lng != null) {
      await emergencyRef.child(readerUsername).set({
        readerUsername,
        emergency: true,
        location: { lat, lng }
      });
      console.log(`Emergency logged for ${readerUsername}`);

      // NEW: Update ETAs with emergency status
      updateETAsForBus(busKey).catch(err => 
        console.error("Error updating ETAs after emergency:", err)
      );
    }

    // ----------------------
    // RFID / Tag handling (UPDATED)
    // ----------------------
    let studentCheckedIn = false;
    let studentCheckedOut = false;
    let affectedStudentId = null;

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

        // NEW: Track check-in/check-out for ETA updates
        affectedStudentId = studentKey;
        if (newStatus === "check-in") {
          studentCheckedIn = true;
        } else if (newStatus === "check-out") {
          studentCheckedOut = true;
        }

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

    // ----------------------
    // Push updates to Firebase
    // ----------------------
    if (Object.keys(updates).length > 0) {
      await db.ref().update(updates);
      console.log(`Firebase updated for bus ${busKey}`);
    }

    // ----------------------
    // NEW: Handle ETA Predictions
    // ----------------------
    if (studentCheckedIn && affectedStudentId) {
      // Student just checked in - start ETA predictions
      updateStudentETA(affectedStudentId, busKey).catch(err =>
        console.error("Error starting ETA prediction:", err)
      );
    } else if (studentCheckedOut && affectedStudentId) {
      // Student just checked out - clear predictions
      clearStudentPrediction(affectedStudentId).catch(err =>
        console.error("Error clearing prediction:", err)
      );
    } else if (lat != null && lng != null) {
      // GPS update - update all ETAs for this bus
      updateETAsForBus(busKey).catch(err =>
        console.error("Error updating ETAs after GPS update:", err)
      );
    }

    res.status(200).json({ message: "RFID/GPS scan processed ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ==================== NEW: ETA-SPECIFIC ENDPOINTS ====================

/**
 * Get ETA for a specific student
 * GET /api/eta/:studentId
 */
app.get("/api/eta/:studentId", async (req, res) => {
  try {
    const { studentId } = req.params;

    const predictionSnap = await db.ref(`predictions/${studentId}`).once("value");
    const prediction = predictionSnap.val();

    if (!prediction) {
      return res.status(404).json({
        success: false,
        error: "No prediction available for this student"
      });
    }

    res.json({
      success: true,
      prediction
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get all active ETAs
 * GET /api/eta/all
 */
app.get("/api/eta/all", async (req, res) => {
  try {
    const predictionsSnap = await db.ref("predictions").once("value");
    const predictions = predictionsSnap.val() || {};

    res.json({
      success: true,
      predictions,
      count: Object.keys(predictions).length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Manually trigger ETA update for a student
 * POST /api/eta/update/:studentId
 */
app.post("/api/eta/update/:studentId", async (req, res) => {
  try {
    const { studentId } = req.params;

    const studentSnap = await db.ref(`students/${studentId}`).once("value");
    const student = studentSnap.val();

    if (!student) {
      return res.status(404).json({
        success: false,
        error: "Student not found"
      });
    }

    const busId = student.lastBusId;
    if (!busId) {
      return res.status(400).json({
        success: false,
        error: "Student not assigned to any bus"
      });
    }

    const prediction = await updateStudentETA(studentId, busId);

    res.json({
      success: true,
      message: "ETA updated successfully",
      prediction
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Check ML service health
 * GET /api/ml-health
 */
app.get("/api/ml-health", async (req, res) => {
  try {
    const response = await axios.get(`${ML_SERVICE_URL}/health`, {
      timeout: 5000
    });

    res.json({
      success: true,
      ml_service: response.data
    });
  } catch (error) {
    res.json({
      success: false,
      ml_service_error: error.message,
      note: "ML service is unavailable, using fallback predictions"
    });
  }
});

// ==================== START SERVICES ====================

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`ML Service URL: ${ML_SERVICE_URL}`);
  
  // Start background ETA update service
  startETAUpdateService();
});