import { Request, Response } from 'express';
import mongoose from 'mongoose';
import createSessionModel from '../models/Session';
import createAttendanceModel from '../models/Attendance';
import createUserModel from '../models/User';

// @route   GET /api/reports/analytics
// @desc    Get class-level analytics (timeline, summary, top performers/defaulters)
// @access  Private (Manager, SuperAdmin only)
export const getClassAnalytics = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix, role: userRole } = req.user!;
    const { classBatchId, startDate, endDate } = req.query;

    // Check if user has permission (Manager, SuperAdmin, or Platform Owner)
    if (userRole !== 'Manager' && userRole !== 'SuperAdmin' && userRole !== 'PLATFORM_OWNER') {
      return res.status(403).json({ msg: 'Not authorized to view analytics' });
    }

    // Validate required parameters
    if (!classBatchId) {
      return res.status(400).json({ msg: 'classBatchId is required' });
    }

    if (!mongoose.Types.ObjectId.isValid(classBatchId as string)) {
      return res.status(400).json({ msg: 'Invalid classBatchId format' });
    }

    // Parse dates
    const start = startDate ? new Date(startDate as string) : new Date(0); // Default to epoch if not provided
    const end = endDate ? new Date(endDate as string) : new Date(); // Default to now if not provided

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ msg: 'Invalid date format. Use ISO 8601 format (YYYY-MM-DD)' });
    }

    // Load organization-specific collections
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);
    const AttendanceCollection = createAttendanceModel(`${collectionPrefix}_attendance`);
    const UserCollection = createUserModel(`${collectionPrefix}_users`);

    // Find all sessions for this class within the date range (excluding cancelled sessions)
    const sessions = await SessionCollection.find({
      classBatchId: new mongoose.Types.ObjectId(classBatchId as string),
      startDate: { $gte: start, $lte: end },
      isCancelled: { $ne: true }, // Exclude cancelled sessions
    }).lean();

    if (sessions.length === 0) {
      return res.json({
        timeline: [],
        summary: { present: 0, absent: 0 },
        topPerformers: [],
        defaulters: [],
      });
    }

    const sessionIds = sessions.map(s => s._id);

    // Get all attendance records for these sessions
    const attendanceRecords = await AttendanceCollection.find({
      sessionId: { $in: sessionIds },
    }).lean();

    // Create a map of sessionId -> session for quick lookup
    const sessionMap = new Map();
    sessions.forEach(session => {
      sessionMap.set(session._id.toString(), session);
    });

    // Create a map of sessionId -> attendance records
    const attendanceBySession = new Map();
    attendanceRecords.forEach(record => {
      const sessionIdStr = record.sessionId?.toString() || '';
      if (!attendanceBySession.has(sessionIdStr)) {
        attendanceBySession.set(sessionIdStr, []);
      }
      attendanceBySession.get(sessionIdStr).push(record);
    });

    // A. Timeline Graph: Group by date and calculate attendance percentage with Late count
    const timelineMap = new Map<string, { totalAssigned: number; totalVerified: number; totalLate: number }>();

    sessions.forEach(session => {
      const sessionDate = new Date(session.startDate).toISOString().split('T')[0]; // YYYY-MM-DD
      // Exclude users on leave from assigned count
      const assignedCount = (session.assignedUsers?.length || 0) - 
        (session.assignedUsers?.filter((u: any) => u.attendanceStatus === 'On Leave').length || 0);
      const sessionAttendance = attendanceBySession.get(session._id.toString()) || [];
      const verifiedCount = sessionAttendance.filter((a: any) => a.locationVerified === true).length;
      const lateCount = sessionAttendance.filter((a: any) => a.isLate === true).length;

      if (timelineMap.has(sessionDate)) {
        const existing = timelineMap.get(sessionDate)!;
        existing.totalAssigned += assignedCount;
        existing.totalVerified += verifiedCount;
        existing.totalLate += lateCount;
      } else {
        timelineMap.set(sessionDate, {
          totalAssigned: assignedCount,
          totalVerified: verifiedCount,
          totalLate: lateCount,
        });
      }
    });

    const timeline = Array.from(timelineMap.entries())
      .map(([date, data]) => ({
        date,
        percentage: data.totalAssigned > 0 
          ? Math.round((data.totalVerified / data.totalAssigned) * 100 * 100) / 100 // Round to 2 decimal places
          : 0,
        lateCount: data.totalLate, // Add late count for each day
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // B. Summary Pie Chart: Total Present, Late, and Absent
    let totalPresent = 0;
    let totalLate = 0;
    let totalAbsent = 0;

    sessions.forEach(session => {
      // Exclude users on leave from assigned count
      const onLeaveCount = session.assignedUsers?.filter((u: any) => u.attendanceStatus === 'On Leave').length || 0;
      const assignedCount = (session.assignedUsers?.length || 0) - onLeaveCount;
      const sessionAttendance = attendanceBySession.get(session._id.toString()) || [];
      const verifiedCount = sessionAttendance.filter((a: any) => a.locationVerified === true).length;
      const lateCount = sessionAttendance.filter((a: any) => a.isLate === true).length;
      const onTimeCount = verifiedCount - lateCount; // Present but not late
      
      totalPresent += onTimeCount;
      totalLate += lateCount;
      totalAbsent += assignedCount - verifiedCount;
    });

    const summary = {
      present: totalPresent,
      late: totalLate,
      absent: totalAbsent,
    };

    // C. Top 5 Performers & Defaulters: Calculate per-user attendance with punctuality focus
    const userStatsMap = new Map<string, { assigned: number; verified: number; onTime: number; late: number; absent: number; name: string; email: string }>();

    // Collect all unique user IDs from assignedUsers across all sessions
    sessions.forEach(session => {
      const sessionAttendance = attendanceBySession.get(session._id.toString()) || [];
      const verifiedUserIds = new Set(
        sessionAttendance
          .filter((a: any) => a.locationVerified === true)
          .map((a: any) => a.userId?.toString())
      );
      const lateUserIds = new Set(
        sessionAttendance
          .filter((a: any) => a.isLate === true)
          .map((a: any) => a.userId?.toString())
      );
      const onTimeUserIds = new Set(
        sessionAttendance
          .filter((a: any) => a.locationVerified === true && !a.isLate)
          .map((a: any) => a.userId?.toString())
      );

      if (session.assignedUsers && Array.isArray(session.assignedUsers)) {
        session.assignedUsers.forEach((assignedUser: any) => {
          const userId = assignedUser.userId?.toString() || '';
          if (!userId) return;

          // Skip users on leave - they don't count towards attendance stats
          if (assignedUser.attendanceStatus === 'On Leave') {
            return;
          }

          if (!userStatsMap.has(userId)) {
            userStatsMap.set(userId, {
              assigned: 0,
              verified: 0,
              onTime: 0,
              late: 0,
              absent: 0,
              name: `${assignedUser.firstName || ''} ${assignedUser.lastName || ''}`.trim() || 'Unknown',
              email: assignedUser.email || '',
            });
          }

          const stats = userStatsMap.get(userId)!;
          stats.assigned += 1;
          if (verifiedUserIds.has(userId)) {
            stats.verified += 1;
            if (onTimeUserIds.has(userId)) {
              stats.onTime += 1;
            } else if (lateUserIds.has(userId)) {
              stats.late += 1;
            }
          } else {
            stats.absent += 1;
          }
        });
      }
    });

    // Calculate percentages and create arrays
    const userStats = Array.from(userStatsMap.entries()).map(([userId, stats]) => ({
      userId,
      name: stats.name,
      email: stats.email,
      assigned: stats.assigned,
      verified: stats.verified,
      onTime: stats.onTime,
      late: stats.late,
      absent: stats.absent,
      percentage: stats.assigned > 0 
        ? Math.round((stats.verified / stats.assigned) * 100 * 100) / 100 
        : 0,
    }));

    // Sort and get top 5 performers: Prioritize Total Present AND Not Late (highest count of Verified AND isLate=false)
    const topPerformers = userStats
      .filter(u => u.assigned > 0) // Only include users who were assigned to at least one session
      .sort((a, b) => {
        // Primary sort: Highest onTime count (Present AND Not Late)
        if (b.onTime !== a.onTime) {
          return b.onTime - a.onTime;
        }
        // Secondary sort: Highest verified count
        if (b.verified !== a.verified) {
          return b.verified - a.verified;
        }
        // Tertiary sort: Highest percentage
        return b.percentage - a.percentage;
      })
      .slice(0, 5)
      .map(u => ({
        name: u.name,
        email: u.email,
        percentage: u.percentage,
        verified: u.verified,
        assigned: u.assigned,
      }));

    // Sort and get top 5 defaulters: Prioritize Absent OR Frequently Late (highest count of Absent + Late)
    const defaulters = userStats
      .filter(u => u.assigned > 0) // Only include users who were assigned to at least one session
      .sort((a, b) => {
        // Primary sort: Highest (Absent + Late) count
        const aDefaulterScore = a.absent + a.late;
        const bDefaulterScore = b.absent + b.late;
        if (bDefaulterScore !== aDefaulterScore) {
          return bDefaulterScore - aDefaulterScore;
        }
        // Secondary sort: Highest absent count
        if (b.absent !== a.absent) {
          return b.absent - a.absent;
        }
        // Tertiary sort: Lowest percentage
        return a.percentage - b.percentage;
      })
      .slice(0, 5)
      .map(u => ({
        name: u.name,
        email: u.email,
        percentage: u.percentage,
        verified: u.verified,
        assigned: u.assigned,
      }));

    res.json({
      timeline,
      summary,
      topPerformers,
      defaulters,
    });
  } catch (err: any) {
    console.error('Error in getClassAnalytics:', err);
    res.status(500).json({ msg: 'Server error while fetching analytics', error: err.message });
  }
};

// @route   GET /api/reports/logs
// @desc    Get session logs for a specific class and date range
// @access  Private (Manager, SuperAdmin only)
export const getSessionLogs = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix, role: userRole } = req.user!;
    const { classBatchId, startDate, endDate } = req.query;

    // Check if user has permission (Manager, SuperAdmin, or Platform Owner)
    if (userRole !== 'Manager' && userRole !== 'SuperAdmin' && userRole !== 'PLATFORM_OWNER') {
      return res.status(403).json({ msg: 'Not authorized to view session logs' });
    }

    // Validate required parameters
    if (!classBatchId) {
      return res.status(400).json({ msg: 'classBatchId is required' });
    }

    if (!mongoose.Types.ObjectId.isValid(classBatchId as string)) {
      return res.status(400).json({ msg: 'Invalid classBatchId format' });
    }

    // Parse dates
    const start = startDate ? new Date(startDate as string) : new Date(0); // Default to epoch if not provided
    const end = endDate ? new Date(endDate as string) : new Date(); // Default to now if not provided

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ msg: 'Invalid date format. Use ISO 8601 format (YYYY-MM-DD)' });
    }

    // Load organization-specific collections
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);
    const AttendanceCollection = createAttendanceModel(`${collectionPrefix}_attendance`);

    // Find all sessions for this class within the date range (excluding cancelled sessions)
    const sessions = await SessionCollection.find({
      classBatchId: new mongoose.Types.ObjectId(classBatchId as string),
      startDate: { $gte: start, $lte: end },
      isCancelled: { $ne: true }, // Exclude cancelled sessions
    })
      .sort({ startDate: -1 }) // Sort by date (newest first)
      .lean();

    if (sessions.length === 0) {
      return res.json([]);
    }

    const sessionIds = sessions.map(s => s._id);

    // Get all attendance records for these sessions
    const attendanceRecords = await AttendanceCollection.find({
      sessionId: { $in: sessionIds },
    }).lean();

    // Create a map of sessionId -> attendance records
    const attendanceBySession = new Map();
    attendanceRecords.forEach(record => {
      const sessionIdStr = record.sessionId?.toString() || '';
      if (!attendanceBySession.has(sessionIdStr)) {
        attendanceBySession.set(sessionIdStr, []);
      }
      attendanceBySession.get(sessionIdStr).push(record);
    });

    // Get current date for status determination
    const now = new Date();
    now.setHours(0, 0, 0, 0); // Set to start of day for comparison

    // Build the response array
    const logs = sessions.map(session => {
      const sessionIdStr = session._id.toString();
      const totalUsers = session.assignedUsers?.length || 0;
      const sessionAttendance = attendanceBySession.get(sessionIdStr) || [];
      const presentCount = sessionAttendance.filter((a: any) => a.locationVerified === true).length;
      const lateCount = sessionAttendance.filter((a: any) => a.isLate === true).length;
      const absentCount = totalUsers - presentCount;

      // Determine status based on session date
      const sessionDate = new Date(session.startDate);
      sessionDate.setHours(0, 0, 0, 0);
      let status = 'Upcoming';
      if (sessionDate < now) {
        status = 'Completed';
      } else if (sessionDate.getTime() === now.getTime()) {
        status = 'Today';
      }

      return {
        _id: sessionIdStr,
        name: session.name || 'Unnamed Session',
        date: new Date(session.startDate).toISOString().split('T')[0], // YYYY-MM-DD format
        totalUsers,
        presentCount,
        lateCount,
        absentCount,
        status,
      };
    });

    res.json(logs);
  } catch (err: any) {
    console.error('Error in getSessionLogs:', err);
    res.status(500).json({ msg: 'Server error while fetching session logs', error: err.message });
  }
};

