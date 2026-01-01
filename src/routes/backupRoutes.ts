import { Router } from 'express';
import { protect, authorize } from '../middleware/authMiddleware';
import { exportBackup, restoreBackup, restoreData, streamBackup } from '../controllers/backupController';
import { uploadBackup } from '../middleware/uploadMiddleware';

const router = Router();

// @route   GET /api/backup/stream
// @desc    Stream organization backup as JSON (zero-storage, no disk writes)
// @access  Private (Company Admin or Platform Owner)
router.get('/stream', protect, authorize('PLATFORM_OWNER', 'CompanyAdmin', 'SuperAdmin'), streamBackup);

// @route   GET /api/backup/:orgId/export
// @desc    Export organization backup as compressed JSON
// @access  Private (Platform Owner or Company Admin)
router.get('/:orgId/export', protect, authorize('PLATFORM_OWNER', 'CompanyAdmin', 'SuperAdmin'), exportBackup);

// @route   POST /api/backup/:orgId/restore
// @desc    Restore organization from compressed backup file
// @access  Private (Platform Owner or Company Admin)
router.post('/:orgId/restore', protect, authorize('PLATFORM_OWNER', 'CompanyAdmin', 'SuperAdmin'), uploadBackup.single('backupFile'), restoreBackup);

// @route   POST /api/backup/restore
// @desc    Restore organization from backup file (context-based)
// @access  Private (Company Admin or Platform Owner)
router.post('/restore', protect, authorize('PLATFORM_OWNER', 'CompanyAdmin', 'SuperAdmin'), uploadBackup.single('backupFile'), restoreData);

export default router;

