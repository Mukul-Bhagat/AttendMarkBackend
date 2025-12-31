import { Router } from 'express';
import { check } from 'express-validator';
import { protect } from '../middleware/authMiddleware';
import { uploadLeaveDocument } from '../middleware/uploadMiddleware';
import {
  applyLeave,
  getMyLeaves,
  getOrganizationLeaves,
  updateLeaveStatus,
  deleteLeave,
} from '../controllers/leaveController';

const router = Router();

// @route   POST /api/leaves
// @desc    Apply for leave
// @access  Private (All authenticated users)
router.post(
  '/',
  protect,
  uploadLeaveDocument.single('attachment'), // Handle file upload
  [
    check('leaveType', 'Leave type is required').isIn(['Personal', 'Casual', 'Sick', 'Extra']),
    // Support both formats: dates array OR startDate/endDate (for backward compatibility)
    check('dates', 'Dates array must be an array if provided')
      .optional()
      .custom((value) => {
        // If dates is a string (from FormData), try to parse it
        if (typeof value === 'string') {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) && parsed.length > 0;
          } catch {
            return false;
          }
        }
        return Array.isArray(value) && value.length > 0;
      })
      .withMessage('Dates array must contain at least one date'),
    check('startDate', 'Start date is required if dates array is not provided')
      .optional()
      .custom((value, { req }) => {
        try {
          // If dates array is not provided, startDate and endDate are required
          let dates = req.body.dates;
          if (typeof dates === 'string') {
            try {
              dates = JSON.parse(dates);
            } catch {
              dates = null;
            }
          }
          if (!dates && !value) {
            throw new Error('Either dates array or startDate is required');
          }
          return true;
        } catch (err: any) {
          throw new Error(err.message || 'Invalid startDate validation');
        }
      }),
    check('endDate', 'End date is required if dates array is not provided')
      .optional()
      .custom((value, { req }) => {
        try {
          // If dates array is not provided, startDate and endDate are required
          let dates = req.body.dates;
          if (typeof dates === 'string') {
            try {
              dates = JSON.parse(dates);
            } catch {
              dates = null;
            }
          }
          if (!dates && !value) {
            throw new Error('Either dates array or endDate is required');
          }
          return true;
        } catch (err: any) {
          throw new Error(err.message || 'Invalid endDate validation');
        }
      }),
    check('reason', 'Reason is required').not().isEmpty().trim(),
  ],
  applyLeave
);

// @route   GET /api/leaves/my-leaves
// @desc    Get leave requests for the logged-in user
// @access  Private (All authenticated users)
router.get('/my-leaves', protect, getMyLeaves);

// @route   GET /api/leaves/organization
// @desc    Get all leave requests for the organization (for Admins/Staff)
// @access  Private (SuperAdmin, CompanyAdmin, Manager, SessionAdmin)
router.get('/organization', protect, getOrganizationLeaves);

// @route   PUT /api/leaves/:id/status
// @desc    Update leave request status (Approve/Reject)
// @access  Private (SuperAdmin, CompanyAdmin, Manager, SessionAdmin)
router.put(
  '/:id/status',
  protect,
  [
    check('status', 'Status is required').isIn(['Approved', 'Rejected']),
    check('rejectionReason', 'Rejection reason is required when status is Rejected')
      .optional()
      .custom((value, { req }) => {
        if (req.body.status === 'Rejected' && !value) {
          throw new Error('Rejection reason is required when rejecting a leave request');
        }
        return true;
      }),
  ],
  updateLeaveStatus
);

// @route   DELETE /api/leaves/:id
// @desc    Delete a leave request (only if status is Pending)
// @access  Private (User can only delete their own leave requests)
router.delete('/:id', protect, deleteLeave);

export default router;

