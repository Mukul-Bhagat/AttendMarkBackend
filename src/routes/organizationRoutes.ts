import { Router } from 'express';
import { check } from 'express-validator';
import { protect } from '../middleware/authMiddleware';
import { getOrganizationSettings, updateOrganizationSettings } from '../controllers/organizationController';

const router = Router();

// @route   GET /api/organization/settings
// @desc    Get organization settings
// @access  Private (SuperAdmin only)
router.get('/settings', protect, getOrganizationSettings);

// @route   PUT /api/organization/settings
// @desc    Update organization settings
// @access  Private (SuperAdmin only)
router.put(
  '/settings',
  protect,
  [
    check('lateAttendanceLimit', 'lateAttendanceLimit must be a non-negative number')
      .isFloat({ min: 0 })
      .toFloat(),
  ],
  updateOrganizationSettings
);

export default router;

