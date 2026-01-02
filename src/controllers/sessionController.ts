import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import createSessionModel from '../models/Session';
import createClassBatchModel from '../models/ClassBatch';
import { logAction } from '../utils/auditLogger';
import Organization from '../models/Organization';
import { extractCoordinatesFromGoogleMapsLink } from '../utils/mapsParser';

// @route   POST /api/sessions
// @desc    Create a new session
export const createSession = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { collectionPrefix, id: userId, role: userRole } = req.user!;
  const {
    name,
    description,
    frequency,
    startDate,
    endDate,
    startTime,
    endTime,
    locationType,
    sessionType, // New field: PHYSICAL, REMOTE, or HYBRID
    physicalLocation,
    virtualLocation,
    location, // New location object with type field
    geolocation, // Legacy field
    radius,
    assignedUsers,
    weeklyDays,
    sessionAdmin, // Optional: ID of SessionAdmin to assign (only SuperAdmin can set this)
    classBatchId, // Optional: Reference to ClassBatch
  } = req.body;

  try {
    // 1. Get the organization-specific Session model
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);

    // 2. Validate location requirements based on sessionType
    const finalSessionType = sessionType || 'PHYSICAL'; // Default to PHYSICAL if not provided
    
    if (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') {
      // For PHYSICAL or HYBRID sessions, location is required
      if (!location) {
        return res.status(400).json({ 
          msg: 'Location is required for Physical or Hybrid sessions.' 
        });
      }
      
      // SECURITY: PHYSICAL sessions MUST have coordinates for distance validation
      // LINK-only sessions cannot verify location - REJECT
      let hasCoordinates = false;
      
      // Check if coordinates are provided in location.geolocation
      if (location.geolocation && 
          typeof location.geolocation.latitude === 'number' && 
          typeof location.geolocation.longitude === 'number' &&
          !isNaN(location.geolocation.latitude) &&
          !isNaN(location.geolocation.longitude)) {
        hasCoordinates = true;
      }
      
      // Check legacy geolocation field
      if (!hasCoordinates && geolocation && 
          typeof geolocation.latitude === 'number' && 
          typeof geolocation.longitude === 'number' &&
          !isNaN(geolocation.latitude) &&
          !isNaN(geolocation.longitude)) {
        hasCoordinates = true;
      }
      
      // BLOCK session creation if PHYSICAL and coordinates are missing
      if (!hasCoordinates) {
        return res.status(400).json({ 
          msg: 'Location coordinates (latitude and longitude) are required for Physical sessions. Please provide coordinates or use the map picker to select a location.',
          reason: 'MISSING_COORDINATES'
        });
      }
      
      // Validate location structure and extract coordinates if needed
      if (location.type === 'LINK') {
        if (!location.link || !location.link.trim()) {
          return res.status(400).json({ 
            msg: 'Location Link is required.' 
          });
        }
        
        // AUTO-EXTRACT coordinates from Google Maps link if not provided
        let extractedCoords: { latitude: number; longitude: number } | null = null;
        if (!location.geolocation || !location.geolocation.latitude || !location.geolocation.longitude) {
          extractedCoords = extractCoordinatesFromGoogleMapsLink(location.link.trim());
          
          if (!extractedCoords) {
            return res.status(400).json({ 
              msg: 'Could not extract coordinates from the Google Maps link. Please ensure the link contains coordinates (e.g., https://maps.google.com/?q=lat,lng) or provide coordinates manually.',
              reason: 'MISSING_COORDINATES'
            });
          }
          
          // Auto-populate coordinates from extracted values
          location.geolocation = {
            latitude: extractedCoords.latitude,
            longitude: extractedCoords.longitude,
          };
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
    // For REMOTE sessions, location is optional (ignored)

    // 3. Determine sessionAdmin
    // If creator is SessionAdmin, auto-assign them
    // If SuperAdmin provided a sessionAdmin ID, use that
    let assignedSessionAdmin: string | undefined;
    if (userRole === 'SessionAdmin') {
      assignedSessionAdmin = userId; // Auto-assign the creator
    } else if (userRole === 'SuperAdmin' && sessionAdmin) {
      assignedSessionAdmin = sessionAdmin; // SuperAdmin can assign any SessionAdmin
    }

    // 4. Create the session
    const session = new SessionCollection({
      name,
      description,
      frequency,
      startDate,
      endDate: endDate || undefined,
      startTime,
      endTime,
      locationType: locationType || (finalSessionType === 'PHYSICAL' ? 'Physical' : finalSessionType === 'REMOTE' ? 'Virtual' : 'Hybrid'), // Map sessionType to locationType for backward compatibility
      sessionType: finalSessionType,
      physicalLocation: finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID' ? physicalLocation : undefined,
      virtualLocation: finalSessionType === 'REMOTE' || finalSessionType === 'HYBRID' ? virtualLocation : undefined,
      location: (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') && location ? location : undefined,
      geolocation: (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') && geolocation ? geolocation : undefined, // Legacy support
      radius: (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') && radius ? radius : undefined,
      assignedUsers: assignedUsers || [],
      weeklyDays: frequency === 'Weekly' ? weeklyDays : undefined,
      sessionAdmin: assignedSessionAdmin,
      createdBy: userId,
      organizationPrefix: collectionPrefix,
      classBatchId: classBatchId || undefined,
    });

    await session.save();

    res.status(201).json({
      msg: 'Session created successfully',
      session,
    });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   GET /api/sessions
// @desc    Get all sessions for the user's organization (filtered for EndUsers)
// @access  Private
export const getSessions = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix, role, id: userId } = req.user!;
    const isEndUser = role === 'EndUser';

    // Get the organization-specific models
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);
    const ClassBatchCollection = createClassBatchModel(`${collectionPrefix}_classbatches`);

    // Build query based on user role
    let query: any = {};
    
    if (isEndUser) {
      // EndUsers only see sessions they are assigned to
      query['assignedUsers.userId'] = userId.toString();
    }
    // Admins/Managers see all sessions (no filter)

    // Find sessions, sorted by creation date (newest first)
    const sessions = await SessionCollection.find(query)
      .sort({ createdAt: -1 })
      .lean();

    // Populate classBatchId for each session
    const sessionsWithClass = await Promise.all(
      sessions.map(async (session: any) => {
        if (session.classBatchId) {
          try {
            const classBatch = await ClassBatchCollection.findById(session.classBatchId)
              .select('name description')
              .lean();
            
            if (classBatch) {
              // Replace classBatchId string with populated object
              session.classBatchId = {
                _id: classBatch._id.toString(),
                name: classBatch.name,
                description: classBatch.description,
              };
            }
          } catch (err) {
            console.error(`Error populating classBatchId for session ${session._id}:`, err);
            // Keep classBatchId as string if population fails
          }
        }
        return session;
      })
    );

    res.json(sessionsWithClass);
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   GET /api/sessions/:id
// @desc    Get a single session by its ID
// @access  Private
export const getSessionById = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix } = req.user!;
    const { id } = req.params;

    // Get the organization-specific Session model
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);

    // Find the session by ID
    const session = await SessionCollection.findById(id).lean();

    if (!session) {
      return res.status(404).json({ msg: 'Session not found' });
    }

    res.json(session);
  } catch (err: any) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Session not found' });
    }
    res.status(500).send('Server error');
  }
};

// @route   PUT /api/sessions/:id
// @desc    Update a session (only SuperAdmin or assigned SessionAdmin can update)
// @access  Private
export const updateSession = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { collectionPrefix, id: userId, role: userRole } = req.user!;
  const { id } = req.params;
  const {
    name,
    description,
    frequency,
    startDate,
    endDate,
    startTime,
    endTime,
    locationType,
    sessionType, // New field: PHYSICAL, REMOTE, or HYBRID
    physicalLocation,
    virtualLocation,
    location, // New location object with type field
    assignedUsers,
    weeklyDays,
    geolocation, // Legacy field
    radius,
    sessionAdmin, // Optional: Only SuperAdmin can change this
    classBatchId, // Optional: Reference to ClassBatch
    isCancelled, // Optional: Cancel/uncancel session
    cancellationReason, // Optional: Reason for cancellation
  } = req.body;

  try {
    // 1. Get the organization-specific Session model
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);

    // 2. Find the session
    const session = await SessionCollection.findById(id);
    if (!session) {
      return res.status(404).json({ msg: 'Session not found' });
    }

    // 3. Security check: Only SuperAdmin or assigned SessionAdmin can update
    if (userRole !== 'SuperAdmin' && session.sessionAdmin?.toString() !== userId) {
      return res.status(403).json({ msg: 'Not authorized to edit this session' });
    }

    // 4. Only SuperAdmin can change the sessionAdmin assignment
    let updatedSessionAdmin = session.sessionAdmin;
    if (userRole === 'SuperAdmin' && sessionAdmin !== undefined) {
      updatedSessionAdmin = sessionAdmin || undefined;
    }

    // 5. Validate location requirements based on sessionType (if updating)
    const finalSessionType = sessionType || session.sessionType;
    if (sessionType && (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID')) {
      // For PHYSICAL or HYBRID sessions, location is required
      if (location) {
        // SECURITY: PHYSICAL sessions MUST have coordinates for distance validation
        // LINK-only sessions cannot verify location - REJECT
        let hasCoordinates = false;
        
        // Check if coordinates are provided in location.geolocation
        if (location.geolocation && 
            typeof location.geolocation.latitude === 'number' && 
            typeof location.geolocation.longitude === 'number' &&
            !isNaN(location.geolocation.latitude) &&
            !isNaN(location.geolocation.longitude)) {
          hasCoordinates = true;
        }
        
        // Check legacy geolocation field
        if (!hasCoordinates && geolocation && 
            typeof geolocation.latitude === 'number' && 
            typeof geolocation.longitude === 'number' &&
            !isNaN(geolocation.latitude) &&
            !isNaN(geolocation.longitude)) {
          hasCoordinates = true;
        }
        
        // BLOCK session update if PHYSICAL and coordinates are missing
        if (!hasCoordinates) {
          return res.status(400).json({ 
            msg: 'Location coordinates (latitude and longitude) are required for Physical sessions. Please provide coordinates or use the map picker to select a location.',
            reason: 'MISSING_COORDINATES'
          });
        }
        
        if (location.type === 'LINK') {
          if (!location.link || !location.link.trim()) {
            return res.status(400).json({ 
              msg: 'Location Link is required.' 
            });
          }
          
          // AUTO-EXTRACT coordinates from Google Maps link if not provided
          let extractedCoords: { latitude: number; longitude: number } | null = null;
          if (!location.geolocation || !location.geolocation.latitude || !location.geolocation.longitude) {
            extractedCoords = extractCoordinatesFromGoogleMapsLink(location.link.trim());
            
            if (!extractedCoords) {
              return res.status(400).json({ 
                msg: 'Could not extract coordinates from the Google Maps link. Please ensure the link contains coordinates (e.g., https://maps.google.com/?q=lat,lng) or provide coordinates manually.',
                reason: 'MISSING_COORDINATES'
              });
            }
            
            // Auto-populate coordinates from extracted values
            location.geolocation = {
              latitude: extractedCoords.latitude,
              longitude: extractedCoords.longitude,
            };
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
      } else if (!session.location) {
        // If updating to PHYSICAL/HYBRID and no location provided, and session doesn't have location
        return res.status(400).json({ 
          msg: 'Location is required for Physical or Hybrid sessions.' 
        });
      }
    }

    // 6. Update the session
    if (name) session.name = name;
    if (description !== undefined) session.description = description;
    if (frequency) session.frequency = frequency;
    if (startDate) session.startDate = startDate;
    if (endDate !== undefined) session.endDate = endDate || undefined;
    if (startTime) session.startTime = startTime;
    if (endTime) session.endTime = endTime;
    if (locationType) session.locationType = locationType;
    if (sessionType) session.sessionType = sessionType;
    if (physicalLocation !== undefined) {
      session.physicalLocation = (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') ? physicalLocation : undefined;
    }
    if (virtualLocation !== undefined) {
      session.virtualLocation = (finalSessionType === 'REMOTE' || finalSessionType === 'HYBRID') ? virtualLocation : undefined;
    }
    if (assignedUsers !== undefined) session.assignedUsers = assignedUsers;
    if (weeklyDays !== undefined) {
      session.weeklyDays = frequency === 'Weekly' ? weeklyDays : undefined;
    }
    if (location !== undefined) {
      // Only set location for PHYSICAL or HYBRID sessions
      if (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') {
        session.location = location;
      } else {
        session.location = undefined;
      }
    }
    if (geolocation !== undefined) {
      // Legacy support: Only set geolocation for PHYSICAL or HYBRID sessions
      if (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') {
        session.geolocation = geolocation;
      } else {
        session.geolocation = undefined;
      }
    }
    if (radius !== undefined) {
      // Only set radius for PHYSICAL or HYBRID sessions
      if (finalSessionType === 'PHYSICAL' || finalSessionType === 'HYBRID') {
        session.radius = radius;
      } else {
        session.radius = undefined;
      }
    }
    session.sessionAdmin = updatedSessionAdmin;
    if (classBatchId !== undefined) session.classBatchId = classBatchId || undefined;
    
    // Handle cancellation
    if (isCancelled !== undefined) {
      const wasCancelled = session.isCancelled;
      session.isCancelled = isCancelled;
      if (isCancelled) {
        session.cancellationReason = cancellationReason || undefined;
      } else {
        // If uncancelling, clear the reason
        session.cancellationReason = undefined;
      }

      // Log cancellation to audit log
      if (isCancelled && !wasCancelled) {
        // Get organization details for audit log
        const org = await Organization.findOne({ collectionPrefix });
        let className = 'Unknown Class';
        
        // Try to get class name if classBatchId exists
        if (session.classBatchId) {
          try {
            const ClassBatchCollection = createClassBatchModel(`${collectionPrefix}_classbatches`);
            const classBatch = await ClassBatchCollection.findById(session.classBatchId).select('name').lean();
            if (classBatch) {
              className = classBatch.name;
            }
          } catch (err) {
            console.error('Error fetching class name for audit log:', err);
          }
        }

        const sessionDate = session.startDate ? new Date(session.startDate).toLocaleDateString() : 'Unknown Date';
        await logAction(
          'CANCEL_SESSION',
          {
            id: userId,
            email: req.user!.email,
            role: userRole,
            collectionPrefix,
          },
          session._id,
          {
            message: `Session for ${className} on ${sessionDate} was cancelled.`,
            sessionName: session.name,
            className,
            sessionDate,
            cancellationReason: cancellationReason || 'No reason provided',
          },
          org?._id,
          org?.name
        );
      }
    } else if (cancellationReason !== undefined && session.isCancelled) {
      // Allow updating cancellation reason if session is already cancelled
      session.cancellationReason = cancellationReason;
    }

    await session.save();

    res.json({
      msg: 'Session updated successfully',
      session,
    });
  } catch (err: any) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Session not found' });
    }
    res.status(500).send('Server error');
  }
};

// @route   DELETE /api/sessions/:id
// @desc    Delete a session (only SuperAdmin or assigned SessionAdmin can delete)
// @access  Private
export const deleteSession = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix, id: userId, role: userRole } = req.user!;
    const { id } = req.params;

    // Get the organization-specific Session model
    const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);

    // Find the session
    const session = await SessionCollection.findById(id);
    if (!session) {
      return res.status(404).json({ msg: 'Session not found' });
    }

    // Security check: Only SuperAdmin or assigned SessionAdmin can delete
    if (userRole !== 'SuperAdmin' && session.sessionAdmin?.toString() !== userId) {
      return res.status(403).json({ msg: 'Not authorized to delete this session' });
    }

    // Delete the session
    await SessionCollection.findByIdAndDelete(id);

    res.json({
      msg: 'Session deleted successfully',
    });
  } catch (err: any) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Session not found' });
    }
    res.status(500).send('Server error');
  }
};

