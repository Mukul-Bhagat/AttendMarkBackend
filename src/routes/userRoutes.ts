import { Router, Request, Response, NextFunction } from 'express';
import { check } from 'express-validator';
import { protect, protectPowerBI } from '../middleware/authMiddleware';
import { getOrganizationUsers, createStaff, createEndUser, resetDevice, resetDeviceOnly, deleteUser, uploadProfilePicture, updateProfile, changePassword, removeProfilePicture, bulkCreateUsers, bulkCreateStaff, bulkImportStaff, updateUserQuota } from '../controllers/userController';
import { upload } from '../middleware/uploadMiddleware';

const router = Router();

// @route   GET /api/users/my-organization
// @desc    Get all users in the token's organization
// @access  Private (JWT token OR Power BI API key)
router.get('/my-organization', protectPowerBI, getOrganizationUsers);

// @route   POST /api/users/profile-picture
// @desc    Upload profile picture
// @access  Private
router.post('/profile-picture', protect, upload.single('profilePicture'), uploadProfilePicture);

// @route   DELETE /api/users/profile-picture
// @desc    Remove profile picture
// @access  Private
router.delete('/profile-picture', protect, removeProfilePicture);

// @route   PUT /api/users/profile
// @desc    Update user profile
// @access  Private
router.put(
  '/profile',
  protect,
  [
    check('firstName', 'First name is required').optional().not().isEmpty(),
    check('lastName', 'Last name is required').optional().not().isEmpty(),
    check('phone', 'Phone must be a valid phone number').optional().isMobilePhone('any'),
  ],
  updateProfile
);

// @route   PUT /api/users/change-password
// @desc    Change user password
// @access  Private
router.put(
  '/change-password',
  protect,
  [
    check('oldPassword', 'Current password is required').not().isEmpty(),
    check('newPassword', 'New password must be at least 6 characters').isLength({ min: 6 }),
  ],
  changePassword
);

// @route   POST /api/users/staff
// @desc    Create a new staff member (Manager or SessionAdmin) - Only SuperAdmin
// @access  Private (SuperAdmin only)
router.post(
  '/staff',
  protect,
  [
    check('email', 'Please include a valid email').isEmail(),
    check('password', 'Password must be at least 6 characters').isLength({ min: 6 }),
    check('role', 'Role is required').isIn(['Manager', 'SessionAdmin']),
    check('firstName', 'First name is required').not().isEmpty(),
    check('lastName', 'Last name is required').not().isEmpty(),
    check('phone', 'Phone must be a valid phone number').optional().isMobilePhone('any'),
  ],
  createStaff
);

// @route   POST /api/users/bulk
// @desc    Bulk create users (EndUser, Manager, or SessionAdmin) from CSV data
// @access  Private (SuperAdmin or CompanyAdmin)
router.post(
  '/bulk',
  protect,
  [
    check('users', 'Users array is required').isArray(),
    // temporaryPassword is optional if useRandomPassword is true
    check('temporaryPassword')
      .optional()
      .custom((value, { req }) => {
        if (req.body.useRandomPassword === true) {
          return true; // Skip validation if useRandomPassword is true
        }
        if (!value || value.length < 6) {
          throw new Error('Temporary password is required and must be at least 6 characters when not using random passwords');
        }
        return true;
      }),
  ],
  bulkCreateUsers
);

// @route   POST /api/users/staff/bulk
// @desc    Bulk create Staff members (Manager or SessionAdmin) from CSV data
// @desc    DEPRECATED: Use /api/users/bulk instead (unified endpoint)
// @access  Private (SuperAdmin only)
// Note: This endpoint is kept for backward compatibility but now calls the unified bulkCreateUsers function
router.post(
  '/staff/bulk',
  protect,
  [
    check('staff', 'Staff array is required').isArray(),
    // temporaryPassword is optional if useRandomPassword is true
    check('temporaryPassword')
      .optional()
      .custom((value, { req }) => {
        if (req.body.useRandomPassword === true) {
          return true; // Skip validation if useRandomPassword is true
        }
        if (!value || value.length < 6) {
          throw new Error('Temporary password is required and must be at least 6 characters when not using random passwords');
        }
        return true;
      }),
  ],
  // Transform request body to match unified format and call bulkCreateUsers
  (req: Request, res: Response, next: NextFunction) => {
    if (req.body.staff && Array.isArray(req.body.staff)) {
      req.body.users = req.body.staff;
    }
    next();
  },
  bulkCreateUsers
);

// @route   POST /api/users/staff/bulk-import
// @desc    Bulk import Staff members (Manager or SessionAdmin) from CSV data
// @access  Private (SuperAdmin, CompanyAdmin, or Platform Owner)
router.post(
  '/staff/bulk-import',
  protect,
  [
    check('staff', 'Staff array is required').isArray(),
    check('staff.*.firstName', 'First name is required').not().isEmpty(),
    check('staff.*.lastName', 'Last name is required').not().isEmpty(),
    check('staff.*.email', 'Valid email is required').isEmail(),
    check('staff.*.role', 'Role must be Manager or SessionAdmin').isIn(['Manager', 'SessionAdmin']),
    check('staff.*.phone', 'Phone must be a valid phone number').optional().isMobilePhone('any'),
  ],
  bulkImportStaff
);

// @route   POST /api/users/end-user
// @desc    Create a new EndUser
// @access  Private (SuperAdmin or CompanyAdmin)
router.post(
  '/end-user',
  protect,
  [
    check('email', 'Please include a valid email').isEmail(),
    check('password', 'Password must be at least 6 characters').isLength({ min: 6 }),
    check('firstName', 'First name is required').not().isEmpty(),
    check('lastName', 'Last name is required').not().isEmpty(),
    check('phone', 'Phone must be a valid phone number').optional().isMobilePhone('any'),
  ],
  createEndUser
);

// @route   PUT /api/users/:userId/reset-device
// @desc    Reset a user's registered device ID and generate new password
// @access  Private (SuperAdmin or CompanyAdmin)
router.put('/:userId/reset-device', protect, resetDevice);

// @route   PUT /api/users/:userId/reset-device-only
// @desc    Reset a user's registered device ID ONLY (without password reset) - Platform Owner only
// @access  Private (Platform Owner only)
router.put('/:userId/reset-device-only', protect, resetDeviceOnly);

// @route   PUT /api/users/:userId/quota
// @desc    Update a user's custom leave quota
// @access  Private (SuperAdmin or CompanyAdmin)
router.put(
  '/:userId/quota',
  protect,
  [
    check('pl', 'PL must be a non-negative number').optional().isFloat({ min: 0 }),
    check('cl', 'CL must be a non-negative number').optional().isFloat({ min: 0 }),
    check('sl', 'SL must be a non-negative number').optional().isFloat({ min: 0 }),
    check('resetToDefault', 'resetToDefault must be a boolean').optional().isBoolean(),
  ],
  updateUserQuota
);

// @route   DELETE /api/users/:userId
// @desc    Delete a user account - Only SuperAdmin
// @access  Private (SuperAdmin only)
router.delete('/:userId', protect, deleteUser);

export default router;

