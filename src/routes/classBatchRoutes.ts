import { Router } from 'express';
import { check } from 'express-validator';
import { protect } from '../middleware/authMiddleware';
import {
  createClassBatch,
  getClassBatches,
  getClassBatchById,
  getSessionsByClassBatch,
  updateClassBatch,
  deleteClassBatch,
} from '../controllers/classBatchController';

const router = Router();

// @route   POST /api/classes
// @desc    Create a new ClassBatch
// @access  Private
router.post(
  '/',
  protect,
  [
    check('name', 'ClassBatch name is required').not().isEmpty(),
    check('defaultTime', 'Default time must be in HH:mm format').optional().matches(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/),
    // Optional validation for session generation
    check('frequency', 'Frequency is required when generating sessions').optional().isIn(['OneTime', 'Daily', 'Weekly', 'Monthly']),
    check('startDate', 'Start date is required when generating sessions').optional().not().isEmpty(),
    check('startTime', 'Start time must be in HH:mm format').optional().matches(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/),
    check('endTime', 'End time must be in HH:mm format').optional().matches(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/),
  ],
  createClassBatch
);

// @route   GET /api/classes
// @desc    Get all ClassBatches for the user's organization
// @access  Private
router.get('/', protect, getClassBatches);

// @route   GET /api/classes/:id
// @desc    Get a single ClassBatch by its ID
// @access  Private
router.get('/:id', protect, getClassBatchById);

// @route   GET /api/classes/:id/sessions
// @desc    Get all sessions belonging to a specific ClassBatch
// @access  Private
router.get('/:id/sessions', protect, getSessionsByClassBatch);

// @route   PUT /api/classes/:id
// @desc    Update a ClassBatch
// @access  Private
router.put(
  '/:id',
  protect,
  [
    check('name', 'ClassBatch name is required').optional().not().isEmpty(),
    check('defaultTime', 'Default time must be in HH:mm format').optional().matches(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/),
  ],
  updateClassBatch
);

// @route   DELETE /api/classes/:id
// @desc    Delete a ClassBatch
// @access  Private
router.delete('/:id', protect, deleteClassBatch);

export default router;

