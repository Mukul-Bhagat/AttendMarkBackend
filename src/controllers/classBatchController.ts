import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import mongoose from 'mongoose';
import createClassBatchModel from '../models/ClassBatch';
import createSessionModel from '../models/Session';

// Helper function to generate sessions based on frequency
const generateSessions = (
  classBatchId: string,
  frequency: 'OneTime' | 'Daily' | 'Weekly' | 'Monthly' | 'Random',
  startDate: Date | undefined,
  endDate: Date | undefined,
  startTime: string,
  endTime: string,
  locationType: string,
  sessionType: string,
  physicalLocation: string | undefined,
  virtualLocation: string | undefined,
  location: any,
  geolocation: any,
  radius: number | undefined,
  assignedUsers: any[],
  weeklyDays: string[] | undefined,
  sessionAdmin: string | undefined,
  createdBy: string,
  organizationPrefix: string,
  defaultTime?: string,
  defaultLocation?: string,
  customDates?: string[] // New parameter for Random frequency
) => {
  const sessions: any[] = [];
  const finalStartTime = startTime || defaultTime || '09:00';
  const finalEndTime = endTime || '17:00';

  // Handle Random/Custom Dates frequency
  if (frequency === 'Random' && customDates && customDates.length > 0) {
    // Create one session for each custom date
    for (const dateStr of customDates) {
      const sessionDate = new Date(dateStr);
      sessions.push({
        name: `Session - ${sessionDate.toLocaleDateString()}`,
        frequency: 'Random',
        startDate: sessionDate,
        startTime: finalStartTime,
        endTime: finalEndTime,
        locationType: locationType || 'Physical',
        sessionType: sessionType || 'PHYSICAL',
        physicalLocation: physicalLocation || defaultLocation,
        virtualLocation,
        location,
        geolocation,
        radius,
        assignedUsers,
        sessionAdmin,
        createdBy,
        organizationPrefix,
        classBatchId,
      });
    }
    return sessions;
  }

  if (frequency === 'OneTime' && startDate) {
    // Create a single session
    sessions.push({
      name: `Session - ${startDate.toLocaleDateString()}`,
      frequency: 'OneTime',
      startDate,
      startTime: finalStartTime,
      endTime: finalEndTime,
      locationType: locationType || 'Physical',
      sessionType: sessionType || 'PHYSICAL',
      physicalLocation: physicalLocation || defaultLocation,
      virtualLocation,
      location,
      geolocation,
      radius,
      assignedUsers,
      sessionAdmin,
      createdBy,
      organizationPrefix,
      classBatchId,
    });
  } else if (frequency === 'Daily' && startDate && endDate) {
    // Create daily sessions from startDate to endDate
    const currentDate = new Date(startDate);
    const finalEndDate = new Date(endDate);
    
    while (currentDate <= finalEndDate) {
      sessions.push({
        name: `Session - ${currentDate.toLocaleDateString()}`,
        frequency: 'Daily',
        startDate: new Date(currentDate),
        startTime: finalStartTime,
        endTime: finalEndTime,
        locationType: locationType || 'Physical',
        sessionType: sessionType || 'PHYSICAL',
        physicalLocation: physicalLocation || defaultLocation,
        virtualLocation,
        location,
        geolocation,
        radius,
        assignedUsers,
        sessionAdmin,
        createdBy,
        organizationPrefix,
        classBatchId,
      });
      currentDate.setDate(currentDate.getDate() + 1);
    }
  } else if (frequency === 'Weekly' && startDate && endDate && weeklyDays && weeklyDays.length > 0) {
    // Create weekly sessions based on selected days
    const currentDate = new Date(startDate);
    const finalEndDate = new Date(endDate);
    const dayMap: { [key: string]: number } = {
      'Sunday': 0,
      'Monday': 1,
      'Tuesday': 2,
      'Wednesday': 3,
      'Thursday': 4,
      'Friday': 5,
      'Saturday': 6,
    };
    const selectedDays = weeklyDays.map(day => dayMap[day]);

    while (currentDate <= finalEndDate) {
      const dayOfWeek = currentDate.getDay();
      if (selectedDays.includes(dayOfWeek)) {
        sessions.push({
          name: `Session - ${currentDate.toLocaleDateString()}`,
          frequency: 'Weekly',
          startDate: new Date(currentDate),
          startTime: finalStartTime,
          endTime: finalEndTime,
          locationType: locationType || 'Physical',
          sessionType: sessionType || 'PHYSICAL',
          physicalLocation: physicalLocation || defaultLocation,
          virtualLocation,
          location,
          geolocation,
          radius,
          assignedUsers,
          weeklyDays,
          sessionAdmin,
          createdBy,
          organizationPrefix,
          classBatchId,
        });
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }
  } else if (frequency === 'Monthly' && startDate && endDate) {
    // Create monthly sessions (first occurrence of each month)
    const currentDate = new Date(startDate);
    const finalEndDate = new Date(endDate);
    
    while (currentDate <= finalEndDate) {
      sessions.push({
        name: `Session - ${currentDate.toLocaleDateString()}`,
        frequency: 'Monthly',
        startDate: new Date(currentDate),
        startTime: finalStartTime,
        endTime: finalEndTime,
        locationType: locationType || 'Physical',
        sessionType: sessionType || 'PHYSICAL',
        physicalLocation: physicalLocation || defaultLocation,
        virtualLocation,
        location,
        geolocation,
        radius,
        assignedUsers,
        sessionAdmin,
        createdBy,
        organizationPrefix,
        classBatchId,
      });
      // Move to next month
      currentDate.setMonth(currentDate.getMonth() + 1);
    }
  }

  return sessions;
};

// @route   POST /api/classes
// @desc    Create a new ClassBatch (and optionally generate sessions)
// @access  Private
export const createClassBatch = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { collectionPrefix, id: userId, role: userRole } = req.user!;
  const {
    name,
    description,
    defaultTime,
    defaultLocation,
    // Session generation options
    generateSessions: shouldGenerateSessions,
    frequency,
    startDate,
    endDate,
    startTime,
    endTime,
    locationType,
    sessionType,
    physicalLocation,
    virtualLocation,
    location,
    geolocation,
    radius,
    assignedUsers,
    weeklyDays,
    sessionAdmin,
    customDates, // New field for Random frequency
  } = req.body;

  try {
    // 1. Get the organization-specific ClassBatch model
    const ClassBatchCollection = createClassBatchModel(`${collectionPrefix}_classbatches`);

    // 2. Create the ClassBatch
    const classBatch = new ClassBatchCollection({
      name,
      description,
      defaultTime,
      defaultLocation,
      createdBy: userId,
      organizationPrefix: collectionPrefix,
    });

    await classBatch.save();

    // 3. If generateSessions is true, create sessions
    let createdSessions: any[] = [];
    if (shouldGenerateSessions && frequency) {
      // Validate required fields for session generation
      if (frequency === 'Random') {
        // For Random frequency, customDates is required instead of startDate
        if (!customDates || !Array.isArray(customDates) || customDates.length === 0) {
          return res.status(400).json({ 
            msg: 'At least one custom date is required for Random frequency sessions.' 
          });
        }
      } else if (!startDate) {
        return res.status(400).json({ 
          msg: 'Start date is required when generating sessions.' 
        });
      }

      // Validate location requirements based on sessionType
      const finalSessionType = sessionType || 'PHYSICAL';
      if (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') {
        if (!location) {
          return res.status(400).json({ 
            msg: 'Location is required for Physical or Hybrid sessions.' 
          });
        }
        
        if (location.type === 'LINK') {
          if (!location.link || !location.link.trim()) {
            return res.status(400).json({ 
              msg: 'Location Link is required.' 
            });
          }
        } else if (location.type === 'COORDS') {
          if (!location.geolocation || !location.geolocation.latitude || !location.geolocation.longitude) {
            return res.status(400).json({ 
              msg: 'Latitude and Longitude are required.' 
            });
          }
        } else {
          return res.status(400).json({ 
            msg: 'Location type must be either LINK or COORDS.' 
          });
        }
      }

      // Determine sessionAdmin
      let assignedSessionAdmin: string | undefined;
      if (userRole === 'SessionAdmin') {
        assignedSessionAdmin = userId;
      } else if (userRole === 'SuperAdmin' && sessionAdmin) {
        assignedSessionAdmin = sessionAdmin;
      }

      // Generate sessions
      const sessionData = generateSessions(
        classBatch._id.toString(),
        frequency,
        startDate ? new Date(startDate) : undefined,
        endDate ? new Date(endDate) : undefined,
        startTime || defaultTime || '09:00',
        endTime || '17:00',
        locationType || 'Physical',
        finalSessionType,
        physicalLocation || defaultLocation,
        virtualLocation,
        location,
        geolocation,
        radius,
        assignedUsers || [],
        weeklyDays,
        assignedSessionAdmin,
        userId,
        collectionPrefix,
        defaultTime,
        defaultLocation,
        customDates // Pass customDates for Random frequency
      );

      // Save all generated sessions
      if (sessionData.length > 0) {
        const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);
        const sessionDocs = sessionData.map(s => new SessionCollection(s));
        createdSessions = await Promise.all(sessionDocs.map(s => s.save()));
      }
    }

    res.status(201).json({
      msg: 'ClassBatch created successfully',
      classBatch,
      sessionsCreated: createdSessions.length,
      sessions: createdSessions,
    });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   GET /api/classes
// @desc    Get all ClassBatches for the user's organization
// @access  Private
export const getClassBatches = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix, id: userId, role: userRole } = req.user!;
    
    // Debug logging
    console.log('[DEBUG] Fetching classes for user:', userId, 'Role:', userRole, 'Collection:', collectionPrefix);

    // Get the organization-specific models
    const ClassBatchCollection = createClassBatchModel(`${collectionPrefix}_classbatches`);
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);

    let classBatches;

    // If user is an Admin (SuperAdmin, CompanyAdmin, Manager, SessionAdmin), return all classes
    if (userRole !== 'EndUser') {
      console.log('[DEBUG] User is Admin - returning all classes');
      classBatches = await ClassBatchCollection.find()
        .sort({ createdAt: -1 })
        .lean();
    } else {
      // For End Users: Return only classes where they are assigned to at least one session
      console.log('[DEBUG] User is EndUser - filtering by assigned sessions');
      console.log('[DEBUG] userId type:', typeof userId, 'value:', userId);
      
      // assignedUsers.userId is stored as String in the Session model
      // Ensure userId is a string for comparison
      const userIdString = String(userId);
      
      // First, find all sessions where the user is in assignedUsers
      // MongoDB query: find sessions where assignedUsers array contains an object with userId matching
      const userSessions = await SessionCollection.find({
        'assignedUsers.userId': userIdString,
      }).select('classBatchId').lean();

      console.log('[DEBUG] Found', userSessions.length, 'sessions assigned to user');
      if (userSessions.length > 0) {
        console.log('[DEBUG] Sample session classBatchId:', userSessions[0].classBatchId, 'type:', typeof userSessions[0].classBatchId);
      }

      // Extract unique classBatchIds
      // classBatchId is stored as String in Session model, but ClassBatch._id is ObjectId
      const classBatchIds = [...new Set(
        userSessions
          .map(s => s.classBatchId)
          .filter((id): id is string => id !== null && id !== undefined && id !== '')
          .map(id => String(id)) // Ensure it's a string
      )];

      console.log('[DEBUG] Unique classBatchIds found:', classBatchIds.length, classBatchIds);

      // If no sessions found or no classBatchIds, return empty array (status 200)
      if (classBatchIds.length === 0) {
        console.log('[DEBUG] No classBatchIds found - returning empty array');
        return res.json([]);
      }

      // Find classes that match these IDs
      // ClassBatch._id is ObjectId, so we need to convert string IDs to ObjectId
      const objectIds = classBatchIds
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));

      if (objectIds.length === 0) {
        console.log('[DEBUG] No valid ObjectIds after conversion - returning empty array');
        return res.json([]);
      }

      console.log('[DEBUG] Querying classes with ObjectIds:', objectIds);
      classBatches = await ClassBatchCollection.find({
        _id: { $in: objectIds },
      })
        .sort({ createdAt: -1 })
        .lean();
      
      console.log('[DEBUG] Found', classBatches?.length || 0, 'classes for EndUser');
    }

    // For each class, fetch the first session and calculate latestSessionDate
    const classesWithSessions = await Promise.all(
      (classBatches || []).map(async (classBatch: any) => {
        try {
          const classBatchIdStr = classBatch._id.toString();
          
          // Find the first session for this class (sorted by startDate) - for display purposes
          const firstSession = await SessionCollection.findOne({ classBatchId: classBatchIdStr })
            .sort({ startDate: 1 })
            .select('startDate endDate startTime endTime locationType physicalLocation virtualLocation location frequency _id')
            .lean();
          
          if (firstSession) {
            // Attach first session details to the class object
            classBatch.firstSession = {
              _id: firstSession._id,
              startDate: firstSession.startDate,
              endDate: firstSession.endDate,
              startTime: firstSession.startTime,
              endTime: firstSession.endTime,
              locationType: firstSession.locationType,
              physicalLocation: firstSession.physicalLocation,
              virtualLocation: firstSession.virtualLocation,
              location: firstSession.location,
              frequency: firstSession.frequency,
            };
          }

          // Calculate latestSessionDate: Find the MAX endDate among all sessions
          // For sessions without endDate, calculate endDate from startDate + endTime
          const allSessions = await SessionCollection.find({ 
            classBatchId: classBatchIdStr,
            isCancelled: { $ne: true } // Exclude cancelled sessions
          })
            .select('startDate endDate endTime')
            .lean();

          let latestSessionDate: Date | null = null;

          if (allSessions.length > 0) {
            // For each session, calculate the actual end datetime
            const sessionEndDates = allSessions.map(session => {
              let endDateTime: Date;
              
              if (session.endDate) {
                // If session has endDate, use it
                endDateTime = new Date(session.endDate);
              } else {
                // If no endDate, use startDate
                endDateTime = new Date(session.startDate);
              }

              // Add endTime to the date
              if (session.endTime) {
                const [hours, minutes] = session.endTime.split(':').map(Number);
                endDateTime.setHours(hours, minutes, 59, 999);
              } else {
                endDateTime.setHours(23, 59, 59, 999);
              }

              return endDateTime;
            });

            // Find the maximum (latest) end date
            latestSessionDate = new Date(Math.max(...sessionEndDates.map(d => d.getTime())));
          } else {
            // Fallback: If no sessions exist, use class createdAt or defaultTime
            latestSessionDate = classBatch.createdAt ? new Date(classBatch.createdAt) : new Date();
          }

          // Attach latestSessionDate to the class object
          classBatch.latestSessionDate = latestSessionDate ? latestSessionDate.toISOString() : null;
        } catch (err) {
          console.error(`[ERROR] Error processing sessions for class ${classBatch._id}:`, err);
          // Fallback: Use createdAt if error occurs
          classBatch.latestSessionDate = classBatch.createdAt ? new Date(classBatch.createdAt).toISOString() : new Date().toISOString();
        }
        return classBatch;
      })
    );

    res.json(classesWithSessions || []);
  } catch (err: any) {
    console.error('[ERROR] Error in getClassBatches:', err.message);
    console.error('[ERROR] Stack:', err.stack);
    console.error('[ERROR] User:', req.user?.id, 'Role:', req.user?.role);
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
};

// @route   GET /api/classes/:id
// @desc    Get a single ClassBatch by its ID
// @access  Private
export const getClassBatchById = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix } = req.user!;
    const { id } = req.params;

    // Get the organization-specific ClassBatch model
    const ClassBatchCollection = createClassBatchModel(`${collectionPrefix}_classbatches`);

    // Find the class batch by ID
    const classBatch = await ClassBatchCollection.findById(id).lean();

    if (!classBatch) {
      return res.status(404).json({ msg: 'ClassBatch not found' });
    }

    res.json(classBatch);
  } catch (err: any) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'ClassBatch not found' });
    }
    res.status(500).send('Server error');
  }
};

// @route   GET /api/classes/:id/sessions
// @desc    Get all sessions belonging to a specific ClassBatch
// @access  Private
export const getSessionsByClassBatch = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix, id: userId, role: userRole } = req.user!;
    const { id } = req.params;

    // Get the organization-specific models
    const ClassBatchCollection = createClassBatchModel(`${collectionPrefix}_classbatches`);
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);

    // Verify the ClassBatch exists
    const classBatch = await ClassBatchCollection.findById(id);
    if (!classBatch) {
      return res.status(404).json({ msg: 'ClassBatch not found' });
    }

    // Build query - filter by classBatchId
    const query: any = { classBatchId: id };

    // SECURITY FIX: For EndUsers, only show sessions they are assigned to
    if (userRole === 'EndUser') {
      // assignedUsers.userId is stored as String in the Session model
      query['assignedUsers.userId'] = String(userId);
    }

    // Find sessions with the appropriate query, sorted by startDate
    const sessions = await SessionCollection.find(query)
      .sort({ startDate: 1 })
      .lean();

    // Populate classBatchId for each session (even though we already have the classBatch)
    // This ensures consistency with the getSessions endpoint
    const sessionsWithClass = sessions.map((session: any) => {
      if (session.classBatchId && classBatch) {
        // Replace classBatchId string with populated object
        session.classBatchId = {
          _id: classBatch._id.toString(),
          name: classBatch.name,
          description: classBatch.description,
        };
      }
      return session;
    });

    res.json({
      classBatch,
      sessions: sessionsWithClass,
      count: sessionsWithClass.length, // Count now reflects filtered list
    });
  } catch (err: any) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'ClassBatch not found' });
    }
    res.status(500).send('Server error');
  }
};

// @route   PUT /api/classes/:id
// @desc    Update a ClassBatch (and optionally bulk update all linked sessions)
// @access  Private
export const updateClassBatch = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { collectionPrefix, id: userId, role: userRole } = req.user!;
  const { id } = req.params;
  const {
    name,
    description,
    defaultTime,
    defaultLocation,
    // Session update fields
    updateSessions,
    frequency,
    startDate,
    endDate,
    startTime,
    endTime,
    locationType,
    sessionType,
    virtualLocation,
    location,
    geolocation,
    radius,
    assignedUsers,
    weeklyDays,
    sessionAdmin,
    customDates, // New field for Random frequency
  } = req.body;

  try {
    // Get the organization-specific models
    const ClassBatchCollection = createClassBatchModel(`${collectionPrefix}_classbatches`);
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);

    // Find the class batch
    const classBatch = await ClassBatchCollection.findById(id);
    if (!classBatch) {
      return res.status(404).json({ msg: 'ClassBatch not found' });
    }

    // Update ClassBatch fields
    if (name) classBatch.name = name;
    if (description !== undefined) classBatch.description = description;
    if (defaultTime !== undefined) classBatch.defaultTime = defaultTime;
    if (defaultLocation !== undefined) classBatch.defaultLocation = defaultLocation;

    await classBatch.save();

    // If updateSessions is true, bulk update all linked sessions
    let updatedSessionsCount = 0;
    let regeneratedSessionsCount = 0;
    if (updateSessions === true) {
      console.log(`[DEBUG] Updating sessions for Class ID: ${id}`);
      console.log(`[DEBUG] Request body updateSessions:`, updateSessions);
      console.log(`[DEBUG] Session update fields received:`, {
        frequency,
        startDate,
        endDate,
        startTime,
        endTime,
        sessionType,
        locationType,
        location,
        virtualLocation,
        assignedUsers: assignedUsers ? `${assignedUsers.length} users` : 'none',
        weeklyDays,
      });

      // Find all sessions linked to this class
      const existingSessions = await SessionCollection.find({ classBatchId: id }).sort({ startDate: 1 });
      console.log(`[DEBUG] Found ${existingSessions.length} existing sessions`);

      if (existingSessions.length === 0) {
        console.log(`[DEBUG] No sessions found for class ${id}, skipping session updates`);
      } else {
        // Get the first session to compare schedule
        const firstSession = existingSessions[0];
        const existingFrequency = firstSession.frequency;
        const existingStartDate = firstSession.startDate ? new Date(firstSession.startDate).toISOString().split('T')[0] : null;
        const existingEndDate = firstSession.endDate ? new Date(firstSession.endDate).toISOString().split('T')[0] : null;
        const existingWeeklyDays = firstSession.weeklyDays || [];

        // Normalize weeklyDays arrays for comparison
        const normalizeWeeklyDays = (days: string[]) => [...days].sort().join(',');
        const existingWeeklyDaysStr = normalizeWeeklyDays(existingWeeklyDays);
        const newWeeklyDaysStr = weeklyDays ? normalizeWeeklyDays(weeklyDays) : '';

        // Detect if schedule changed
        const scheduleChanged = 
          (frequency && frequency !== existingFrequency) ||
          (startDate && startDate !== existingStartDate) ||
          (endDate !== undefined && endDate !== existingEndDate) ||
          (weeklyDays && newWeeklyDaysStr !== existingWeeklyDaysStr) ||
          (frequency === 'Random' && customDates && customDates.length > 0); // Always regenerate for Random with customDates

        console.log(`[DEBUG] Schedule comparison:`, {
          existingFrequency,
          newFrequency: frequency,
          existingStartDate,
          newStartDate: startDate,
          existingEndDate,
          newEndDate: endDate,
          existingWeeklyDays: existingWeeklyDaysStr,
          newWeeklyDays: newWeeklyDaysStr,
          scheduleChanged,
        });

        if (scheduleChanged && frequency && (startDate || (frequency === 'Random' && customDates))) {
          console.log(`[DEBUG] Schedule changed - Regenerating sessions`);
          
          // Validate location if updating to PHYSICAL or HYBRID
          const finalSessionType = sessionType || (firstSession.sessionType || 'PHYSICAL');
          if (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') {
            if (!location) {
              return res.status(400).json({ 
                msg: 'Location is required for Physical or Hybrid sessions.' 
              });
            }
            
            if (location.type === 'LINK') {
              if (!location.link || !location.link.trim()) {
                return res.status(400).json({ 
                  msg: 'Location Link is required.' 
                });
              }
            } else if (location.type === 'COORDS') {
              if (!location.geolocation || !location.geolocation.latitude || !location.geolocation.longitude) {
                return res.status(400).json({ 
                  msg: 'Latitude and Longitude are required.' 
                });
              }
            }
          }

          // Determine sessionAdmin
          let assignedSessionAdmin: string | undefined;
          if (userRole === 'SessionAdmin') {
            assignedSessionAdmin = userId;
          } else if (userRole === 'SuperAdmin' && sessionAdmin) {
            assignedSessionAdmin = sessionAdmin;
          }

          // Get today's date (start of day)
          const today = new Date();
          today.setHours(0, 0, 0, 0);

          // For Random frequency, delete ALL sessions and regenerate from customDates
          // For other frequencies, preserve past sessions
          let pastSessions: any[] = [];
          if (frequency === 'Random') {
            // Delete ALL sessions for Random frequency since we're replacing with custom dates
            const deleteResult = await SessionCollection.deleteMany({
              classBatchId: id,
            });
            console.log(`[DEBUG] Random frequency - Deleted ${deleteResult.deletedCount} existing sessions`);
          } else {
            // Preserve past sessions - find sessions that have already ended
            pastSessions = existingSessions.filter(session => {
              const sessionEndDate = session.endDate 
                ? new Date(session.endDate)
                : new Date(session.startDate);
              sessionEndDate.setHours(23, 59, 59, 999);
              return sessionEndDate < today;
            });

            console.log(`[DEBUG] Preserving ${pastSessions.length} past sessions`);

            // Delete future sessions (startDate >= today)
            const deleteResult = await SessionCollection.deleteMany({
              classBatchId: id,
              startDate: { $gte: today },
            });
            console.log(`[DEBUG] Deleted ${deleteResult.deletedCount} future sessions`);
          }

          // Calculate regeneration start date: max(newStartDate, today)
          const newStartDateObj = new Date(startDate);
          newStartDateObj.setHours(0, 0, 0, 0);
          const regenerationStartDate = newStartDateObj >= today ? newStartDateObj : today;
          
          // Calculate regeneration end date
          const regenerationEndDate = endDate ? new Date(endDate) : undefined;
          if (regenerationEndDate) {
            regenerationEndDate.setHours(23, 59, 59, 999);
          }

          console.log(`[DEBUG] Regenerating sessions from ${regenerationStartDate.toISOString()} to ${regenerationEndDate ? regenerationEndDate.toISOString() : 'no end date'}`);

          // Generate new sessions
          const sessionData = generateSessions(
            id,
            frequency,
            frequency === 'Random' ? undefined : regenerationStartDate,
            frequency === 'Random' ? undefined : regenerationEndDate,
            startTime || classBatch.defaultTime || '09:00',
            endTime || '17:00',
            locationType || firstSession.locationType || 'Physical',
            finalSessionType,
            location?.type === 'LINK' ? (location?.link || classBatch.defaultLocation) : undefined,
            virtualLocation,
            location,
            geolocation,
            radius,
            assignedUsers || [],
            weeklyDays,
            assignedSessionAdmin,
            userId,
            collectionPrefix,
            classBatch.defaultTime,
            classBatch.defaultLocation,
            customDates // Pass customDates for Random frequency
          );

          // Save all generated sessions
          if (sessionData.length > 0) {
            const sessionDocs = sessionData.map(s => new SessionCollection(s));
            const newSessions = await Promise.all(sessionDocs.map(s => s.save()));
            regeneratedSessionsCount = newSessions.length;
            console.log(`[DEBUG] Regenerated ${regeneratedSessionsCount} new sessions`);
          }

          // Also update metadata (time, location, mode, users) for past sessions if provided
          if (pastSessions.length > 0 && (startTime || endTime || sessionType || location || assignedUsers)) {
            const updateFields: any = {};
            const unsetFields: any = {};

            if (startTime !== undefined && startTime !== null && startTime !== '') {
              updateFields.startTime = startTime;
            }
            if (endTime !== undefined && endTime !== null && endTime !== '') {
              updateFields.endTime = endTime;
            }
            if (sessionType !== undefined && sessionType !== null) {
              updateFields.sessionType = sessionType;
              updateFields.locationType = locationType || (sessionType === 'PHYSICAL' ? 'Physical' : sessionType === 'REMOTE' ? 'Virtual' : 'Hybrid');
            }
            if (virtualLocation !== undefined) {
              if (finalSessionType === 'REMOTE' || finalSessionType === 'HYBRID') {
                updateFields.virtualLocation = virtualLocation || undefined;
              } else {
                unsetFields.virtualLocation = '';
              }
            }
            if (location !== undefined) {
              if (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') {
                updateFields.location = location;
              } else {
                unsetFields.location = '';
              }
            }
            if (geolocation !== undefined) {
              if (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') {
                updateFields.geolocation = geolocation;
              } else {
                unsetFields.geolocation = '';
              }
            }
            if (radius !== undefined) {
              if (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') {
                updateFields.radius = radius;
              } else {
                unsetFields.radius = '';
              }
            }
            if (assignedUsers !== undefined) {
              updateFields.assignedUsers = assignedUsers;
            }
            if (assignedSessionAdmin !== undefined) {
              updateFields.sessionAdmin = assignedSessionAdmin;
            }

            if (Object.keys(updateFields).length > 0 || Object.keys(unsetFields).length > 0) {
              const updateQuery: any = {};
              if (Object.keys(updateFields).length > 0) {
                updateQuery.$set = updateFields;
              }
              if (Object.keys(unsetFields).length > 0) {
                updateQuery.$unset = unsetFields;
              }

              const pastUpdateResult = await SessionCollection.updateMany(
                {
                  classBatchId: id,
                  startDate: { $lt: today },
                },
                updateQuery
              );
              console.log(`[DEBUG] Updated ${pastUpdateResult.modifiedCount} past sessions with new metadata`);
              updatedSessionsCount = pastUpdateResult.modifiedCount;
            }
          }
        } else {
          // Schedule didn't change - use existing updateMany logic
          console.log(`[DEBUG] Schedule did not change - Updating metadata only`);
          
          // Validate location if updating to PHYSICAL or HYBRID
          const finalSessionType = sessionType || (existingSessions[0]?.sessionType || 'PHYSICAL');
          if (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') {
            if (!location) {
              return res.status(400).json({ 
                msg: 'Location is required for Physical or Hybrid sessions.' 
              });
            }
            
            if (location.type === 'LINK') {
              if (!location.link || !location.link.trim()) {
                return res.status(400).json({ 
                  msg: 'Location Link is required.' 
                });
              }
            } else if (location.type === 'COORDS') {
              if (!location.geolocation || !location.geolocation.latitude || !location.geolocation.longitude) {
                return res.status(400).json({ 
                  msg: 'Latitude and Longitude are required.' 
                });
              }
            }
          }

          // Determine sessionAdmin
          let assignedSessionAdmin: string | undefined;
          if (userRole === 'SessionAdmin') {
            assignedSessionAdmin = userId;
          } else if (userRole === 'SuperAdmin' && sessionAdmin) {
            assignedSessionAdmin = sessionAdmin;
          }

          // Bulk update all sessions (Smart Update - preserve dates, update other fields)
          const updateFields: any = {};
          
          // Always update time fields if provided
          if (startTime !== undefined && startTime !== null && startTime !== '') {
            updateFields.startTime = startTime;
          }
          if (endTime !== undefined && endTime !== null && endTime !== '') {
            updateFields.endTime = endTime;
          }
          
          // Always update session type if provided
          if (sessionType !== undefined && sessionType !== null) {
            updateFields.sessionType = sessionType;
            updateFields.locationType = locationType || (sessionType === 'PHYSICAL' ? 'Physical' : sessionType === 'REMOTE' ? 'Virtual' : 'Hybrid');
          }
          
          // Handle virtual location
          if (virtualLocation !== undefined) {
            if (finalSessionType === 'REMOTE' || finalSessionType === 'HYBRID') {
              updateFields.virtualLocation = virtualLocation || undefined;
            } else {
              updateFields.virtualLocation = undefined; // Clear for PHYSICAL
            }
          }
          
          // Separate $set and $unset operations
          const unsetFields: any = {};
          
          // Handle location - always include it so we can clear it for REMOTE
          if (location !== undefined) {
            if (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') {
              updateFields.location = location;
            } else {
              // Clear location for REMOTE sessions
              unsetFields.location = '';
            }
          }
          
          // Handle geolocation (legacy)
          if (geolocation !== undefined) {
            if (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') {
              updateFields.geolocation = geolocation;
            } else {
              // Clear geolocation for REMOTE sessions
              unsetFields.geolocation = '';
            }
          }
          
          // Handle radius
          if (radius !== undefined) {
            if (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') {
              updateFields.radius = radius;
            } else {
              // Clear radius for REMOTE sessions
              unsetFields.radius = '';
            }
          }
          
          // Always update assigned users if provided
          if (assignedUsers !== undefined) {
            updateFields.assignedUsers = assignedUsers;
          }
          
          // Handle weekly days
          if (weeklyDays !== undefined) {
            if (frequency === 'Weekly') {
              updateFields.weeklyDays = weeklyDays;
            } else {
              // Clear weeklyDays for non-weekly frequencies
              unsetFields.weeklyDays = '';
            }
          }
          
          // Handle session admin
          if (assignedSessionAdmin !== undefined) {
            updateFields.sessionAdmin = assignedSessionAdmin;
          }
          
          // Handle frequency
          if (frequency !== undefined && frequency !== null) {
            updateFields.frequency = frequency;
          }

          console.log(`[DEBUG] Update fields to apply (set):`, updateFields);
          console.log(`[DEBUG] Unset fields:`, unsetFields);
          console.log(`[DEBUG] Number of fields to update:`, Object.keys(updateFields).length);

          // Update all sessions
          if (Object.keys(updateFields).length > 0 || Object.keys(unsetFields).length > 0) {
            // Build the update object with $set and $unset
            const updateQuery: any = {};
            
            if (Object.keys(updateFields).length > 0) {
              updateQuery.$set = updateFields;
            }
            if (Object.keys(unsetFields).length > 0) {
              updateQuery.$unset = unsetFields;
            }
            
            console.log(`[DEBUG] Update query:`, JSON.stringify(updateQuery, null, 2));
            
            const result = await SessionCollection.updateMany(
              { classBatchId: id },
              updateQuery
            );
            updatedSessionsCount = result.modifiedCount;
            console.log(`[DEBUG] Updated ${updatedSessionsCount} sessions (matched: ${result.matchedCount})`);
          } else {
            console.log(`[DEBUG] No update fields to apply, skipping updateMany`);
          }
        }
      }
    } else {
      console.log(`[DEBUG] updateSessions is not true (value: ${updateSessions}), skipping session updates`);
    }

    res.json({
      msg: 'ClassBatch updated successfully',
      classBatch,
      sessionsUpdated: updatedSessionsCount,
      sessionsRegenerated: regeneratedSessionsCount,
    });
  } catch (err: any) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'ClassBatch not found' });
    }
    res.status(500).send('Server error');
  }
};

// @route   DELETE /api/classes/:id
// @desc    Delete a ClassBatch (and optionally its sessions)
// @access  Private
export const deleteClassBatch = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix } = req.user!;
    const { id } = req.params;
    const { deleteSessions } = req.query; // Optional query param

    // Get the organization-specific models
    const ClassBatchCollection = createClassBatchModel(`${collectionPrefix}_classbatches`);
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);

    // Find the class batch
    const classBatch = await ClassBatchCollection.findById(id);
    if (!classBatch) {
      return res.status(404).json({ msg: 'ClassBatch not found' });
    }

    // Check if there are sessions linked to this class batch
    const sessionCount = await SessionCollection.countDocuments({ classBatchId: id });

    // If deleteSessions is true, delete all linked sessions
    if (deleteSessions === 'true' && sessionCount > 0) {
      await SessionCollection.deleteMany({ classBatchId: id });
    } else if (sessionCount > 0) {
      // If sessions exist and deleteSessions is not true, prevent deletion
      return res.status(400).json({ 
        msg: `Cannot delete ClassBatch. It has ${sessionCount} associated session(s). Set deleteSessions=true to delete them as well.` 
      });
    }

    // Delete the class batch
    await ClassBatchCollection.findByIdAndDelete(id);

    res.json({
      msg: 'ClassBatch deleted successfully',
      sessionsDeleted: deleteSessions === 'true' ? sessionCount : 0,
    });
  } catch (err: any) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'ClassBatch not found' });
    }
    res.status(500).send('Server error');
  }
};

