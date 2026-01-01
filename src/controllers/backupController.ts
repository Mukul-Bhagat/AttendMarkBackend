import { Request, Response } from 'express';
import zlib from 'zlib';
import { promisify } from 'util';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import Organization from '../models/Organization';
import createUserModel from '../models/User';
import createSessionModel from '../models/Session';
import createClassBatchModel from '../models/ClassBatch';
import createAttendanceModel from '../models/Attendance';
import createLeaveRequestModel from '../models/LeaveRequest';
import { logAction } from '../utils/auditLogger';
import fs from 'fs';
import path from 'path';

const gunzip = promisify(zlib.gunzip);

// @route   GET /api/backup/:orgId/export
// @desc    Export organization backup as compressed JSON
// @access  Private (Platform Owner or Company Admin)
export const exportBackup = async (req: Request, res: Response) => {
  const { orgId } = req.params;
  const { role: requesterRole, collectionPrefix: requesterPrefix, id: requesterId, email: requesterEmail } = req.user!;

  // Security check: Only Platform Owner or Company Admin can export backups
  if (requesterRole !== 'PLATFORM_OWNER' && requesterRole !== 'CompanyAdmin' && requesterRole !== 'SuperAdmin') {
    return res.status(403).json({ msg: 'Not authorized to export backups' });
  }

  // Validate orgId
  if (!mongoose.Types.ObjectId.isValid(orgId)) {
    return res.status(400).json({ msg: 'Invalid organization ID' });
  }

  try {
    // Fetch organization
    const organization = await Organization.findById(orgId);
    if (!organization) {
      return res.status(404).json({ msg: 'Organization not found' });
    }

    // Additional security: Company Admin can only export their own organization
    if (requesterRole !== 'PLATFORM_OWNER' && requesterRole !== 'SuperAdmin') {
      if (requesterPrefix !== organization.collectionPrefix) {
        return res.status(403).json({ msg: 'Not authorized to export this organization' });
      }
    }

    const collectionPrefix = organization.collectionPrefix;

    // Get all models for this organization
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);
    const ClassBatchCollection = createClassBatchModel(`${collectionPrefix}_classbatches`);
    const AttendanceCollection = createAttendanceModel(`${collectionPrefix}_attendance`);
    const LeaveRequestCollection = createLeaveRequestModel(`${collectionPrefix}_leaverequests`);

    // Fetch all data
    const [users, sessions, classBatches, attendanceRecords, leaveRequests] = await Promise.all([
      // Users: Exclude password field for security (or keep hashed if needed)
      UserCollection.find({}).select('-password').lean(),
      SessionCollection.find({}).lean(),
      ClassBatchCollection.find({}).lean(),
      AttendanceCollection.find({}).lean(),
      LeaveRequestCollection.find({}).lean(),
    ]);

    // Prepare backup data
    const backupData = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      organization: {
        id: organization._id.toString(),
        name: organization.name,
        collectionPrefix: organization.collectionPrefix,
        status: organization.status,
        createdAt: organization.createdAt,
        updatedAt: organization.updatedAt,
      },
      data: {
        users: users.map(user => ({
          ...user,
          _id: user._id.toString(),
          // Password is excluded for security
        })),
        sessions: sessions.map(session => ({
          ...session,
          _id: session._id.toString(),
          createdBy: session.createdBy?.toString(),
          sessionAdmin: session.sessionAdmin?.toString(),
          classBatchId: session.classBatchId?.toString(),
        })),
        classBatches: classBatches.map(batch => ({
          ...batch,
          _id: batch._id.toString(),
          createdBy: batch.createdBy?.toString(),
        })),
        attendance: attendanceRecords.map(attendance => ({
          ...attendance,
          _id: attendance._id.toString(),
          userId: attendance.userId?.toString(),
          sessionId: attendance.sessionId?.toString(),
        })),
        leaveRequests: leaveRequests.map(leave => ({
          ...leave,
          _id: leave._id.toString(),
          userId: leave.userId?.toString(),
          approvedBy: leave.approvedBy?.toString(),
          sendTo: leave.sendTo?.map((id: any) => id.toString()),
        })),
      },
      metadata: {
        userCount: users.length,
        sessionCount: sessions.length,
        classBatchCount: classBatches.length,
        attendanceCount: attendanceRecords.length,
        leaveRequestCount: leaveRequests.length,
      },
    };

    // Generate filename
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const safeOrgName = organization.name.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `backup-${safeOrgName}-${dateStr}.json.gz`;

    // Set response headers
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Convert to JSON string and compress using streaming
    const jsonData = JSON.stringify(backupData, null, 2);
    const gzipStream = zlib.createGzip();
    
    // Pipe JSON data through gzip stream to response
    gzipStream.pipe(res);
    gzipStream.write(jsonData, 'utf8');
    gzipStream.end();
  } catch (err: any) {
    console.error('Error exporting backup:', err.message);
    res.status(500).json({ msg: 'Server error while exporting backup' });
  }
};

// @route   POST /api/backup/:orgId/restore
// @desc    Restore organization from compressed backup file
// @access  Private (Platform Owner or Company Admin)
export const restoreBackup = async (req: Request, res: Response) => {
  const { orgId } = req.params;
  const { role: requesterRole, collectionPrefix: requesterPrefix, id: requesterId, email: requesterEmail } = req.user!;

  // Security check: Only Platform Owner or Company Admin can restore backups
  if (requesterRole !== 'PLATFORM_OWNER' && requesterRole !== 'CompanyAdmin' && requesterRole !== 'SuperAdmin') {
    return res.status(403).json({ msg: 'Not authorized to restore backups' });
  }

  // Validate orgId
  if (!mongoose.Types.ObjectId.isValid(orgId)) {
    return res.status(400).json({ msg: 'Invalid organization ID' });
  }

  // Check if file was uploaded
  if (!req.file) {
    return res.status(400).json({ msg: 'No backup file provided' });
  }

  // Validate file extension
  if (!req.file.originalname.endsWith('.gz')) {
    return res.status(400).json({ msg: 'Invalid file format. Expected .gz file' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Fetch organization
    const organization = await Organization.findById(orgId).session(session);
    if (!organization) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ msg: 'Organization not found' });
    }

    // Additional security: Company Admin can only restore their own organization
    if (requesterRole !== 'PLATFORM_OWNER' && requesterRole !== 'SuperAdmin') {
      if (requesterPrefix !== organization.collectionPrefix) {
        await session.abortTransaction();
        session.endSession();
        return res.status(403).json({ msg: 'Not authorized to restore this organization' });
      }
    }

    const collectionPrefix = organization.collectionPrefix;

    // Read and decompress the backup file from memory buffer
    if (!req.file.buffer) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ msg: 'No file data available' });
    }

    const compressedData = req.file.buffer;

    const decompressedData = await gunzip(compressedData);
    const jsonData = decompressedData.toString('utf8');
    const backupData = JSON.parse(jsonData);

    // Validate backup data structure
    if (!backupData.organization || !backupData.data) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ msg: 'Invalid backup file format' });
    }

    // CRITICAL SECURITY: Validate that backup organization matches target organization
    // This prevents cross-organization data leaks
    if (backupData.organization.collectionPrefix !== collectionPrefix) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        msg: 'Backup file organization does not match target organization. Cannot restore cross-organization data.' 
      });
    }

    // Additional validation: Ensure backup data structure has required arrays
    if (!Array.isArray(backupData.data.users) || 
        !Array.isArray(backupData.data.sessions) || 
        !Array.isArray(backupData.data.attendance) ||
        !Array.isArray(backupData.data.classBatches) ||
        !Array.isArray(backupData.data.leaveRequests)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        msg: 'Invalid backup data structure. Missing required data arrays.' 
      });
    }

    // Get all models for this organization
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);
    const ClassBatchCollection = createClassBatchModel(`${collectionPrefix}_classbatches`);
    const AttendanceCollection = createAttendanceModel(`${collectionPrefix}_attendance`);
    const LeaveRequestCollection = createLeaveRequestModel(`${collectionPrefix}_leaverequests`);

    // Restore data using upsert strategy
    const restoreStats = {
      users: { created: 0, updated: 0, skipped: 0 },
      sessions: { created: 0, updated: 0, skipped: 0 },
      classBatches: { created: 0, updated: 0, skipped: 0 },
      attendance: { created: 0, updated: 0, skipped: 0 },
      leaveRequests: { created: 0, updated: 0, skipped: 0 },
    };

    // Restore Users (with safety checks) - Using bulkWrite for atomicity
    if (backupData.data.users && Array.isArray(backupData.data.users)) {
      const userBulkOps: any[] = [];
      
      for (const userData of backupData.data.users) {
        // Safety: Do NOT restore Platform Owner accounts
        if (userData.role === 'PLATFORM_OWNER') {
          restoreStats.users.skipped++;
          continue;
        }

        // Safety: Do NOT restore if email matches Platform Owner pattern
        if (userData.email && userData.email.toLowerCase().includes('supermukul')) {
          restoreStats.users.skipped++;
          continue;
        }

        try {
          // Validate ObjectId
          if (!userData._id || !mongoose.Types.ObjectId.isValid(userData._id)) {
            console.error(`Invalid user ID: ${userData._id} for email: ${userData.email}`);
            restoreStats.users.skipped++;
            continue;
          }

          const userId = new mongoose.Types.ObjectId(userData._id);
          
          // Prepare update data (excluding password - handle separately)
          const updateData: any = {
            email: userData.email,
            role: userData.role,
            profile: userData.profile || {},
            profilePicture: userData.profilePicture,
            mustResetPassword: userData.mustResetPassword ?? true,
            customLeaveQuota: userData.customLeaveQuota,
            registeredDeviceId: userData.registeredDeviceId,
            registeredUserAgent: userData.registeredUserAgent,
            lastLogin: userData.lastLogin,
          };

          // Hash password for bulkWrite (pre-save hook doesn't run with bulkWrite)
          // Since passwords are excluded from export, we'll use a default hashed password
          const defaultPassword = 'Restore@123';
          const hashedPassword = await bcrypt.hash(defaultPassword, 10);

          // Use upsert for atomic operation
          userBulkOps.push({
            updateOne: {
              filter: { _id: userId },
              update: {
                $set: {
                  ...updateData,
                  password: hashedPassword, // Always set password (hashed) for both update and insert
                },
              },
              upsert: true,
            },
          });
        } catch (err: any) {
          console.error(`Error preparing user ${userData.email} for restore:`, err.message);
          restoreStats.users.skipped++;
        }
      }

      if (userBulkOps.length > 0) {
        const bulkResult = await UserCollection.bulkWrite(userBulkOps, { session });
        restoreStats.users.created = bulkResult.upsertedCount || 0;
        restoreStats.users.updated = bulkResult.modifiedCount || 0;
      }
    }

    // Restore Class Batches - Using bulkWrite for atomicity
    if (backupData.data.classBatches && Array.isArray(backupData.data.classBatches)) {
      const batchBulkOps: any[] = [];
      
      for (const batchData of backupData.data.classBatches) {
        try {
          // Validate ObjectId
          if (!batchData._id || !mongoose.Types.ObjectId.isValid(batchData._id)) {
            console.error(`Invalid class batch ID: ${batchData._id}`);
            restoreStats.classBatches.skipped++;
            continue;
          }

          const batchId = new mongoose.Types.ObjectId(batchData._id);
          
          batchBulkOps.push({
            updateOne: {
              filter: { _id: batchId },
              update: {
                $set: {
                  name: batchData.name,
                  description: batchData.description,
                  createdBy: batchData.createdBy,
                  defaultTime: batchData.defaultTime,
                  defaultLocation: batchData.defaultLocation,
                },
                $setOnInsert: {
                  _id: batchId,
                  organizationPrefix: collectionPrefix,
                },
              },
              upsert: true,
            },
          });
        } catch (err: any) {
          console.error(`Error preparing class batch ${batchData.name} for restore:`, err.message);
          restoreStats.classBatches.skipped++;
        }
      }

      if (batchBulkOps.length > 0) {
        const bulkResult = await ClassBatchCollection.bulkWrite(batchBulkOps, { session });
        restoreStats.classBatches.created = bulkResult.upsertedCount || 0;
        restoreStats.classBatches.updated = bulkResult.modifiedCount || 0;
      }
    }

    // Restore Sessions - Using bulkWrite for atomicity
    if (backupData.data.sessions && Array.isArray(backupData.data.sessions)) {
      const sessionBulkOps: any[] = [];
      
      for (const sessionData of backupData.data.sessions) {
        try {
          // Validate ObjectId
          if (!sessionData._id || !mongoose.Types.ObjectId.isValid(sessionData._id)) {
            console.error(`Invalid session ID: ${sessionData._id}`);
            restoreStats.sessions.skipped++;
            continue;
          }

          const sessionId = new mongoose.Types.ObjectId(sessionData._id);
          
          sessionBulkOps.push({
            updateOne: {
              filter: { _id: sessionId },
              update: {
                $set: {
                  name: sessionData.name,
                  description: sessionData.description,
                  frequency: sessionData.frequency,
                  startDate: sessionData.startDate,
                  endDate: sessionData.endDate,
                  startTime: sessionData.startTime,
                  endTime: sessionData.endTime,
                  locationType: sessionData.locationType,
                  sessionType: sessionData.sessionType,
                  physicalLocation: sessionData.physicalLocation,
                  virtualLocation: sessionData.virtualLocation,
                  location: sessionData.location,
                  geolocation: sessionData.geolocation,
                  radius: sessionData.radius,
                  assignedUsers: sessionData.assignedUsers,
                  weeklyDays: sessionData.weeklyDays,
                  sessionAdmin: sessionData.sessionAdmin,
                  classBatchId: sessionData.classBatchId,
                  isCancelled: sessionData.isCancelled,
                  cancellationReason: sessionData.cancellationReason,
                  organizationPrefix: collectionPrefix,
                },
                $setOnInsert: {
                  _id: sessionId,
                },
              },
              upsert: true,
            },
          });
        } catch (err: any) {
          console.error(`Error preparing session ${sessionData.name} for restore:`, err.message);
          restoreStats.sessions.skipped++;
        }
      }

      if (sessionBulkOps.length > 0) {
        const bulkResult = await SessionCollection.bulkWrite(sessionBulkOps, { session });
        restoreStats.sessions.created = bulkResult.upsertedCount || 0;
        restoreStats.sessions.updated = bulkResult.modifiedCount || 0;
      }
    }

    // Restore Attendance Records - Using bulkWrite for atomicity
    if (backupData.data.attendance && Array.isArray(backupData.data.attendance)) {
      const attendanceBulkOps: any[] = [];
      
      for (const attendanceData of backupData.data.attendance) {
        try {
          // Validate ObjectId
          if (!attendanceData._id || !mongoose.Types.ObjectId.isValid(attendanceData._id)) {
            console.error(`Invalid attendance ID: ${attendanceData._id}`);
            restoreStats.attendance.skipped++;
            continue;
          }

          const attendanceId = new mongoose.Types.ObjectId(attendanceData._id);
          
          attendanceBulkOps.push({
            updateOne: {
              filter: { _id: attendanceId },
              update: {
                $set: {
                  userId: attendanceData.userId,
                  sessionId: attendanceData.sessionId,
                  checkInTime: attendanceData.checkInTime,
                  locationVerified: attendanceData.locationVerified,
                  isLate: attendanceData.isLate,
                  lateByMinutes: attendanceData.lateByMinutes,
                  userLocation: attendanceData.userLocation,
                  deviceId: attendanceData.deviceId,
                },
                $setOnInsert: {
                  _id: attendanceId,
                },
              },
              upsert: true,
            },
          });
        } catch (err: any) {
          console.error(`Error preparing attendance record for restore:`, err.message);
          restoreStats.attendance.skipped++;
        }
      }

      if (attendanceBulkOps.length > 0) {
        const bulkResult = await AttendanceCollection.bulkWrite(attendanceBulkOps, { session });
        restoreStats.attendance.created = bulkResult.upsertedCount || 0;
        restoreStats.attendance.updated = bulkResult.modifiedCount || 0;
      }
    }

    // Restore Leave Requests - Using bulkWrite for atomicity
    if (backupData.data.leaveRequests && Array.isArray(backupData.data.leaveRequests)) {
      const leaveBulkOps: any[] = [];
      
      for (const leaveData of backupData.data.leaveRequests) {
        try {
          // Validate ObjectId
          if (!leaveData._id || !mongoose.Types.ObjectId.isValid(leaveData._id)) {
            console.error(`Invalid leave request ID: ${leaveData._id}`);
            restoreStats.leaveRequests.skipped++;
            continue;
          }

          const leaveId = new mongoose.Types.ObjectId(leaveData._id);
          
          leaveBulkOps.push({
            updateOne: {
              filter: { _id: leaveId },
              update: {
                $set: {
                  userId: leaveData.userId,
                  leaveType: leaveData.leaveType,
                  startDate: leaveData.startDate,
                  endDate: leaveData.endDate,
                  dates: leaveData.dates,
                  daysCount: leaveData.daysCount,
                  reason: leaveData.reason,
                  status: leaveData.status,
                  approvedBy: leaveData.approvedBy,
                  rejectionReason: leaveData.rejectionReason,
                  attachment: leaveData.attachment,
                  sendTo: leaveData.sendTo,
                  organizationPrefix: collectionPrefix,
                },
                $setOnInsert: {
                  _id: leaveId,
                },
              },
              upsert: true,
            },
          });
        } catch (err: any) {
          console.error(`Error preparing leave request for restore:`, err.message);
          restoreStats.leaveRequests.skipped++;
        }
      }

      if (leaveBulkOps.length > 0) {
        const bulkResult = await LeaveRequestCollection.bulkWrite(leaveBulkOps, { session });
        restoreStats.leaveRequests.created = bulkResult.upsertedCount || 0;
        restoreStats.leaveRequests.updated = bulkResult.modifiedCount || 0;
      }
    }

    // Commit transaction
    await session.commitTransaction();
    session.endSession();

    // No file cleanup needed - using memory storage

    // Log restore action to audit log
    await logAction(
      'RESTORE_BACKUP',
      {
        id: requesterId,
        email: requesterEmail,
        role: requesterRole,
        collectionPrefix,
      },
      organization._id,
      {
        message: `Restored backup for organization ${organization.name}`,
        restoreStats,
        backupVersion: backupData.version,
        backupExportDate: backupData.exportDate,
      },
      organization._id,
      organization.name
    );

    // Format response summary as requested
    const responseSummary = {
      usersRestored: restoreStats.users.created + restoreStats.users.updated,
      sessionsRestored: restoreStats.sessions.created + restoreStats.sessions.updated,
      classBatchesRestored: restoreStats.classBatches.created + restoreStats.classBatches.updated,
      attendanceRestored: restoreStats.attendance.created + restoreStats.attendance.updated,
      leaveRequestsRestored: restoreStats.leaveRequests.created + restoreStats.leaveRequests.updated,
    };

    res.status(200).json({
      msg: 'Backup restored successfully',
      stats: responseSummary,
      details: restoreStats, // Include detailed stats for debugging
    });
  } catch (err: any) {
    // Rollback transaction on error
    if (session) {
      try {
        await session.abortTransaction();
        session.endSession();
      } catch (txErr: any) {
        console.error('Error aborting transaction:', txErr.message);
      }
    }

    // No file cleanup needed - using memory storage

    console.error('Error restoring backup:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
      msg: 'Server error while restoring backup', 
      error: err.message,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
};

// @route   POST /api/backup/restore
// @desc    Restore organization from backup file (context-based)
// @access  Private (Company Admin or Platform Owner)
export const restoreData = async (req: Request, res: Response) => {
  const { role: requesterRole, collectionPrefix: requesterPrefix, id: requesterId, email: requesterEmail } = req.user!;

  // Security check: Only Platform Owner or Company Admin can restore backups
  if (requesterRole !== 'PLATFORM_OWNER' && requesterRole !== 'CompanyAdmin' && requesterRole !== 'SuperAdmin') {
    return res.status(403).json({ msg: 'Not authorized to restore backups' });
  }

  // Check if file was uploaded
  if (!req.file) {
    return res.status(400).json({ msg: 'No backup file provided' });
  }

  // Validate file extension (accept both .gz and .json)
  const fileExt = req.file.originalname.toLowerCase();
  const isGzip = fileExt.endsWith('.gz');
  const isJson = fileExt.endsWith('.json');

  if (!isGzip && !isJson) {
    return res.status(400).json({ msg: 'Invalid file format. Expected .gz or .json file' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Context Security: Identify target organization
    let targetOrgId: mongoose.Types.ObjectId;
    let organization: any;

    if (requesterRole === 'PLATFORM_OWNER') {
      // Platform Owner: Read from header or body param
      const orgIdFromHeader = req.headers['x-organization-id'] as string;
      const orgIdFromBody = req.body?.organizationId;
      const orgId = orgIdFromHeader || orgIdFromBody;

      if (!orgId || !mongoose.Types.ObjectId.isValid(orgId)) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ msg: 'Organization ID required in x-organization-id header or body' });
      }

      targetOrgId = new mongoose.Types.ObjectId(orgId);
      organization = await Organization.findById(targetOrgId).session(session);

      if (!organization) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ msg: 'Organization not found' });
      }
    } else {
      // Company Admin: Use their organization from collectionPrefix
      organization = await Organization.findOne({ collectionPrefix: requesterPrefix }).session(session);

      if (!organization) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ msg: 'Organization not found for user' });
      }

      targetOrgId = organization._id;
    }

    const collectionPrefix = organization.collectionPrefix;

    // Read and parse the backup file
    let backupData: any;

    if (isGzip) {
      // Decompress gzip file
      if (!req.file.buffer) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ msg: 'No file data available' });
      }

      const compressedData = req.file.buffer;
      const decompressedData = await gunzip(compressedData);
      const jsonData = decompressedData.toString('utf8');
      backupData = JSON.parse(jsonData);
    } else {
      // Parse JSON file directly
      if (!req.file.buffer) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ msg: 'No file data available' });
      }

      const jsonData = req.file.buffer.toString('utf8');
      backupData = JSON.parse(jsonData);
    }

    // Validation: Ensure JSON has valid arrays
    if (!backupData.data || typeof backupData.data !== 'object') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ msg: 'Invalid backup file format. Missing data object' });
    }

    const requiredArrays = ['users', 'sessions', 'attendance', 'classBatches', 'leaveRequests'];
    for (const arrayName of requiredArrays) {
      if (!Array.isArray(backupData.data[arrayName])) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ msg: `Invalid backup file format. Missing or invalid ${arrayName} array` });
      }
    }

    // Get all models for this organization
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);
    const ClassBatchCollection = createClassBatchModel(`${collectionPrefix}_classbatches`);
    const AttendanceCollection = createAttendanceModel(`${collectionPrefix}_attendance`);
    const LeaveRequestCollection = createLeaveRequestModel(`${collectionPrefix}_leaverequests`);

    // Restore counts
    const restoreCounts = {
      users: 0,
      sessions: 0,
      attendance: 0,
      classBatches: 0,
      leaveRequests: 0,
    };

    // Restore Users using bulkWrite (prevents double-hashing)
    // SECURITY NOTE: This backup includes hashed passwords to ensure full account recovery. Keep these files secure.
    // CRITICAL: Using $set with bulkWrite prevents double-hashing (pre-save hook doesn't run)
    // DO NOT use .save() as it would re-hash the already hashed password, breaking authentication
    if (backupData.data.users && backupData.data.users.length > 0) {
      // Filter out Platform Owner accounts for security
      const validUsers = backupData.data.users.filter((user: any) => {
        // Safety: Skip Platform Owner accounts
        if (user.role === 'PLATFORM_OWNER') {
          return false;
        }
        // Safety: Skip if email matches Platform Owner pattern
        if (user.email && user.email.toLowerCase().includes('supermukul')) {
          return false;
        }
        return true;
      });

      const userOps = validUsers.map((user: any) => {
        // SECURITY: Remove __v to prevent version errors
        const { __v, ...userData } = user;
        
        // Normalize email to lowercase
        const normalizedEmail = userData.email?.toLowerCase();

        return {
          updateOne: {
            filter: { email: normalizedEmail },
            // CRITICAL: $set writes data DIRECTLY to the DB.
            // It bypasses the Mongoose 'pre-save' hook, so it won't re-hash the password.
            update: { 
              $set: {
                ...userData,
                email: normalizedEmail,
              }
            },
            upsert: true
          }
        };
      });

      // Execute the bulk operation
      if (userOps.length > 0) {
        const bulkResult = await UserCollection.bulkWrite(userOps, { session });
        restoreCounts.users = bulkResult.modifiedCount + bulkResult.upsertedCount;
      }
    }

    // Restore Class Batches
    for (const batchData of backupData.data.classBatches || []) {
      try {
        const updateData = {
          name: batchData.name,
          description: batchData.description,
          createdBy: batchData.createdBy ? new mongoose.Types.ObjectId(batchData.createdBy) : undefined,
          defaultTime: batchData.defaultTime,
          defaultLocation: batchData.defaultLocation,
          organizationPrefix: collectionPrefix,
        };

        await ClassBatchCollection.findOneAndUpdate(
          { _id: batchData._id ? new mongoose.Types.ObjectId(batchData._id) : new mongoose.Types.ObjectId() },
          { $set: updateData },
          { upsert: true, session, new: true }
        );

        restoreCounts.classBatches++;
      } catch (err: any) {
        console.error(`Error restoring class batch ${batchData.name}:`, err.message);
      }
    }

    // Restore Sessions
    for (const sessionData of backupData.data.sessions || []) {
      try {
        const updateData = {
          name: sessionData.name,
          description: sessionData.description,
          frequency: sessionData.frequency,
          startDate: sessionData.startDate,
          endDate: sessionData.endDate,
          startTime: sessionData.startTime,
          endTime: sessionData.endTime,
          locationType: sessionData.locationType,
          sessionType: sessionData.sessionType,
          physicalLocation: sessionData.physicalLocation,
          virtualLocation: sessionData.virtualLocation,
          location: sessionData.location,
          geolocation: sessionData.geolocation,
          radius: sessionData.radius,
          assignedUsers: sessionData.assignedUsers,
          weeklyDays: sessionData.weeklyDays,
          sessionAdmin: sessionData.sessionAdmin ? new mongoose.Types.ObjectId(sessionData.sessionAdmin) : undefined,
          classBatchId: sessionData.classBatchId ? new mongoose.Types.ObjectId(sessionData.classBatchId) : undefined,
          isCancelled: sessionData.isCancelled,
          cancellationReason: sessionData.cancellationReason,
          organizationPrefix: collectionPrefix,
        };

        await SessionCollection.findOneAndUpdate(
          { _id: sessionData._id ? new mongoose.Types.ObjectId(sessionData._id) : new mongoose.Types.ObjectId() },
          { $set: updateData },
          { upsert: true, session, new: true }
        );

        restoreCounts.sessions++;
      } catch (err: any) {
        console.error(`Error restoring session ${sessionData.name}:`, err.message);
      }
    }

    // Restore Attendance Records (match by Session ID + User ID)
    for (const attendanceData of backupData.data.attendance || []) {
      try {
        const updateData = {
          userId: attendanceData.userId ? new mongoose.Types.ObjectId(attendanceData.userId) : undefined,
          sessionId: attendanceData.sessionId ? new mongoose.Types.ObjectId(attendanceData.sessionId) : undefined,
          checkInTime: attendanceData.checkInTime,
          locationVerified: attendanceData.locationVerified,
          isLate: attendanceData.isLate,
          lateByMinutes: attendanceData.lateByMinutes,
          userLocation: attendanceData.userLocation,
          deviceId: attendanceData.deviceId,
        };

        // Match by sessionId + userId combination
        const filter = {
          sessionId: updateData.sessionId,
          userId: updateData.userId,
        };

        await AttendanceCollection.findOneAndUpdate(
          filter,
          { $set: updateData },
          { upsert: true, session, new: true }
        );

        restoreCounts.attendance++;
      } catch (err: any) {
        console.error(`Error restoring attendance record:`, err.message);
      }
    }

    // Restore Leave Requests
    for (const leaveData of backupData.data.leaveRequests || []) {
      try {
        const updateData = {
          userId: leaveData.userId ? new mongoose.Types.ObjectId(leaveData.userId) : undefined,
          leaveType: leaveData.leaveType,
          startDate: leaveData.startDate,
          endDate: leaveData.endDate,
          dates: leaveData.dates,
          daysCount: leaveData.daysCount,
          reason: leaveData.reason,
          status: leaveData.status,
          approvedBy: leaveData.approvedBy ? new mongoose.Types.ObjectId(leaveData.approvedBy) : undefined,
          rejectionReason: leaveData.rejectionReason,
          attachment: leaveData.attachment,
          sendTo: leaveData.sendTo?.map((id: string) => new mongoose.Types.ObjectId(id)),
          organizationPrefix: collectionPrefix,
        };

        await LeaveRequestCollection.findOneAndUpdate(
          { _id: leaveData._id ? new mongoose.Types.ObjectId(leaveData._id) : new mongoose.Types.ObjectId() },
          { $set: updateData },
          { upsert: true, session, new: true }
        );

        restoreCounts.leaveRequests++;
      } catch (err: any) {
        console.error(`Error restoring leave request:`, err.message);
      }
    }

    // Commit transaction
    await session.commitTransaction();
    session.endSession();

    // Log restore action to audit log
    await logAction(
      'RESTORE_BACKUP',
      {
        id: requesterId,
        email: requesterEmail,
        role: requesterRole,
        collectionPrefix,
      },
      targetOrgId,
      {
        message: `Restored backup for organization ${organization.name}`,
        restoreCounts,
        backupVersion: backupData.version || '1.0',
        backupExportDate: backupData.exportDate || new Date().toISOString(),
      },
      targetOrgId,
      organization.name
    );

    res.status(200).json({
      msg: 'Backup restored successfully',
      users: restoreCounts.users,
      sessions: restoreCounts.sessions,
      attendance: restoreCounts.attendance,
      classBatches: restoreCounts.classBatches,
      leaveRequests: restoreCounts.leaveRequests,
    });
  } catch (err: any) {
    // Rollback transaction on error
    if (session) {
      try {
        await session.abortTransaction();
        session.endSession();
      } catch (txErr: any) {
        console.error('Error aborting transaction:', txErr.message);
      }
    }

    console.error('Error restoring backup:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
      msg: 'Server error while restoring backup', 
      error: err.message,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
};

// @route   GET /api/backup/stream
// @desc    Stream organization backup as JSON (zero-storage, no disk writes)
// @access  Private (Company Admin or Platform Owner)
export const streamBackup = async (req: Request, res: Response) => {
  const { role: requesterRole, collectionPrefix: requesterPrefix, id: requesterId, email: requesterEmail } = req.user!;

  // Security check: Only Platform Owner or Company Admin can stream backups
  if (requesterRole !== 'PLATFORM_OWNER' && requesterRole !== 'CompanyAdmin' && requesterRole !== 'SuperAdmin') {
    return res.status(403).json({ msg: 'Not authorized to stream backups' });
  }

  try {
    // Identify Target Org
    let targetOrgId: mongoose.Types.ObjectId;
    let organization: any;

    if (requesterRole === 'PLATFORM_OWNER') {
      // Platform Owner: Read orgId from query params
      const orgId = req.query.orgId as string;

      if (!orgId || !mongoose.Types.ObjectId.isValid(orgId)) {
        return res.status(400).json({ msg: 'Organization ID required in query parameter (orgId)' });
      }

      targetOrgId = new mongoose.Types.ObjectId(orgId);
      organization = await Organization.findById(targetOrgId);

      if (!organization) {
        return res.status(404).json({ msg: 'Organization not found' });
      }
    } else {
      // Company Admin: Use their organization from collectionPrefix
      organization = await Organization.findOne({ collectionPrefix: requesterPrefix });

      if (!organization) {
        return res.status(404).json({ msg: 'Organization not found for user' });
      }

      targetOrgId = organization._id;
    }

    const collectionPrefix = organization.collectionPrefix;

    // Get all models for this organization
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);
    const ClassBatchCollection = createClassBatchModel(`${collectionPrefix}_classbatches`);
    const AttendanceCollection = createAttendanceModel(`${collectionPrefix}_attendance`);
    const LeaveRequestCollection = createLeaveRequestModel(`${collectionPrefix}_leaverequests`);

    // Fetch all data (streaming from database, but we need all data before streaming response)
    // SECURITY NOTE: This backup includes hashed passwords to ensure full account recovery. Keep these files secure.
    const [users, sessions, classBatches, attendanceRecords, leaveRequests] = await Promise.all([
      // Users: FORCE include the password hash (Mongoose excludes it by default)
      // Using select('+password') to override the select: false in schema
      UserCollection.find({}).select('+password').lean(),
      SessionCollection.find({}).lean(),
      ClassBatchCollection.find({}).lean(),
      AttendanceCollection.find({}).lean(),
      LeaveRequestCollection.find({}).lean(),
    ]);

    // Prepare backup data
    const backupData = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      organization: {
        id: organization._id.toString(),
        name: organization.name,
        collectionPrefix: organization.collectionPrefix,
        status: organization.status,
        createdAt: organization.createdAt,
        updatedAt: organization.updatedAt,
      },
      data: {
        users: users.map(user => ({
          ...user,
          _id: user._id.toString(),
          // Password is already included via select('+password')
        })),
        sessions: sessions.map(session => ({
          ...session,
          _id: session._id.toString(),
          createdBy: session.createdBy?.toString(),
          sessionAdmin: session.sessionAdmin?.toString(),
          classBatchId: session.classBatchId?.toString(),
        })),
        classBatches: classBatches.map(batch => ({
          ...batch,
          _id: batch._id.toString(),
          createdBy: batch.createdBy?.toString(),
        })),
        attendance: attendanceRecords.map(attendance => ({
          ...attendance,
          _id: attendance._id.toString(),
          userId: attendance.userId?.toString(),
          sessionId: attendance.sessionId?.toString(),
        })),
        leaveRequests: leaveRequests.map(leave => ({
          ...leave,
          _id: leave._id.toString(),
          userId: leave.userId?.toString(),
          approvedBy: leave.approvedBy?.toString(),
          sendTo: leave.sendTo?.map((id: any) => id.toString()),
        })),
      },
      metadata: {
        userCount: users.length,
        sessionCount: sessions.length,
        classBatchCount: classBatches.length,
        attendanceCount: attendanceRecords.length,
        leaveRequestCount: leaveRequests.length,
      },
    };

    // Generate filename
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const safeOrgName = organization.name.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `backup-${safeOrgName}-${dateStr}.json`;

    // Set response headers for streaming JSON
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Stream JSON directly to response (zero-storage: no disk writes)
    // Convert to JSON string and stream it
    try {
      const jsonData = JSON.stringify(backupData, null, 2);
      
      // Stream the JSON data directly to response
      // This ensures the file exists only during the download process
      res.write(jsonData);
      res.end();
    } catch (jsonError: any) {
      console.error('Error serializing backup data to JSON:', jsonError);
      if (!res.headersSent) {
        res.status(500).json({ 
          msg: 'Error serializing backup data',
          error: process.env.NODE_ENV === 'development' ? jsonError.message : undefined
        });
      }
    }

  } catch (err: any) {
    console.error('Error streaming backup:', err);
    console.error('Error stack:', err.stack);
    // Only send error if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({ 
        msg: 'Server error while streaming backup',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  }
};

