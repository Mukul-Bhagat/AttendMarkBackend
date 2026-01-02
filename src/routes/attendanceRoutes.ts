import { Router } from 'express';
import { check } from 'express-validator';
import { protect, protectPowerBI } from '../middleware/authMiddleware';
import { markAttendance, getMyAttendance, getSessionAttendance, getUserAttendance, forceMarkAttendance } from '../controllers/attendanceController';

const router = Router();

// @route   POST /api/attendance/scan
// @desc    Mark attendance (handles geo-check and device-lock)
// @access  Private
router.post(
  '/scan',
  protect, // Must be logged in
  [
    check('sessionId', 'Session ID is required').not().isEmpty().trim(),
    check('userLocation.latitude', 'User latitude is required').isFloat({ min: -90, max: 90 }),
    check('userLocation.longitude', 'User longitude is required').isFloat({ min: -180, max: 180 }),
    check('deviceId', 'Device ID is required').not().isEmpty().trim(),
    check('userAgent', 'User Agent is required').not().isEmpty().trim(),
    check('accuracy', 'GPS accuracy is required').isFloat({ min: 0, max: 1000 }),
    check('timestamp', 'Timestamp is required')
      .custom((value) => {
        // Timestamp must be a number (milliseconds since epoch)
        if (typeof value !== 'number' || isNaN(value) || value <= 0) {
          throw new Error('Timestamp must be a positive number (milliseconds)');
        }
        return true;
      }),
  ],
  markAttendance
);

// @route   GET /api/attendance/me
// @desc    Get all attendance records for the logged-in user
// @access  Private
router.get('/me', protect, getMyAttendance);

// @route   GET /api/attendance/session/:id
// @desc    Get all attendance records for a specific session (with user data)
// @access  Private (Manager, SuperAdmin only) - JWT token OR Power BI API key
router.get('/session/:id', protectPowerBI, getSessionAttendance);

// @route   GET /api/attendance/user/:id
// @desc    Get all attendance records for a specific user (with session data)
// @access  Private (Manager, SuperAdmin only) - JWT token OR Power BI API key
router.get('/user/:id', protectPowerBI, getUserAttendance);

// @route   POST /api/attendance/force-mark
// @desc    Force mark attendance (Platform Owner only) - bypasses all checks
// @access  Private (Platform Owner only)
router.post(
  '/force-mark',
  protect,
  [
    check('sessionId', 'Session ID is required').not().isEmpty(),
    check('userId', 'User ID is required').not().isEmpty(),
    check('status', 'Status is required').isIn(['Present', 'Absent']),
  ],
  forceMarkAttendance
);

export default router;

