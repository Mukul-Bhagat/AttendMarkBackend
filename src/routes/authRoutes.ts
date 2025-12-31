import { Router } from 'express';
import { check } from 'express-validator';
import { protect } from '../middleware/authMiddleware';
import { getOrganizations, registerSuperAdmin, login, selectOrganization, switchOrganization, getMyOrganizations, getMe, forceResetPassword, forgotPassword, resetPassword, runMigration } from '../controllers/authController';

const router = Router();

// @route   GET /api/auth/organizations
// @desc    Get list of all organizations for login dropdown
// @access  Public
router.get('/organizations', getOrganizations);

// @route   POST /api/auth/register-super-admin
// @desc    Register a new Organization AND create its user table
// @access  Public
router.post(
  '/register-super-admin',
  [
    check('organizationName', 'Organization name is required').not().isEmpty(),
    check('firstName', 'First name is required').not().isEmpty(),
    check('lastName', 'Last name is required').not().isEmpty(),
    check('email', 'Please include a valid email').isEmail(),
    check('password', 'Password must be 6 or more characters').isLength({ min: 6 }),
  ],
  registerSuperAdmin
);

// @route   POST /api/auth/login
// @desc    Login user - requires email and password, returns organizations list
// @access  Public
router.post(
  '/login',
  [
    check('email', 'Please include a valid email').isEmail(),
    check('password', 'Password is required').exists(),
  ],
  login
);

// @route   POST /api/auth/select-organization
// @desc    Complete login by selecting an organization
// @access  Public
router.post(
  '/select-organization',
  [
    check('tempToken', 'Temporary token is required').not().isEmpty(),
    check('prefix', 'Organization prefix is required').not().isEmpty(),
  ],
  selectOrganization
);

// @route   POST /api/auth/switch-organization
// @desc    Switch to a different organization
// @access  Private
router.post(
  '/switch-organization',
  protect,
  [
    check('targetPrefix', 'Target organization prefix is required').not().isEmpty(),
  ],
  switchOrganization
);

// @route   GET /api/auth/my-organizations
// @desc    Get list of organizations the logged-in user belongs to
// @access  Private
router.get('/my-organizations', protect, getMyOrganizations);

// @route   GET /api/auth/me
// @desc    Get the logged-in user's data from their token
// @access  Private
router.get('/me', protect, getMe);

// @route   POST /api/auth/force-reset-password
// @desc    Force password reset - requires old password and new password
// @access  Private
router.post(
  '/force-reset-password',
  protect,
  [
    check('oldPassword', 'Old password is required').exists(),
    check('newPassword', 'New password must be at least 6 characters').isLength({ min: 6 }),
  ],
  forceResetPassword
);

// @route   POST /api/auth/forgot-password
// @desc    Send password reset email
// @access  Public
router.post(
  '/forgot-password',
  [
    check('organizationName', 'Organization name is required').not().isEmpty(),
    check('email', 'Please include a valid email').isEmail(),
  ],
  forgotPassword
);

// @route   PUT /api/auth/reset-password/:collectionPrefix/:resetToken
// @desc    Reset password with token
// @access  Public
router.put(
  '/reset-password/:collectionPrefix/:resetToken',
  [
    check('newPassword', 'New password must be at least 6 characters').isLength({ min: 6 }),
  ],
  resetPassword
);

// @route   GET /api/auth/run-migration
// @desc    Run migration to populate UserOrganizationMap from existing users
// @access  Public (should be protected in production)
router.get('/run-migration', runMigration);

export default router;

