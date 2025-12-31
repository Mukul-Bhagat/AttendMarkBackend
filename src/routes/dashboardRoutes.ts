import { Router } from 'express';
import { protect } from '../middleware/authMiddleware';
import { getDashboardStats } from '../controllers/dashboardController';

const router = Router();

// @route   GET /api/dashboard/stats
// @desc    Get dashboard statistics
// @access  Private
router.get('/stats', protect, getDashboardStats);

export default router;

