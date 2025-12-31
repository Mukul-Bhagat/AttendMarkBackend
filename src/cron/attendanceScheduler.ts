import cron from 'node-cron';
import mongoose from 'mongoose';
import Organization from '../models/Organization';
import createSessionModel from '../models/Session';
import createAttendanceModel from '../models/Attendance';
import createLeaveRequestModel from '../models/LeaveRequest';

/**
 * Process end-of-session attendance marking
 * This function finds all sessions that have ended and marks unverified users as Absent
 */
const processEndOfSessionAttendance = async () => {
  try {
    console.log('[Cron] Starting end-of-session attendance processing...');
    
    // Get all organization prefixes
    const organizations = await Organization.find().select('collectionPrefix');
    
    if (organizations.length === 0) {
      console.log('[Cron] No organizations found. Skipping processing.');
      return;
    }

    let totalProcessed = 0;
    let totalMarkedAbsent = 0;

    // Process each organization
    for (const org of organizations) {
      const collectionPrefix = org.collectionPrefix;
      
      try {
        // Get organization-specific models
        const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);
        const AttendanceCollection = createAttendanceModel(`${collectionPrefix}_attendance`);
        const LeaveRequestCollection = createLeaveRequestModel(`${collectionPrefix}_leave_requests`);

        // Get current time in IST (UTC+5:30)
        const nowUTC = new Date();
        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in milliseconds
        const nowInIST = new Date(nowUTC.getTime() + IST_OFFSET_MS);
        
        // Find all sessions that:
        // 1. Have ended (endTime has passed)
        // 2. Are not completed yet (isCompleted = false)
        // 3. Are not cancelled (isCancelled = false)
        const sessions = await SessionCollection.find({
          isCompleted: { $ne: true },
          isCancelled: { $ne: true },
        });

        for (const session of sessions) {
          // Calculate session end datetime
          const sessionDate = new Date(session.startDate);
          const [endHour, endMinute] = session.endTime.split(':').map(Number);
          
          // Create session end datetime in IST
          const sessionEndDateTime = new Date(sessionDate);
          sessionEndDateTime.setHours(endHour, endMinute, 0, 0);
          
          // For recurring sessions, we need to check if today's occurrence has ended
          let shouldProcess = false;
          
          if (session.frequency === 'OneTime') {
            // For one-time sessions, check if the session end time has passed
            shouldProcess = nowInIST > sessionEndDateTime;
          } else {
            // For recurring sessions, check if today's occurrence has ended
            const todayIST = new Date(nowInIST.getFullYear(), nowInIST.getMonth(), nowInIST.getDate());
            const sessionStartDate = new Date(session.startDate);
            sessionStartDate.setHours(0, 0, 0, 0);
            
            const sessionEndDate = session.endDate 
              ? new Date(session.endDate)
              : null;
            if (sessionEndDate) {
              sessionEndDate.setHours(23, 59, 59, 999);
            }
            
            // Check if today is within the date range
            const isWithinDateRange = todayIST >= sessionStartDate && 
              (!sessionEndDate || todayIST <= sessionEndDate);
            
            if (isWithinDateRange) {
              // For Weekly sessions, also check if today is one of the scheduled days
              if (session.frequency === 'Weekly' && session.weeklyDays && session.weeklyDays.length > 0) {
                const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                const todayDayName = dayNames[nowInIST.getDay()];
                
                if (session.weeklyDays.includes(todayDayName)) {
                  // Today is a scheduled day - check if session end time has passed
                  const todaySessionEnd = new Date(todayIST);
                  todaySessionEnd.setHours(endHour, endMinute, 0, 0);
                  shouldProcess = nowInIST > todaySessionEnd;
                }
              } else if (session.frequency === 'Daily') {
                // For daily sessions, check if today's session end time has passed
                const todaySessionEnd = new Date(todayIST);
                todaySessionEnd.setHours(endHour, endMinute, 0, 0);
                shouldProcess = nowInIST > todaySessionEnd;
              } else if (session.frequency === 'Monthly') {
                // For monthly sessions, check if today's session end time has passed
                // (Simplified: assumes monthly sessions occur on the same day of month)
                const todaySessionEnd = new Date(todayIST);
                todaySessionEnd.setHours(endHour, endMinute, 0, 0);
                shouldProcess = nowInIST > todaySessionEnd;
              }
            }
          }

          if (!shouldProcess) {
            continue; // Session hasn't ended yet, skip
          }

          // Process this session
          let markedAbsentCount = 0;
          
          // Migration: Ensure all assignedUsers have the 'mode' field (for backward compatibility)
          // This fixes validation errors for old sessions created before 'mode' was required
          let needsMigration = false;
          for (let i = 0; i < session.assignedUsers.length; i++) {
            if (!session.assignedUsers[i].mode) {
              // Set default mode based on sessionType
              // For HYBRID sessions, default to PHYSICAL; for others, match sessionType
              if (session.sessionType === 'HYBRID') {
                session.assignedUsers[i].mode = 'PHYSICAL'; // Default for HYBRID
              } else if (session.sessionType === 'REMOTE') {
                session.assignedUsers[i].mode = 'REMOTE';
              } else {
                session.assignedUsers[i].mode = 'PHYSICAL'; // Default for PHYSICAL
              }
              needsMigration = true;
            }
          }
          
          // If we migrated data, save it before processing
          if (needsMigration) {
            await session.save();
            console.log(`[Cron] Migrated session "${session.name}" (${session._id}): Added missing 'mode' fields to assignedUsers`);
          }
          
          // Check each assigned user
          for (let i = 0; i < session.assignedUsers.length; i++) {
            const assignedUser = session.assignedUsers[i];
            
            // Check if user has already been marked (has attendanceStatus)
            if (assignedUser.attendanceStatus) {
              continue; // Already processed
            }
            
            // Check if attendance record exists
            const existingAttendance = await AttendanceCollection.findOne({
              userId: assignedUser.userId,
              sessionId: session._id.toString(),
            });
            
            if (!existingAttendance) {
              // User hasn't scanned - check if they have an approved leave for this date
              const sessionDate = new Date(session.startDate);
              sessionDate.setHours(0, 0, 0, 0);
              
              // Check if user has an approved leave that covers this session date
              const approvedLeave = await LeaveRequestCollection.findOne({
                userId: new mongoose.Types.ObjectId(assignedUser.userId),
                status: 'Approved',
                $or: [
                  // Check if session date is in the dates array (for non-consecutive dates)
                  { dates: { $elemMatch: { $eq: sessionDate } } },
                  // OR check if session date falls within startDate and endDate range
                  {
                    startDate: { $lte: sessionDate },
                    endDate: { $gte: sessionDate },
                  },
                ],
              });
              
              if (approvedLeave) {
                // User is on approved leave - mark as On Leave
                session.assignedUsers[i].attendanceStatus = 'On Leave';
                console.log(`[Cron] User ${assignedUser.userId} marked as On Leave for session ${session._id} (approved leave found)`);
              } else {
                // User hasn't scanned and is not on leave - mark as Absent
                session.assignedUsers[i].attendanceStatus = 'Absent';
                markedAbsentCount++;
                
                // Optionally, create an Attendance record to mark them as absent
                // This helps with reporting and analytics
                try {
                  const absentAttendance = new AttendanceCollection({
                    userId: new mongoose.Types.ObjectId(assignedUser.userId),
                    sessionId: session._id,
                    checkInTime: sessionEndDateTime, // Use session end time as check-in time
                    locationVerified: false,
                    isLate: false,
                    userLocation: {
                      latitude: 0,
                      longitude: 0,
                    },
                    deviceId: 'AUTO_MARKED_ABSENT', // Special device ID to indicate auto-marked
                  });
                  await absentAttendance.save();
                } catch (err) {
                  console.error(`[Cron] Error creating absent attendance record for user ${assignedUser.userId} in session ${session._id}:`, err);
                  // Continue processing even if attendance record creation fails
                }
              }
            } else {
              // User has scanned - mark as Present
              session.assignedUsers[i].attendanceStatus = 'Present';
            }
          }
          
          // Mark session as completed
          session.isCompleted = true;
          await session.save();
          
          totalProcessed++;
          totalMarkedAbsent += markedAbsentCount;
          
          if (markedAbsentCount > 0) {
            console.log(`[Cron] Processed session "${session.name}" (${session._id}): Marked ${markedAbsentCount} users as Absent`);
          }
        }
      } catch (err: any) {
        console.error(`[Cron] Error processing organization ${collectionPrefix}:`, err);
        // Continue with next organization
      }
    }

    if (totalProcessed > 0) {
      console.log(`[Cron] Completed processing: ${totalProcessed} sessions processed, ${totalMarkedAbsent} users marked as Absent`);
    } else {
      console.log('[Cron] No sessions needed processing.');
    }
  } catch (err: any) {
    console.error('[Cron] Error in processEndOfSessionAttendance:', err);
  }
};

/**
 * Start the cron job scheduler
 * Runs every 10 minutes to check for ended sessions
 */
export const startAttendanceScheduler = () => {
  // Run every 10 minutes: '*/10 * * * *'
  // Format: minute hour day month day-of-week
  cron.schedule('*/10 * * * *', () => {
    processEndOfSessionAttendance();
  });
  
  console.log('[Cron] Attendance scheduler started. Will run every 10 minutes.');
  
  // Run once immediately on startup (optional - for testing)
  // Uncomment the line below if you want to process immediately on server start
  // processEndOfSessionAttendance();
};

