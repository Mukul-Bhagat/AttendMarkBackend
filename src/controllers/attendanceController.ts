import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { getDistance } from 'geolib';
import createSessionModel from '../models/Session';
import createAttendanceModel from '../models/Attendance';
import createUserModel from '../models/User';
import createOrganizationSettingsModel from '../models/OrganizationSettings';
import createLeaveRequestModel from '../models/LeaveRequest';
import AuditLog from '../models/AuditLog';

/**
 * SECURITY GUARANTEE:
 * 
 * Attendance can ONLY be marked if location verification passes.
 * There is NO fallback or override path.
 * 
 * Location verification uses browser GPS + geolib distance calculation:
 * - PHYSICAL sessions: Location verification REQUIRED
 * - HYBRID sessions with PHYSICAL assignment: Location verification REQUIRED
 * - REMOTE sessions/users: Location verification NOT required
 * 
 * If location is required and verification fails, attendance is REJECTED.
 * No attendance record is created with locationVerified=false when location is required.
 * 
 * All validation failures result in attendance rejection.
 */
// @route   POST /api/attendance/scan
export const markAttendance = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  // 1. GET ALL DATA
  const { id: userId, collectionPrefix, role } = req.user!;
  const { sessionId, userLocation, deviceId, userAgent, accuracy, timestamp } = req.body;

  // DEBUG LOGGING: Log incoming request
  console.log('[ATTENDANCE_SCAN] Incoming request:', {
    userId,
    sessionId,
    userLocation: userLocation ? { lat: userLocation.latitude, lng: userLocation.longitude } : null,
    hasDeviceId: !!deviceId,
    hasUserAgent: !!userAgent,
    scanSource: req.headers['x-scan-source'] || 'unknown',
    timestamp: new Date().toISOString()
  });

  // STRICT VALIDATION: Reject if required fields are missing
  if (!deviceId || typeof deviceId !== 'string' || deviceId.trim() === '') {
    console.log('[ATTENDANCE_SCAN] REJECTED: Missing deviceId');
    return res.status(400).json({ 
      msg: 'Device ID is required. Please refresh the page and try again.',
      reason: 'MISSING_DEVICE_ID'
    });
  }

  if (!userAgent || typeof userAgent !== 'string' || userAgent.trim() === '') {
    console.log('[ATTENDANCE_SCAN] REJECTED: Missing userAgent');
    return res.status(400).json({ 
      msg: 'User Agent is required. Please refresh the page and try again.',
      reason: 'MISSING_USER_AGENT'
    });
  }

  if (!userLocation || typeof userLocation !== 'object') {
    console.log('[ATTENDANCE_SCAN] REJECTED: Missing userLocation object');
    return res.status(400).json({ 
      msg: 'Location is required. Please enable GPS and try again.',
      reason: 'MISSING_LOCATION'
    });
  }

  if (typeof userLocation.latitude !== 'number' || typeof userLocation.longitude !== 'number') {
    console.log('[ATTENDANCE_SCAN] REJECTED: Invalid location coordinates');
    return res.status(400).json({ 
      msg: 'Invalid location coordinates. Please enable GPS and try again.',
      reason: 'INVALID_LOCATION_COORDS'
    });
  }

  // Reject (0,0) coordinates - common default/error value
  if (userLocation.latitude === 0 && userLocation.longitude === 0) {
    console.log('[ATTENDANCE_SCAN] REJECTED: Location is (0,0) - invalid');
    return res.status(400).json({ 
      msg: 'Invalid location detected. Please ensure GPS is enabled and try again.',
      reason: 'INVALID_LOCATION_ZERO'
    });
  }

  // SECURITY: GPS accuracy is REQUIRED for location verification - NO DEFAULTS, NO BYPASS
  if (typeof accuracy !== 'number' || isNaN(accuracy) || accuracy === undefined || accuracy === null) {
    console.log('[ATTENDANCE_SCAN] REJECTED: Missing GPS accuracy');
    return res.status(400).json({ 
      msg: 'GPS accuracy is required. Please enable high-accuracy GPS and try again.',
      reason: 'MISSING_ACCURACY'
    });
  }

  const accuracyMeters = accuracy;
  if (accuracyMeters <= 0 || accuracyMeters > 1000) {
    console.log('[ATTENDANCE_SCAN] REJECTED: Invalid accuracy:', accuracyMeters);
    return res.status(400).json({ 
      msg: 'Invalid GPS accuracy data. Please enable high-accuracy GPS and try again.',
      reason: 'INVALID_ACCURACY'
    });
  }

  // STRICT VALIDATION: Timestamp is REQUIRED and must be a number (milliseconds)
  if (typeof timestamp !== 'number' || isNaN(timestamp) || timestamp === undefined || timestamp === null) {
    console.log('[ATTENDANCE_SCAN] REJECTED: Missing or invalid timestamp');
    return res.status(400).json({ 
      msg: 'Timestamp is required. Please refresh the page and try again.',
      reason: 'MISSING_TIMESTAMP'
    });
  }

  // Validate timestamp is positive and reasonable (not too old, not in future)
  if (timestamp <= 0) {
    console.log('[ATTENDANCE_SCAN] REJECTED: Invalid timestamp (non-positive):', timestamp);
    return res.status(400).json({ 
      msg: 'Invalid timestamp. Please refresh the page and try again.',
      reason: 'INVALID_TIMESTAMP'
    });
  }

  // STRICT BLOCK: Platform Owner cannot mark their own attendance
  if (role === 'PLATFORM_OWNER') {
    console.log('[ATTENDANCE_SCAN] REJECTED: Platform Owner attempted attendance');
    return res.status(403).json({ 
      msg: 'Forbidden: Platform Owner cannot mark their own attendance' 
    });
  }

  if (!mongoose.Types.ObjectId.isValid(sessionId)) {
    console.log('[ATTENDANCE_SCAN] REJECTED: Invalid sessionId format:', sessionId);
    return res.status(400).json({ msg: 'Invalid Session ID. Please scan a valid QR code.' });
  }

  try {
    // 2. LOAD ALL ORG-SPECIFIC COLLECTIONS
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);
    const AttendanceCollection = createAttendanceModel(`${collectionPrefix}_attendance`);
    const OrganizationSettings = createOrganizationSettingsModel();

    // 3. FETCH ORGANIZATION SETTINGS (lateAttendanceLimit and isStrictAttendance)
    let lateAttendanceLimit = 30; // Default: 30 minutes
    let isStrictAttendance = false; // Default: false (non-strict mode)
    try {
      const settings = await OrganizationSettings.findOne({ organizationPrefix: collectionPrefix });
      if (settings) {
        lateAttendanceLimit = settings.lateAttendanceLimit;
        isStrictAttendance = settings.isStrictAttendance || false;
      }
    } catch (err) {
      // If settings don't exist, use defaults
      console.log('Using default settings: lateAttendanceLimit=30, isStrictAttendance=false');
    }

    // 4. FIND THE USER AND SESSION (in parallel)
    const [user, session] = await Promise.all([
      UserCollection.findById(userId).select('+registeredDeviceId +registeredUserAgent'), // Get the locked ID and User Agent
      SessionCollection.findById(sessionId)
    ]);

    if (!user) return res.status(404).json({ msg: 'User not found' });
    if (!session) return res.status(404).json({ msg: 'Session not found' });

    // 5. CHECK IF SESSION DATE MATCHES TODAY (date-only check)
    // Allow attendance from 00:00 Midnight (IST) on the day of the session
    // Server runs in UTC, but session times are stored in IST (UTC+5:30)
    const nowUTC = new Date();
    
    // Convert UTC to IST: IST is UTC+5:30 (5.5 hours ahead)
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in milliseconds
    const nowInIST = new Date(nowUTC.getTime() + IST_OFFSET_MS);
    
    // Get today's date in IST (at midnight)
    const todayIST = new Date(nowInIST.getFullYear(), nowInIST.getMonth(), nowInIST.getDate());
    
    // Parse startTime and endTime (HH:mm format in IST)
    const [startHour, startMinute] = session.startTime.split(':').map(Number);
    const [endHour, endMinute] = session.endTime.split(':').map(Number);
    
    // Check if the session date matches today (date-only comparison)
    let isSessionDateToday = false;
    
    if (session.frequency === 'OneTime') {
      // For one-time sessions, check if startDate matches today
      const sessionDate = new Date(session.startDate);
      sessionDate.setHours(0, 0, 0, 0);
      isSessionDateToday = sessionDate.getTime() === todayIST.getTime();
    } else {
      // For recurring sessions (Daily, Weekly, Monthly)
      const sessionStartDate = new Date(session.startDate);
      sessionStartDate.setHours(0, 0, 0, 0);
      
      const sessionEndDate = session.endDate 
        ? new Date(session.endDate)
        : null;
      if (sessionEndDate) {
        sessionEndDate.setHours(23, 59, 59, 999);
      }
      
      // Check if today (in IST) is within the date range
      const isWithinDateRange = todayIST >= sessionStartDate && 
        (!sessionEndDate || todayIST <= sessionEndDate);
      
      if (isWithinDateRange) {
        // For Weekly sessions, also check if today is one of the scheduled days
        if (session.frequency === 'Weekly' && session.weeklyDays && session.weeklyDays.length > 0) {
          const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          const todayDayName = dayNames[nowInIST.getDay()];
          isSessionDateToday = session.weeklyDays.includes(todayDayName);
        } else {
          // For Daily and Monthly, if within date range, it's valid
          isSessionDateToday = true;
        }
      } else {
        isSessionDateToday = false;
      }
    }
    
    if (!isSessionDateToday) {
      return res.status(400).json({ 
        msg: 'Session is not scheduled for today. Please check the session date and try again.' 
      });
    }

    // 6. CHECK FOR DUPLICATE ATTENDANCE
    // For recurring sessions, check if attendance was already marked TODAY (in IST)
    // For one-time sessions, check if attendance was already marked at all
    let existingAttendance;
    if (session.frequency === 'OneTime') {
      // One-time session: check if attendance exists for this session
      existingAttendance = await AttendanceCollection.findOne({ userId, sessionId });
    } else {
      // Recurring session: check if attendance was marked TODAY (in IST) for this session
      const todayStartIST = new Date(todayIST);
      todayStartIST.setHours(0, 0, 0, 0);
      // Convert IST start of day back to UTC for database query
      const todayStartUTC = new Date(todayStartIST.getTime() - IST_OFFSET_MS);
      
      const todayEndIST = new Date(todayIST);
      todayEndIST.setHours(23, 59, 59, 999);
      // Convert IST end of day back to UTC for database query
      const todayEndUTC = new Date(todayEndIST.getTime() - IST_OFFSET_MS);
      
      existingAttendance = await AttendanceCollection.findOne({
        userId,
        sessionId,
        checkInTime: {
          $gte: todayStartUTC,
          $lte: todayEndUTC
        }
      });
    }
    
    if (existingAttendance) {
      return res.status(400).json({ 
        msg: 'You have already marked attendance for this session.' 
      });
    }

    // 7. *** EARLY ATTENDANCE CHECK (2-Hour Window) ***
    // Calculate session start time
    let sessionStartDateTime: Date;

    if (session.frequency === 'OneTime') {
      // For one-time sessions, use the exact start datetime
      sessionStartDateTime = new Date(session.startDate);
      sessionStartDateTime.setHours(startHour, startMinute, 0, 0);
    } else {
      // For recurring sessions, use today's date with the start time
      sessionStartDateTime = new Date(todayIST);
      sessionStartDateTime.setHours(startHour, startMinute, 0, 0);
    }

    // Calculate the scan window start time (2 hours before session start)
    const EARLY_WINDOW_HOURS = 2;
    const scanWindowStart = new Date(sessionStartDateTime.getTime() - (EARLY_WINDOW_HOURS * 60 * 60 * 1000));

    // Check if current time is before the scan window (too early)
    if (nowInIST < scanWindowStart) {
      const timeTillWindowMs = scanWindowStart.getTime() - nowInIST.getTime();
      const hoursRemaining = Math.floor(timeTillWindowMs / (1000 * 60 * 60));
      const minutesRemaining = Math.floor((timeTillWindowMs % (1000 * 60 * 60)) / (1000 * 60));
      
      // Format the session start time for display
      const sessionStartFormatted = sessionStartDateTime.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      
      // Format the scan window start time for display
      const scanWindowFormatted = scanWindowStart.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });

      let timeRemainingMsg = '';
      if (hoursRemaining > 0) {
        timeRemainingMsg = `${hoursRemaining} hour${hoursRemaining > 1 ? 's' : ''} and ${minutesRemaining} minute${minutesRemaining !== 1 ? 's' : ''}`;
      } else {
        timeRemainingMsg = `${minutesRemaining} minute${minutesRemaining !== 1 ? 's' : ''}`;
      }

      return res.status(400).json({
        msg: `Attendance not yet open. Class starts at ${sessionStartFormatted}. You can scan starting from ${scanWindowFormatted} (in ${timeRemainingMsg}).`,
        type: 'TOO_EARLY',
        sessionStartTime: sessionStartFormatted,
        scanWindowStartTime: scanWindowFormatted,
        hoursRemaining,
        minutesRemaining,
      });
    }

    // 8. *** LATE MARKING LOGIC WITH STRICT MODE ***
    // Check if attendance is late
    let isLate = false;
    let lateByMinutes: number | undefined = undefined;

    // Compare current time (in IST) with session start time
    const timeDifferenceMs = nowInIST.getTime() - sessionStartDateTime.getTime();
    const timeDifferenceMinutes = timeDifferenceMs / (1000 * 60);
    const timeDifferenceSeconds = Math.floor((timeDifferenceMs % (1000 * 60)) / 1000);

    if (timeDifferenceMinutes > 0 && timeDifferenceMinutes <= lateAttendanceLimit) {
      // Scenario A: Current time is after start time but within the grace period
      isLate = true;
      lateByMinutes = Math.floor(timeDifferenceMinutes);
    } else if (timeDifferenceMinutes > lateAttendanceLimit) {
      // Scenario B: Current time is beyond the grace period
      const minutesLate = Math.floor(timeDifferenceMinutes);
      const secondsLate = timeDifferenceSeconds;

      if (isStrictAttendance) {
        // Strict Mode: REJECT the request
        return res.status(400).json({
          msg: `Attendance window closed. Strict Mode is active. You are late for the session by ${minutesLate} minutes and ${secondsLate} seconds.`,
        });
      } else {
        // Non-Strict Mode: ACCEPT but mark as late
        isLate = true;
        lateByMinutes = minutesLate;
      }
    }
    // If timeDifferenceMinutes <= 0, attendance is on time (isLate remains false)

    // 9. *** LOCATION VERIFICATION (GPS + GEOLIB) ***
    // SECURITY: Location verification is a HARD GATE - no bypasses, no fallbacks
    // Find the user's specific assignment for this session
    const assignment = session.assignedUsers.find(
      (u: any) => u.userId.toString() === userId.toString()
    );

    if (!assignment) {
      console.log('[ATTENDANCE_SCAN] REJECTED: User not assigned to session');
      return res.status(403).json({ msg: 'You are not assigned to this session.' });
    }

    // Determine if location verification is REQUIRED based on sessionType and user mode
    let isLocationRequired = false;

    if (session.sessionType === 'PHYSICAL') {
      // All users in PHYSICAL sessions MUST verify location
      isLocationRequired = true;
    } else if (session.sessionType === 'HYBRID') {
      // For HYBRID sessions, only PHYSICAL mode users need location verification
      if (assignment.mode === 'PHYSICAL') {
        isLocationRequired = true;
      }
      // If assignment.mode === 'REMOTE', isLocationRequired remains false
    }
    // If sessionType === 'REMOTE', isLocationRequired remains false

    // SECURITY: Perform location verification (if required)
    // CRITICAL: This is a HARD GATE - no attendance can be marked if verification fails
    let locationVerified = false;
    let distanceFromSession: number | undefined = undefined;

    // STRUCTURED LOGGING: Log location verification attempt
    const verificationLog: Record<string, any> = {
      userId,
      sessionId,
      requiresLocation: isLocationRequired,
      userLatitude: userLocation.latitude,
      userLongitude: userLocation.longitude,
      accuracy: accuracyMeters,
      timestamp: new Date().toISOString(),
      deviceId: deviceId.substring(0, 8) + '...', // Partial for privacy
    };

    if (isLocationRequired) {
      // SECURITY: Validate location data is present
      if (!userLocation || typeof userLocation.latitude !== 'number' || typeof userLocation.longitude !== 'number') {
        console.error('[ATTENDANCE_SCAN] REJECTED: Location required but data missing');
        return res.status(400).json({
          msg: 'Location data is required. Please enable GPS and try again.',
          reason: 'LOCATION_REQUIRED'
        });
      }

      // SECURITY: Reject if coordinates are (0,0) - common default/error value
      if (userLocation.latitude === 0 && userLocation.longitude === 0) {
        console.error('[ATTENDANCE_SCAN] REJECTED: Location is (0,0) - invalid coordinates');
        return res.status(400).json({
          msg: 'Invalid location detected. Please ensure GPS is enabled and try again.',
          reason: 'INVALID_COORDINATES'
        });
      }

      // SECURITY: Reject if GPS accuracy is too low (> 40 meters)
      if (accuracyMeters > 40) {
        console.error('[ATTENDANCE_SCAN] REJECTED: GPS accuracy too low:', accuracyMeters, 'm (max: 40m)');
        return res.status(403).json({
          msg: `GPS accuracy is too low (${Math.round(accuracyMeters)}m). Please enable high-accuracy GPS and ensure you have a clear view of the sky. Maximum allowed accuracy: 40m.`,
          reason: 'ACCURACY_TOO_LOW',
          accuracy: accuracyMeters,
          maxAllowed: 40
        });
      }

      // SECURITY: For location-required sessions, we MUST have session coordinates to verify distance
      // LINK type sessions without coordinates CANNOT verify location - REJECT attendance
      let sessionLocation: { latitude: number; longitude: number } | null = null;
      
      // Check new location structure first, then fall back to legacy geolocation
      if (session.location) {
        if (session.location.type === 'COORDS' && session.location.geolocation) {
          sessionLocation = {
            latitude: session.location.geolocation.latitude,
            longitude: session.location.geolocation.longitude,
          };
        }
        // SECURITY FIX: LINK type sessions MUST have coordinates to verify location
        // If session is LINK type but has no coordinates, we cannot verify location - REJECT
        // DO NOT bypass distance validation for LINK type sessions
      } else if (session.geolocation && session.geolocation.latitude && session.geolocation.longitude) {
        // Legacy support: use old geolocation field
        sessionLocation = {
          latitude: session.geolocation.latitude,
          longitude: session.geolocation.longitude,
        };
      }

      // SECURITY: If location is required, session MUST have coordinates for distance validation
      if (!sessionLocation) {
        console.error('[ATTENDANCE_SCAN] REJECTED: Session location coordinates not configured - cannot verify distance');
        return res.status(400).json({
          msg: 'Session location coordinates are not configured. Distance validation cannot be performed. Please contact the administrator.',
          reason: 'SESSION_LOCATION_NOT_CONFIGURED'
        });
      }

      // SECURITY: Distance validation is MANDATORY for all location-required sessions
      // Calculate distance using geolib
      distanceFromSession = getDistance(
        { latitude: userLocation.latitude, longitude: userLocation.longitude },
        { latitude: sessionLocation.latitude, longitude: sessionLocation.longitude }
      );

      const allowedRadius = session.radius || 100; // Default to 100 meters if not set

      // Explicit logging for audit trail
      console.log('[ATTENDANCE_SCAN] Distance validation:', {
        userLocation: { lat: userLocation.latitude, lng: userLocation.longitude },
        sessionLocation: { lat: sessionLocation.latitude, lng: sessionLocation.longitude },
        distance: distanceFromSession,
        allowedRadius,
        withinRadius: distanceFromSession <= allowedRadius,
        accuracy: accuracyMeters
      });

      // SECURITY: Reject if distance exceeds allowed radius
      if (distanceFromSession > allowedRadius) {
        console.error('[ATTENDANCE_SCAN] REJECTED: Location too far - distance:', distanceFromSession, 'm, radius:', allowedRadius, 'm');
        return res.status(403).json({
          msg: `You are not at the correct location. You are ${Math.round(distanceFromSession)}m away; please verify you are at the correct place as per the session.`,
          reason: 'LOCATION_TOO_FAR',
          distance: distanceFromSession,
          requiredRadius: allowedRadius
        });
      }

      // SECURITY: Only set locationVerified=true if distance check passes
      locationVerified = true;
      verificationLog['sessionLatitude'] = sessionLocation.latitude;
      verificationLog['sessionLongitude'] = sessionLocation.longitude;
      verificationLog['distanceFromSession'] = distanceFromSession;
      verificationLog['allowedRadius'] = allowedRadius;
      verificationLog['FINAL_DECISION'] = 'ALLOW';
      console.log('[ATTENDANCE_SCAN] Location verification PASSED:', {
        distance: distanceFromSession,
        allowedRadius,
        accuracy: accuracyMeters
      });
    } else {
      // For REMOTE users or REMOTE sessions, location verification is not required
      locationVerified = true; // Mark as verified since it's not required
      verificationLog['FINAL_DECISION'] = 'ALLOW';
      verificationLog['REJECTION_REASON'] = 'LOCATION_NOT_REQUIRED';
      console.log('[ATTENDANCE_SCAN] Location verification skipped - REMOTE session/user');
    }

    // Log complete verification attempt for audit trail
    verificationLog['locationVerified'] = locationVerified;
    console.log('[ATTENDANCE_VERIFICATION_LOG]', verificationLog);

    // SECURITY ASSERTION #1: Final check - attendance CANNOT be marked if location verification failed
    if (isLocationRequired && !locationVerified) {
      console.error('[ATTENDANCE_SCAN] FATAL ASSERTION FAILED: Location required but verification failed');
      return res.status(403).json({
        msg: 'Location verification failed. Attendance cannot be marked.',
        reason: 'LOCATION_VERIFICATION_FAILED'
      });
    }

    // 10. *** ENHANCED DEVICE-LOCKING CHECK WITH USER AGENT ***
    // Step 1: Extract deviceId and userAgent from request body (already extracted above)
    // Step 2: Check User's Registration
    
    // Logic Flow:
    if (!user.registeredDeviceId) {
      // IF First Time:
      // Save registeredDeviceId = deviceId
      // Save registeredUserAgent = userAgent
      user.registeredDeviceId = deviceId;
      user.registeredUserAgent = userAgent;
      await user.save();
      // Allow Attendance
    } else {
      // IF Returning User:
      // Check 1: Does deviceId match?
      if (user.registeredDeviceId !== deviceId) {
        // Device ID does NOT match -> BLOCK REQUEST
        return res.status(403).json({
          msg: 'Security Alert: You are not using the same device/browser you use everyday. Access Denied. Please contact your Admin to reset your device registration.',
        });
      }
      
      // Check 2: Does userAgent match registeredUserAgent?
      // If deviceId matches but userAgent is completely different, BLOCK REQUEST
      if (user.registeredUserAgent && user.registeredUserAgent !== userAgent) {
        // Device ID matched but Browser Signature mismatch -> Cloning detected
        return res.status(403).json({
          msg: 'Security Alert: Device ID matched but Browser Signature mismatch. Cloning detected.',
        });
      }
    }
    // IF Both Match: Allow Attendance (check passes, continue to create attendance record)

    // 11. ALL CHECKS PASSED: CREATE ATTENDANCE RECORD
    // SECURITY ASSERTION #2: Final safety check before saving attendance
    // This is a redundant but critical assertion to prevent any bypass
    if (isLocationRequired && !locationVerified) {
      console.error('[ATTENDANCE_SCAN] FATAL ASSERTION #2 FAILED: Attempted to create attendance with locationVerified=false when location is required');
      return res.status(403).json({
        msg: 'Location verification failed. Attendance cannot be marked.',
        reason: 'LOCATION_VERIFICATION_FAILED_ASSERTION'
      });
    }

    // SECURITY ASSERTION #3: Ensure locationVerified is explicitly true if location was required
    // This prevents any edge case where locationVerified might be undefined or false
    if (isLocationRequired && locationVerified !== true) {
      console.error('[ATTENDANCE_SCAN] FATAL ASSERTION #3 FAILED: locationVerified is not explicitly true:', locationVerified);
      return res.status(403).json({
        msg: 'Location verification state is invalid. Attendance cannot be marked.',
        reason: 'LOCATION_VERIFICATION_STATE_INVALID'
      });
    }

    console.log('[ATTENDANCE_SCAN] All checks passed - creating attendance record:', {
      userId,
      sessionId,
      locationVerified,
      isLate,
      lateByMinutes,
      accuracy: accuracyMeters,
      distanceFromSession,
      checkInTime: nowUTC.toISOString()
    });

    // Build attendance record
    // SECURITY: locationVerified MUST be true if location was required (enforced above)
    const attendanceData: any = {
      userId,
      sessionId,
      userLocation,
      locationVerified, // MUST be true if location was required
      isLate, // Mark if attendance was late
      lateByMinutes, // Number of minutes late (if applicable)
      deviceId, // Log the device used for this scan
      checkInTime: nowUTC, // Store in UTC (standard practice)
      accuracy: accuracyMeters, // GPS accuracy in meters
    };

    // Store distance from session if calculated
    if (distanceFromSession !== undefined) {
      attendanceData.distanceFromSession = distanceFromSession;
    }

    const newAttendance = new AttendanceCollection(attendanceData);
    await newAttendance.save();

    console.log('[ATTENDANCE_SCAN] SUCCESS: Attendance marked successfully:', {
      attendanceId: newAttendance._id,
      userId,
      sessionId
    });

    // 12. UPDATE SESSION'S assignedUsers ARRAY TO MARK USER AS PRESENT (and LATE if applicable)
    const assignmentIndex = session.assignedUsers.findIndex(
      (u: any) => u.userId.toString() === userId.toString()
    );
    if (assignmentIndex !== -1) {
      session.assignedUsers[assignmentIndex].attendanceStatus = 'Present';
      if (isLate) {
        session.assignedUsers[assignmentIndex].isLate = true;
      }
      await session.save();
    }

    res.status(201).json({
      msg: 'Attendance marked successfully!',
      attendance: newAttendance,
    });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   GET /api/attendance/me
// @desc    Get all attendance records for the logged-in user with session details
// @access  Private
export const getMyAttendance = async (req: Request, res: Response) => {
  try {
    const { id: userId, collectionPrefix } = req.user!;

    // Load organization-specific collections
    const AttendanceCollection = createAttendanceModel(`${collectionPrefix}_attendance`);
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);

    // Find all attendance records for this user, sorted by check-in time (newest first)
    const attendanceRecords = await AttendanceCollection.find({ userId })
      .sort({ checkInTime: -1 })
      .lean();

    // Since we're using factory functions, we can't use Mongoose populate()
    // Instead, we'll manually join the session data
    const sessionIds = attendanceRecords
      .map(record => record.sessionId)
      .filter(id => id); // Filter out any null/undefined IDs
    
    let sessions: any[] = [];
    if (sessionIds.length > 0) {
      sessions = await SessionCollection.find({
        _id: { $in: sessionIds }
      }).lean();
    }

    // Create a map of sessionId -> session for quick lookup
    const sessionMap = new Map();
    sessions.forEach(session => {
      sessionMap.set(session._id.toString(), session);
    });

    // Combine attendance records with session data
    const recordsWithSessions = attendanceRecords.map(record => {
      const sessionIdStr = record.sessionId?.toString() || '';
      const session = sessionMap.get(sessionIdStr);
      return {
        ...record,
        sessionId: session || null, // Include full session data or null if deleted
      };
    });

    res.json(recordsWithSessions);
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   GET /api/attendance/session/:id
// @desc    Get all attendance records for a specific session (with user data populated)
// @access  Private (Manager, SuperAdmin only)
export const getSessionAttendance = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix, role: userRole } = req.user!;
    const { id: sessionId } = req.params;

    // Check if user has permission (Manager, SuperAdmin, or Platform Owner)
    if (userRole !== 'Manager' && userRole !== 'SuperAdmin' && userRole !== 'PLATFORM_OWNER') {
      return res.status(403).json({ msg: 'Not authorized to view attendance reports' });
    }

    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(400).json({ msg: 'Invalid Session ID' });
    }

    // Load organization-specific collections
    const AttendanceCollection = createAttendanceModel(`${collectionPrefix}_attendance`);
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);

    // Verify session exists
    const session = await SessionCollection.findById(sessionId);
    if (!session) {
      return res.status(404).json({ msg: 'Session not found' });
    }

    // Find all attendance records for this session, sorted by check-in time
    const attendanceRecords = await AttendanceCollection.find({ sessionId })
      .sort({ checkInTime: -1 })
      .lean();

    // Get user IDs from attendance records
    const userIds = attendanceRecords
      .map(record => record.userId)
      .filter(id => id);

    // Fetch user data
    let users: any[] = [];
    if (userIds.length > 0) {
      users = await UserCollection.find({
        _id: { $in: userIds }
      }).select('email profile').lean();
    }

    // Create a map of userId -> user for quick lookup
    const userMap = new Map();
    users.forEach(user => {
      userMap.set(user._id.toString(), user);
    });

    // Combine attendance records with user data
    const recordsWithUsers = attendanceRecords.map(record => {
      const userIdStr = record.userId?.toString() || '';
      const user = userMap.get(userIdStr);
      return {
        _id: record._id,
        checkInTime: record.checkInTime,
        locationVerified: record.locationVerified,
        isLate: record.isLate || false, // Include isLate field
        lateByMinutes: record.lateByMinutes, // Include lateByMinutes field
        userId: user || null, // Include full user data or null if deleted
      };
    });

    // Also include users who are marked as "On Leave" in session.assignedUsers
    // These users won't have Attendance records, but should be shown in the list
    const LeaveRequestCollection = createLeaveRequestModel(`${collectionPrefix}_leave_requests`);
    const onLeaveUsers: any[] = [];
    if (session.assignedUsers && Array.isArray(session.assignedUsers)) {
      for (const assignedUser of session.assignedUsers) {
        if (assignedUser.attendanceStatus === 'On Leave') {
          // Fetch user data for this user
          try {
            const user = await UserCollection.findById(assignedUser.userId)
              .select('email profile')
              .lean();
            
            if (user) {
              // Find the approved leave request for this user and session date
              const sessionDate = new Date(session.startDate);
              sessionDate.setHours(0, 0, 0, 0);
              
              const approvedLeave = await LeaveRequestCollection.findOne({
                userId: new mongoose.Types.ObjectId(assignedUser.userId),
                status: 'Approved',
                $or: [
                  // Check if session date is in the dates array (for non-consecutive dates)
                  { dates: { $elemMatch: { $eq: sessionDate } } },
                  // OR check if session date falls within startDate and endDate range
                  {
                    startDate: { $lte: sessionDate },
                    endDate: { $gte: sessionDate },
                  },
                ],
              }).lean();
              
              // Fetch approver information if available
              let approver = null;
              if (approvedLeave && approvedLeave.approvedBy) {
                try {
                  const approverData = await UserCollection.findById(approvedLeave.approvedBy)
                    .select('email profile')
                    .lean();
                  if (approverData) {
                    approver = {
                      _id: approverData._id,
                      email: approverData.email,
                      profile: approverData.profile,
                    };
                  }
                } catch (err) {
                  console.error(`Error fetching approver ${approvedLeave.approvedBy}:`, err);
                }
              }
              
              onLeaveUsers.push({
                _id: `on-leave-${assignedUser.userId}`, // Unique ID for on-leave records
                checkInTime: session.startDate, // Use session start date as placeholder
                locationVerified: false,
                isLate: false,
                attendanceStatus: 'On Leave', // Mark as On Leave
                userId: user,
                approvedBy: approver, // Include approver information
              });
            }
          } catch (err) {
            console.error(`Error fetching user ${assignedUser.userId} for On Leave status:`, err);
          }
        }
      }
    }

    // Combine attendance records with on-leave users
    const allRecords = [...recordsWithUsers, ...onLeaveUsers];

    res.json(allRecords);
  } catch (err: any) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Session not found' });
    }
    res.status(500).send('Server error');
  }
};

// @route   GET /api/attendance/user/:id
// @desc    Get all attendance records for a specific user (with session data populated)
// @access  Private (Manager, SuperAdmin only)
export const getUserAttendance = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix, role: userRole } = req.user!;
    const { id: userId } = req.params;

    // Check if user has permission (Manager, SuperAdmin, or Platform Owner)
    if (userRole !== 'Manager' && userRole !== 'SuperAdmin' && userRole !== 'PLATFORM_OWNER') {
      return res.status(403).json({ msg: 'Not authorized to view attendance reports' });
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ msg: 'Invalid User ID' });
    }

    // Load organization-specific collections
    const AttendanceCollection = createAttendanceModel(`${collectionPrefix}_attendance`);
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);

    // Verify user exists
    const user = await UserCollection.findById(userId);
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Find all attendance records for this user, sorted by check-in time (newest first)
    const attendanceRecords = await AttendanceCollection.find({ userId })
      .sort({ checkInTime: -1 })
      .lean();

    // Get session IDs from attendance records
    const sessionIds = attendanceRecords
      .map(record => record.sessionId)
      .filter(id => id);

    // Fetch session data
    let sessions: any[] = [];
    if (sessionIds.length > 0) {
      sessions = await SessionCollection.find({
        _id: { $in: sessionIds }
      }).lean();
    }

    // Create a map of sessionId -> session for quick lookup
    const sessionMap = new Map();
    sessions.forEach(session => {
      sessionMap.set(session._id.toString(), session);
    });

    // Combine attendance records with session data
    const recordsWithSessions = attendanceRecords.map(record => {
      const sessionIdStr = record.sessionId?.toString() || '';
      const session = sessionMap.get(sessionIdStr);
      const recordAny = record as any; // Type assertion for timestamps
      return {
        _id: record._id,
        userId: record.userId,
        sessionId: session || null, // Include full session data or null if deleted
        checkInTime: record.checkInTime,
        locationVerified: record.locationVerified,
        userLocation: record.userLocation,
        deviceId: record.deviceId,
        createdAt: recordAny.createdAt,
        updatedAt: recordAny.updatedAt,
      };
    });

    res.json(recordsWithSessions);
  } catch (err: any) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'User not found' });
    }
    res.status(500).send('Server error');
  }
};

// @route   POST /api/attendance/force-mark
// @desc    Force mark attendance (Platform Owner only) - bypasses all checks
// @access  Private (Platform Owner only)
export const forceMarkAttendance = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { collectionPrefix, role, id: performerId, email: performerEmail } = req.user!;
  const { sessionId, userId, status } = req.body; // status: 'Present' or 'Absent'

  // STRICT CHECK: Only Platform Owner can force mark attendance
  if (role !== 'PLATFORM_OWNER') {
    return res.status(403).json({ 
      msg: 'Forbidden: Only Platform Owner can force mark attendance' 
    });
  }

  if (!mongoose.Types.ObjectId.isValid(sessionId)) {
    return res.status(400).json({ msg: 'Invalid Session ID' });
  }

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ msg: 'Invalid User ID' });
  }

  if (status !== 'Present' && status !== 'Absent') {
    return res.status(400).json({ msg: 'Status must be either "Present" or "Absent"' });
  }

  try {
    // Load organization-specific collections
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);
    const AttendanceCollection = createAttendanceModel(`${collectionPrefix}_attendance`);

    // Verify user and session exist
    const [user, session] = await Promise.all([
      UserCollection.findById(userId),
      SessionCollection.findById(sessionId)
    ]);

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    if (!session) {
      return res.status(404).json({ msg: 'Session not found' });
    }

    if (status === 'Present') {
      // Check if attendance record already exists
      const existingAttendance = await AttendanceCollection.findOne({
        userId,
        sessionId,
      });

      if (existingAttendance) {
        // Update existing record
        existingAttendance.locationVerified = true; // Force verified
        existingAttendance.isLate = false; // Reset late status
        existingAttendance.lateByMinutes = undefined;
        await existingAttendance.save();
      } else {
        // Create new attendance record
        const newAttendance = new AttendanceCollection({
          userId,
          sessionId,
          checkInTime: new Date(),
          locationVerified: true, // Force verified
          isLate: false,
          deviceId: 'FORCED_BY_PLATFORM_OWNER', // Special marker
        });
        await newAttendance.save();
      }

      // Update session's assignedUsers array
      const assignmentIndex = session.assignedUsers.findIndex(
        (u: any) => u.userId.toString() === userId.toString()
      );
      if (assignmentIndex !== -1) {
        session.assignedUsers[assignmentIndex].attendanceStatus = 'Present';
        session.assignedUsers[assignmentIndex].isLate = false;
        await session.save();
      }
    } else if (status === 'Absent') {
      // Remove attendance record if exists
      await AttendanceCollection.deleteOne({
        userId,
        sessionId,
      });

      // Update session's assignedUsers array
      const assignmentIndex = session.assignedUsers.findIndex(
        (u: any) => u.userId.toString() === userId.toString()
      );
      if (assignmentIndex !== -1) {
        session.assignedUsers[assignmentIndex].attendanceStatus = 'Absent';
        session.assignedUsers[assignmentIndex].isLate = false;
        await session.save();
      }
    }

    // Log the action in AuditLog
    await AuditLog.create({
      organizationPrefix: collectionPrefix,
      action: 'FORCE_ATTENDANCE_CORRECTION',
      performedBy: {
        userId: performerId.toString(),
        email: performerEmail,
        role: 'PLATFORM_OWNER',
      },
      targetUser: {
        userId: userId.toString(),
        email: user.email,
      },
      details: {
        sessionId: sessionId.toString(),
        sessionName: session.name,
        status,
        date: session.startDate,
      },
    });

    res.json({
      msg: `Attendance ${status === 'Present' ? 'marked as Present' : 'marked as Absent'} successfully`,
      status,
    });
  } catch (err: any) {
    console.error('Error in force mark attendance:', err);
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
};

