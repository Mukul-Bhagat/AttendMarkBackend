import { Router } from 'express';
import { protect, authorize } from '../middleware/authMiddleware';
import { getClassAnalytics, getSessionLogs } from '../controllers/reportController';

const router = Router();

// @route   GET /api/reports/analytics
// @desc    Get class-level analytics (timeline, summary, top performers/defaulters)
// @access  Private (Manager, SuperAdmin only)
router.get(
  '/analytics',
  protect,
  authorize('Manager', 'SuperAdmin'),
  getClassAnalytics
);

// @route   GET /api/reports/logs
// @desc    Get session logs for a specific class and date range
// @access  Private (Manager, SuperAdmin only)
router.get(
  '/logs',
  protect,
  authorize('Manager', 'SuperAdmin'),
  getSessionLogs
);

export default router;

