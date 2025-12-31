import { Request, Response } from 'express';
import Organization from '../models/Organization';
import createUserModel from '../models/User';
import UserOrganizationMap from '../models/UserOrganizationMap';
import AuditLog from '../models/AuditLog';
import mongoose from 'mongoose';

// @route   GET /api/platform/organizations
// @desc    Get all organizations with stats for Platform Owner
// @access  Private (Platform Owner only)
export const getAllOrganizations = async (req: Request, res: Response) => {
  const { role } = req.user!;

  // Only Platform Owner can access this endpoint
  if (role !== 'PLATFORM_OWNER') {
    return res.status(403).json({ msg: 'Forbidden: Only Platform Owner can access this endpoint' });
  }

  try {
    // Get all organizations
    const organizations = await Organization.find({}).sort({ name: 1 });

    // Get stats for each organization
    const orgStats = await Promise.all(
      organizations.map(async (org) => {
        try {
          // Get organization users
          const UserCollection = createUserModel(`${org.collectionPrefix}_users`);
          const totalUsers = await UserCollection.countDocuments({ role: { $ne: 'PLATFORM_OWNER' } });

          // Get SuperAdmin (first one found)
          const superAdmin = await UserCollection.findOne({ role: 'SuperAdmin' })
            .select('profile.firstName profile.lastName email');

          const adminName = superAdmin
            ? `${superAdmin.profile?.firstName || ''} ${superAdmin.profile?.lastName || ''}`.trim() || superAdmin.email
            : 'No Admin';

          return {
            id: org._id.toString(),
            name: org.name,
            collectionPrefix: org.collectionPrefix,
            adminName,
            totalUsers,
            subscriptionStatus: 'Active', // Default to Active for now
            status: org.status || 'ACTIVE', // Organization status (ACTIVE/SUSPENDED)
            createdAt: org.createdAt,
          };
        } catch (err: any) {
          // If organization collection doesn't exist or has errors, return basic info
          console.error(`Error fetching stats for organization ${org.name}:`, err.message);
          return {
            id: org._id.toString(),
            name: org.name,
            collectionPrefix: org.collectionPrefix,
            adminName: 'N/A',
            totalUsers: 0,
            subscriptionStatus: 'Active',
            status: org.status || 'ACTIVE', // Organization status (ACTIVE/SUSPENDED)
            createdAt: org.createdAt,
          };
        }
      })
    );

    res.json({ organizations: orgStats });
  } catch (err: any) {
    console.error('Error fetching organizations:', err.message);
    res.status(500).json({ msg: 'Server error while fetching organizations' });
  }
};

// @route   PATCH /api/platform/organizations/:orgId/status
// @desc    Update organization status (suspend/activate) - Platform Owner only
// @access  Private (Platform Owner only)
export const updateOrganizationStatus = async (req: Request, res: Response) => {
  const { role } = req.user!;
  const { orgId } = req.params;
  const { status } = req.body;

  // Only Platform Owner can access this endpoint
  if (role !== 'PLATFORM_OWNER') {
    return res.status(403).json({ msg: 'Forbidden: Only Platform Owner can update organization status' });
  }

  // Validate status
  if (status !== 'ACTIVE' && status !== 'SUSPENDED') {
    return res.status(400).json({ msg: 'Status must be either "ACTIVE" or "SUSPENDED"' });
  }

  try {
    // Find organization by ID
    const org = await Organization.findById(orgId);
    if (!org) {
      return res.status(404).json({ msg: 'Organization not found' });
    }

    // Store old status for audit log
    const oldStatus = org.status;
    
    // Update status
    org.status = status;
    await org.save();

    // Log to AuditLog
    await AuditLog.create({
      organizationPrefix: org.collectionPrefix,
      action: 'UPDATE_ORGANIZATION_STATUS',
      performedBy: {
        userId: req.user!.id.toString(),
        email: req.user!.email,
        role: req.user!.role,
      },
      targetUser: undefined, // Organization actions don't have a target user
      details: {
        organizationId: org._id.toString(),
        organizationName: org.name,
        oldStatus: oldStatus,
        newStatus: status,
      },
    });

    res.json({
      msg: `Organization ${status === 'SUSPENDED' ? 'suspended' : 'activated'} successfully`,
      organization: {
        id: org._id.toString(),
        name: org.name,
        collectionPrefix: org.collectionPrefix,
        status: org.status,
      },
    });
  } catch (err: any) {
    console.error('Error updating organization status:', err.message);
    res.status(500).json({ msg: 'Server error while updating organization status' });
  }
};

// @route   GET /api/platform/audit-logs
// @desc    Get audit logs for Platform Owner
// @access  Private (Platform Owner only)
export const getAuditLogs = async (req: Request, res: Response) => {
  const { role } = req.user!;

  // Only Platform Owner can access this endpoint
  if (role !== 'PLATFORM_OWNER') {
    return res.status(403).json({ msg: 'Forbidden: Only Platform Owner can access this endpoint' });
  }

  try {
    // Fetch latest 100 audit logs, sorted by createdAt descending
    const auditLogs = await AuditLog.find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // Populate user names for performedBy and targetUser
    const populatedLogs = await Promise.all(
      auditLogs.map(async (log) => {
        let performedByName = log.performedBy.email;
        let targetUserName = log.targetUser?.email || 'N/A';

        try {
          // Try to get performedBy user name
          // Check if it's a Platform Owner first
          if (log.performedBy.role === 'PLATFORM_OWNER') {
            const PlatformOwnerCollection = createUserModel('platform_owners_users');
            const platformOwner = await PlatformOwnerCollection.findById(log.performedBy.userId)
              .select('profile.firstName profile.lastName email');
            if (platformOwner) {
              performedByName = `${platformOwner.profile?.firstName || ''} ${platformOwner.profile?.lastName || ''}`.trim() || platformOwner.email;
            }
          } else {
            // Regular user - need to find which organization they belong to
            // We can get this from the organizationPrefix in the log
            const UserCollection = createUserModel(`${log.organizationPrefix}_users`);
            const user = await UserCollection.findById(log.performedBy.userId)
              .select('profile.firstName profile.lastName email');
            if (user) {
              performedByName = `${user.profile?.firstName || ''} ${user.profile?.lastName || ''}`.trim() || user.email;
            }
          }

          // Try to get targetUser name if exists
          if (log.targetUser?.userId) {
            const UserCollection = createUserModel(`${log.organizationPrefix}_users`);
            const targetUser = await UserCollection.findById(log.targetUser.userId)
              .select('profile.firstName profile.lastName email');
            if (targetUser) {
              targetUserName = `${targetUser.profile?.firstName || ''} ${targetUser.profile?.lastName || ''}`.trim() || targetUser.email;
            }
          }
        } catch (err: any) {
          // If user lookup fails, use email as fallback (already set above)
          console.error(`Error populating user names for audit log ${log._id}:`, err.message);
        }

        // Format details summary
        let detailsSummary = '';
        if (log.action === 'FORCE_ATTENDANCE_CORRECTION') {
          const status = log.details.status || 'Present';
          const sessionName = log.details.sessionName || 'Session';
          const date = log.details.date ? new Date(log.details.date).toLocaleDateString() : '';
          detailsSummary = `Marked ${status} for ${sessionName}${date ? ` on ${date}` : ''}`;
        } else if (log.action === 'DEVICE_RESET') {
          detailsSummary = 'Device ID and User Agent reset';
        } else if (log.action === 'UPDATE_ORGANIZATION_STATUS') {
          const newStatus = log.details.newStatus || 'Unknown';
          detailsSummary = `Organization status changed to ${newStatus}`;
        } else if (log.action === 'CANCEL_SESSION') {
          detailsSummary = log.details.message || 'Session cancelled';
        } else if (log.action === 'CREATE_USER' || log.action === 'CREATE_STAFF') {
          detailsSummary = log.details.message || 'User created';
        } else if (log.action === 'DELETE_USER' || log.action === 'DELETE_STAFF') {
          detailsSummary = log.details.message || 'User deleted';
        } else if (log.action === 'BULK_IMPORT_STAFF') {
          const count = log.details.successCount || 0;
          detailsSummary = log.details.message || `Imported ${count} staff members`;
        } else {
          // Fallback: try to create a readable summary from details
          if (log.details?.message) {
            detailsSummary = log.details.message;
          } else {
            const detailKeys = Object.keys(log.details || {});
            if (detailKeys.length > 0) {
              detailsSummary = detailKeys.slice(0, 2).map(key => `${key}: ${log.details[key]}`).join(', ');
            } else {
              detailsSummary = 'No additional details';
            }
          }
        }

        return {
          id: log._id.toString(),
          time: log.createdAt,
          action: log.action,
          performedBy: {
            name: performedByName,
            email: log.performedBy.email,
            role: log.performedBy.role,
          },
          targetUser: log.targetUser ? {
            name: targetUserName,
            email: log.targetUser.email,
          } : null,
          organizationPrefix: log.organizationPrefix,
          organizationName: log.organizationName || null,
          details: log.details,
          detailsSummary,
        };
      })
    );

    res.json({ auditLogs: populatedLogs });
  } catch (err: any) {
    console.error('Error fetching audit logs:', err.message);
    res.status(500).json({ msg: 'Server error while fetching audit logs' });
  }
};

