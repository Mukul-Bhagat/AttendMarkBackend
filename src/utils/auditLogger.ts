import AuditLog from '../models/AuditLog';
import Organization from '../models/Organization';
import mongoose from 'mongoose';

/**
 * Helper function to log actions to the AuditLog collection
 * 
 * @param action - The action being performed (must match enum in AuditLog schema)
 * @param performedBy - User object performing the action (must have id, email, role, collectionPrefix)
 * @param targetId - ID of the user/session/org affected (optional)
 * @param details - Additional details about the action (object or string)
 * @param orgId - Organization ID (optional, will be fetched if not provided but collectionPrefix is available)
 * @param orgName - Organization name (optional, will be fetched if not provided)
 * @param targetEmail - Email of target user (optional, for user-related actions)
 */
export const logAction = async (
  action: string,
  performedBy: {
    id: string | mongoose.Types.ObjectId;
    email: string;
    role: string;
    collectionPrefix?: string;
  },
  targetId?: string | mongoose.Types.ObjectId,
  details?: Record<string, any> | string,
  orgId?: string | mongoose.Types.ObjectId,
  orgName?: string,
  targetEmail?: string
): Promise<void> => {
  try {
    const collectionPrefix = performedBy.collectionPrefix || '';

    // Fetch organization details if not provided
    let organizationId: mongoose.Types.ObjectId | undefined;
    let organizationName: string | undefined;

    if (orgId) {
      organizationId = typeof orgId === 'string' ? new mongoose.Types.ObjectId(orgId) : orgId;
    } else if (collectionPrefix) {
      // Try to fetch organization by collectionPrefix
      try {
        const org = await Organization.findOne({ collectionPrefix });
        if (org) {
          organizationId = org._id;
          organizationName = org.name;
        }
      } catch (err: any) {
        console.error('Error fetching organization for audit log:', err.message);
        // Continue without organization details
      }
    }

    // Use provided orgName or keep the fetched one
    if (orgName) {
      organizationName = orgName;
    }

    // Prepare targetUser object if targetId is provided
    const targetUser = targetId
      ? {
          userId: typeof targetId === 'string' ? targetId : targetId.toString(),
          email: targetEmail || '',
        }
      : undefined;

    // Convert details to object if it's a string
    const detailsObject: Record<string, any> =
      typeof details === 'string' ? { message: details } : details || {};

    // Create audit log entry
    await AuditLog.create({
      organizationPrefix: collectionPrefix,
      organizationId,
      organizationName,
      action,
      performedBy: {
        userId: typeof performedBy.id === 'string' ? performedBy.id : performedBy.id.toString(),
        email: performedBy.email,
        role: performedBy.role,
      },
      targetUser,
      details: detailsObject,
    });
  } catch (error: any) {
    // Don't throw - audit logging should not break the main flow
    console.error('Error creating audit log:', error.message);
  }
};

