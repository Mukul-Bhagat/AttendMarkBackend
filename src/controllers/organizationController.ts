import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import createOrganizationSettingsModel from '../models/OrganizationSettings';

// @route   GET /api/organization/settings
// @desc    Get organization settings (lateAttendanceLimit)
// @access  Private (SuperAdmin only)
export const getOrganizationSettings = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix, role } = req.user!;

    // Only SuperAdmin can access organization settings
    if (role !== 'SuperAdmin') {
      return res.status(403).json({ msg: 'Not authorized. Only SuperAdmin can access organization settings.' });
    }

    const OrganizationSettings = createOrganizationSettingsModel();

    // Find or create default settings for this organization
    let settings = await OrganizationSettings.findOne({ organizationPrefix: collectionPrefix });

    if (!settings) {
      // Create default settings if they don't exist
      settings = new OrganizationSettings({
        organizationPrefix: collectionPrefix,
        lateAttendanceLimit: 30, // Default: 30 minutes
        yearlyQuotaPL: 12, // Default: 12 days
        yearlyQuotaCL: 12, // Default: 12 days
        yearlyQuotaSL: 10, // Default: 10 days
      });
      await settings.save();
    }

    res.json({
      lateAttendanceLimit: settings.lateAttendanceLimit,
      isStrictAttendance: settings.isStrictAttendance || false,
      yearlyQuotaPL: settings.yearlyQuotaPL || 12,
      yearlyQuotaCL: settings.yearlyQuotaCL || 12,
      yearlyQuotaSL: settings.yearlyQuotaSL || 10,
    });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   PUT /api/organization/settings
// @desc    Update organization settings (lateAttendanceLimit)
// @access  Private (SuperAdmin only)
export const updateOrganizationSettings = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { collectionPrefix, role } = req.user!;
    const { lateAttendanceLimit, isStrictAttendance, yearlyQuotaPL, yearlyQuotaCL, yearlyQuotaSL } = req.body;

    // Only SuperAdmin can update organization settings
    if (role !== 'SuperAdmin') {
      return res.status(403).json({ msg: 'Not authorized. Only SuperAdmin can update organization settings.' });
    }

    // Validate lateAttendanceLimit
    if (lateAttendanceLimit === undefined || lateAttendanceLimit === null) {
      return res.status(400).json({ msg: 'lateAttendanceLimit is required' });
    }

    if (typeof lateAttendanceLimit !== 'number' || lateAttendanceLimit < 0) {
      return res.status(400).json({ msg: 'lateAttendanceLimit must be a non-negative number' });
    }

    // Validate isStrictAttendance (optional, defaults to false)
    if (isStrictAttendance !== undefined && typeof isStrictAttendance !== 'boolean') {
      return res.status(400).json({ msg: 'isStrictAttendance must be a boolean' });
    }

    // Validate leave quotas (optional)
    if (yearlyQuotaPL !== undefined && (typeof yearlyQuotaPL !== 'number' || yearlyQuotaPL < 0)) {
      return res.status(400).json({ msg: 'yearlyQuotaPL must be a non-negative number' });
    }
    if (yearlyQuotaCL !== undefined && (typeof yearlyQuotaCL !== 'number' || yearlyQuotaCL < 0)) {
      return res.status(400).json({ msg: 'yearlyQuotaCL must be a non-negative number' });
    }
    if (yearlyQuotaSL !== undefined && (typeof yearlyQuotaSL !== 'number' || yearlyQuotaSL < 0)) {
      return res.status(400).json({ msg: 'yearlyQuotaSL must be a non-negative number' });
    }

    const OrganizationSettings = createOrganizationSettingsModel();

    // Find or create settings for this organization
    let settings = await OrganizationSettings.findOne({ organizationPrefix: collectionPrefix });

    if (!settings) {
      // Create new settings if they don't exist
      settings = new OrganizationSettings({
        organizationPrefix: collectionPrefix,
        lateAttendanceLimit,
        isStrictAttendance: isStrictAttendance !== undefined ? isStrictAttendance : false,
        yearlyQuotaPL: yearlyQuotaPL !== undefined ? yearlyQuotaPL : 12,
        yearlyQuotaCL: yearlyQuotaCL !== undefined ? yearlyQuotaCL : 12,
        yearlyQuotaSL: yearlyQuotaSL !== undefined ? yearlyQuotaSL : 10,
      });
    } else {
      // Update existing settings
      settings.lateAttendanceLimit = lateAttendanceLimit;
      if (isStrictAttendance !== undefined) {
        settings.isStrictAttendance = isStrictAttendance;
      }
      if (yearlyQuotaPL !== undefined) {
        settings.yearlyQuotaPL = yearlyQuotaPL;
      }
      if (yearlyQuotaCL !== undefined) {
        settings.yearlyQuotaCL = yearlyQuotaCL;
      }
      if (yearlyQuotaSL !== undefined) {
        settings.yearlyQuotaSL = yearlyQuotaSL;
      }
    }

    await settings.save();

    res.json({
      msg: 'Organization settings updated successfully',
      lateAttendanceLimit: settings.lateAttendanceLimit,
      isStrictAttendance: settings.isStrictAttendance,
      yearlyQuotaPL: settings.yearlyQuotaPL,
      yearlyQuotaCL: settings.yearlyQuotaCL,
      yearlyQuotaSL: settings.yearlyQuotaSL,
    });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

