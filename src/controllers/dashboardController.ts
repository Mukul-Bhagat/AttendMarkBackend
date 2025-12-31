import { Request, Response } from 'express';
import { Types } from 'mongoose';
import createClassBatchModel from '../models/ClassBatch';
import createSessionModel from '../models/Session';
import createUserModel from '../models/User';
import createAttendanceModel from '../models/Attendance';
import createLeaveRequestModel from '../models/LeaveRequest';

// @route   GET /api/dashboard/stats
// @desc    Get dashboard statistics for the logged-in user's organization
// @access  Private
export const getDashboardStats = async (req: Request, res: Response) => {
  const { collectionPrefix, organizationName, role, id: userId } = req.user!;
  const isEndUser = role === 'EndUser';

  try {
    // Get organization-specific models
    const ClassBatchCollection = createClassBatchModel(`${collectionPrefix}_classbatches`);
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const AttendanceCollection = createAttendanceModel(`${collectionPrefix}_attendance`);

    // 1. Organization Name
    const orgName = organizationName || collectionPrefix;

    let activeClasses = 0;
    let totalUsers = 0;
    let attendancePercentage = 0;

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    if (isEndUser) {
      // ============ END USER SPECIFIC STATS ============
      // Only show stats for sessions the user is assigned to

      // Find all sessions where this user is in assignedUsers
      const userSessions = await SessionCollection.find({
        'assignedUsers.userId': userId.toString(),
        isCancelled: { $ne: true },
      });

      // 2. Active Classes - Count distinct classBatchIds from user's assigned sessions
      const distinctClassBatchIds = new Set<string>();
      for (const session of userSessions) {
        if (session.classBatchId) {
          distinctClassBatchIds.add(session.classBatchId.toString());
        }
      }
      activeClasses = distinctClassBatchIds.size;

      // 3. Total Users - Not relevant for EndUsers, return 0
      totalUsers = 0;

      // 4. This Month's Attendance Percentage (for this user only)
      const userSessionsThisMonth = userSessions.filter((session: any) => {
        const sessionDate = new Date(session.startDate);
        return sessionDate >= startOfMonth && sessionDate <= endOfMonth;
      });

      let totalUserSessions = userSessionsThisMonth.length;
      let userPresentCount = 0;

      for (const session of userSessionsThisMonth) {
        // Check if this user has an attendance record for this session
        const attendanceRecord = await AttendanceCollection.findOne({
          sessionId: session._id.toString(),
          userId: userId.toString(),
        });

        if (attendanceRecord) {
          userPresentCount++;
        }
      }

      if (totalUserSessions > 0) {
        attendancePercentage = Math.round((userPresentCount / totalUserSessions) * 100);
      }
    } else {
      // ============ ADMIN/MANAGER STATS ============
      // Organization-wide stats for admins

      // 2. Active Classes - Count all ClassBatch documents for this org
      activeClasses = await ClassBatchCollection.countDocuments();

      // 3. Total Users - Count all EndUser documents for this org
      totalUsers = await UserCollection.countDocuments({ role: 'EndUser' });

      // 4. This Month's Attendance Percentage (organization-wide)
      const sessionsThisMonth = await SessionCollection.find({
        startDate: {
          $gte: startOfMonth,
          $lte: endOfMonth,
        },
        isCancelled: { $ne: true },
      });

      let totalAssignedUsers = 0;
      let totalPresent = 0;

      for (const session of sessionsThisMonth) {
        const assignedCount = session.assignedUsers?.length || 0;
        totalAssignedUsers += assignedCount;

        if (assignedCount > 0) {
          const attendanceRecords = await AttendanceCollection.find({
            sessionId: session._id.toString(),
          });

          const presentUserIds = new Set(
            attendanceRecords.map((record: any) => record.userId?.toString())
          );

          totalPresent += presentUserIds.size;
        }
      }

      if (totalAssignedUsers > 0) {
        attendancePercentage = Math.round((totalPresent / totalAssignedUsers) * 100);
      }
    }

    // 5. Get Upcoming Leave (for current user)
    let upcomingLeave = null;
    try {
      const LeaveRequestCollection = createLeaveRequestModel(`${collectionPrefix}_leave_requests`);
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Set to start of day for comparison

      // Convert userId to ObjectId for proper query
      const userIdObjectId = new Types.ObjectId(userId.toString());

      const upcomingLeaveRequest = await LeaveRequestCollection.findOne({
        userId: userIdObjectId,
        status: 'Approved',
        endDate: { $gte: today }, // Future or ongoing leaves
      })
        .sort({ startDate: 1 }) // Sort by startDate ascending (nearest first)
        .limit(1)
        .select('startDate endDate dates leaveType')
        .lean();

      if (upcomingLeaveRequest) {
        // Ensure dates are properly serialized
        const startDateValue = upcomingLeaveRequest.startDate instanceof Date 
          ? upcomingLeaveRequest.startDate 
          : new Date(upcomingLeaveRequest.startDate);
        const endDateValue = upcomingLeaveRequest.endDate instanceof Date 
          ? upcomingLeaveRequest.endDate 
          : new Date(upcomingLeaveRequest.endDate);
        
        // Validate dates before serializing
        if (!isNaN(startDateValue.getTime()) && !isNaN(endDateValue.getTime())) {
          // Serialize dates array if it exists
          let datesArray: string[] | undefined;
          if (upcomingLeaveRequest.dates && Array.isArray(upcomingLeaveRequest.dates)) {
            datesArray = upcomingLeaveRequest.dates
              .map((date: any) => {
                const d = date instanceof Date ? date : new Date(date);
                return !isNaN(d.getTime()) ? d.toISOString().split('T')[0] : null;
              })
              .filter((d: string | null): d is string => d !== null);
          }

          upcomingLeave = {
            startDate: startDateValue.toISOString(),
            endDate: endDateValue.toISOString(),
            leaveType: upcomingLeaveRequest.leaveType,
            ...(datesArray && datesArray.length > 0 && { dates: datesArray }),
          };
        }
      }
    } catch (err: any) {
      // If leave request collection doesn't exist or error occurs, just continue without it
      console.error('Error fetching upcoming leave:', {
        message: err?.message || 'Unknown error',
        stack: err?.stack,
        collectionPrefix,
        userId: userId?.toString(),
      });
      // Set to null to ensure the response continues
      upcomingLeave = null;
    }

    res.json({
      orgName,
      activeClasses,
      totalUsers,
      attendancePercentage,
      upcomingLeave,
    });
  } catch (err: any) {
    console.error('Error fetching dashboard stats:', err);
    res.status(500).json({ msg: 'Server error while fetching dashboard stats' });
  }
};

