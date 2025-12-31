import { Router } from 'express';
import { check } from 'express-validator';
import { protect } from '../middleware/authMiddleware';
import { getAllOrganizations, updateOrganizationStatus, getAuditLogs } from '../controllers/platformController';

const router = Router();

// @route   GET /api/platform/organizations
// @desc    Get all organizations with stats for Platform Owner
// @access  Private (Platform Owner only)
router.get('/organizations', protect, getAllOrganizations);

// @route   PATCH /api/platform/organizations/:orgId/status
// @desc    Update organization status (suspend/activate) - Platform Owner only
// @access  Private (Platform Owner only)
router.patch(
  '/organizations/:orgId/status',
  protect,
  [
    check('status', 'Status is required').isIn(['ACTIVE', 'SUSPENDED']),
  ],
  updateOrganizationStatus
);

// @route   GET /api/platform/audit-logs
// @desc    Get audit logs for Platform Owner
// @access  Private (Platform Owner only)
router.get('/audit-logs', protect, getAuditLogs);

export default router;

