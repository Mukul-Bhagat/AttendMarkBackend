import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { Types } from 'mongoose';
import createLeaveRequestModel from '../models/LeaveRequest';
import createUserModel from '../models/User';
import createOrganizationSettingsModel from '../models/OrganizationSettings';

// Helper function to calculate days between two dates (inclusive)
// Returns the number of days including both start and end dates
const calculateDaysCount = (startDate: Date, endDate: Date): number => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  // Set both dates to midnight for accurate day calculation
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  
  // Calculate difference in milliseconds, convert to days, and add 1 for inclusive count
  const diffTime = end.getTime() - start.getTime();
  const diffDays = diffTime / (1000 * 60 * 60 * 24);
  
  // Add 1 to include both start and end dates (inclusive)
  // Using Math.ceil to ensure we round up for any partial days
  return Math.ceil(diffDays) + 1;
};

// @route   POST /api/leaves
// @desc    Apply for leave
// @access  Private (All authenticated users)
export const applyLeave = async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('Validation errors in applyLeave:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    const { collectionPrefix, id: userId, role } = req.user!;
    
    // STRICT BLOCK: Platform Owner cannot apply for leave for themselves
    if (role === 'PLATFORM_OWNER') {
      return res.status(403).json({ 
        msg: 'Forbidden: Platform Owner cannot apply for leave' 
      });
    }
    
    console.log('Apply Leave Request:', {
      collectionPrefix,
      userId,
      body: req.body,
      hasFile: !!req.file,
      fileInfo: req.file ? { filename: req.file.filename, path: req.file.path } : null,
    });
    
    // Handle FormData - dates might be a string that needs parsing
    let dates = req.body.dates;
    if (typeof dates === 'string') {
      try {
        dates = JSON.parse(dates);
        console.log('Parsed dates from string:', dates);
      } catch (parseErr) {
        console.error('Failed to parse dates string:', dates, parseErr);
        // If parsing fails, treat as empty
        dates = null;
      }
    }
    
    const { leaveType, startDate, endDate, reason, sendTo } = req.body;
    
    // Validate required fields
    if (!leaveType) {
      console.error('Missing leaveType in request');
      return res.status(400).json({ msg: 'Leave type is required' });
    }
    
    if (!reason || !reason.trim()) {
      console.error('Missing or empty reason in request');
      return res.status(400).json({ msg: 'Reason is required' });
    }
    
    // Handle file upload - safe check with comprehensive validation
    let attachmentPath: string | undefined = undefined;
    if (req.file) {
      try {
        // Validate file object has required properties
        if (!req.file.filename) {
          console.error('Uploaded file missing filename property');
          throw new Error('Invalid file upload: missing filename');
        }
        
        // Validate filename is a string and not empty
        if (typeof req.file.filename !== 'string' || req.file.filename.trim() === '') {
          console.error('Invalid filename:', req.file.filename);
          throw new Error('Invalid file upload: empty or invalid filename');
        }
        
        // File path relative to /uploads
        attachmentPath = `/uploads/leaves/${req.file.filename}`;
        console.log('File uploaded successfully:', attachmentPath);
      } catch (fileErr: any) {
        console.error('Error processing uploaded file:', {
          error: fileErr?.message || 'Unknown file error',
          stack: fileErr?.stack,
          file: req.file ? {
            filename: req.file.filename,
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
          } : null,
        });
        // Continue without attachment if file processing fails
        attachmentPath = undefined;
      }
    }

    // Support both new format (dates array) and legacy format (startDate/endDate)
    let parsedDates: Date[] = [];
    let start: Date;
    let end: Date;
    let daysCount: number;

    if (dates && Array.isArray(dates) && dates.length > 0) {
      // NEW FORMAT: Non-consecutive dates array
      try {
        // Parse and normalize all dates
        parsedDates = dates
          .map((dateStr: string) => {
            const date = new Date(dateStr);
            date.setHours(0, 0, 0, 0);
            return date;
          })
          .filter((date: Date) => !isNaN(date.getTime()))
          .sort((a: Date, b: Date) => a.getTime() - b.getTime()); // Sort chronologically

        // Validate we have at least one valid date
        if (parsedDates.length === 0) {
          return res.status(400).json({ msg: 'Invalid dates array. Please provide at least one valid date.' });
        }

        // Derive startDate and endDate from the sorted array
        start = parsedDates[0]; // First date (earliest)
        end = parsedDates[parsedDates.length - 1]; // Last date (latest)
        daysCount = parsedDates.length; // Count of specific days selected
      } catch (parseErr: any) {
        console.error('Date array parsing error:', parseErr);
        return res.status(400).json({ 
          msg: 'Invalid dates array format. Please provide an array of date strings.',
          error: parseErr?.message 
        });
      }
    } else if (startDate && endDate) {
      // LEGACY FORMAT: startDate and endDate (for backward compatibility)
      try {
        start = new Date(startDate);
        end = new Date(endDate);
        
        // Validate the dates are valid
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          console.error('Invalid date format received:', { startDate, endDate });
          return res.status(400).json({ 
            msg: 'Invalid date format. Please use YYYY-MM-DD format.',
            received: { startDate, endDate }
          });
        }

        // Normalize dates to start of day
        start.setHours(0, 0, 0, 0);
        end.setHours(0, 0, 0, 0);

        // Check if start date is before end date
        if (start > end) {
          return res.status(400).json({ msg: 'Start date must be before or equal to end date' });
        }

        // Calculate days count for consecutive dates
        const diffTime = end.getTime() - start.getTime();
        const diffDays = diffTime / (1000 * 60 * 60 * 24);
        daysCount = Math.ceil(diffDays) + 1;

        // Create dates array from range (for backward compatibility)
        parsedDates = [];
        const current = new Date(start);
        while (current <= end) {
          parsedDates.push(new Date(current));
          current.setDate(current.getDate() + 1);
        }
      } catch (parseErr: any) {
        console.error('Date parsing error:', parseErr);
        return res.status(400).json({ 
          msg: 'Invalid date format. Please use YYYY-MM-DD format.',
          error: parseErr?.message 
        });
      }
    } else {
      return res.status(400).json({ 
        msg: 'Either provide a dates array or both startDate and endDate.' 
      });
    }

    // Validate daysCount
    if (daysCount <= 0) {
      return res.status(400).json({ msg: 'Invalid date range. Please provide at least one valid date.' });
    }

    // Get the organization-specific LeaveRequest model
    const LeaveRequestCollection = createLeaveRequestModel(`${collectionPrefix}_leave_requests`);

    // Convert userId to ObjectId
    let userIdObjectId: Types.ObjectId;
    try {
      userIdObjectId = new Types.ObjectId(userId.toString());
    } catch (err: any) {
      console.error('Invalid userId format:', userId);
      return res.status(400).json({ msg: 'Invalid user ID format' });
    }

    // Handle sendTo - convert to array of ObjectIds if provided
    let sendToArray: Types.ObjectId[] = [];
    if (sendTo) {
      try {
        // Handle both array and single value (for backward compatibility)
        const sendToList = Array.isArray(sendTo) ? sendTo : [sendTo];
        sendToArray = sendToList
          .filter((id: any) => id && id.toString().trim() !== '')
          .map((id: any) => {
            try {
              return new Types.ObjectId(id.toString());
            } catch (err) {
              console.warn('Invalid sendTo ID format:', id);
              return null;
            }
          })
          .filter((id: Types.ObjectId | null): id is Types.ObjectId => id !== null);
      } catch (err: any) {
        console.error('Error processing sendTo:', err);
        // Continue without sendTo if parsing fails
        sendToArray = [];
      }
    }

    // CRITICAL: Create EXACTLY ONE LeaveRequest document per application
    // Save dates array, and derive startDate/endDate for sorting/filtering
    const leaveRequestData: any = {
      userId: userIdObjectId,
      leaveType,
      dates: parsedDates, // Array of specific dates (supports non-consecutive)
      startDate: start,   // Derived: min date (for sorting/filtering)
      endDate: end,       // Derived: max date (for sorting/filtering)
      daysCount,          // Count of specific days (parsedDates.length for non-consecutive)
      reason: reason.trim(),
      status: 'Pending',
      organizationPrefix: collectionPrefix,
    };
    
    // Add sendTo array if it has values
    if (sendToArray.length > 0) {
      leaveRequestData.sendTo = sendToArray;
    }
    
    // Only add attachment if it exists and is a valid string
    if (attachmentPath && typeof attachmentPath === 'string' && attachmentPath.trim() !== '') {
      leaveRequestData.attachment = attachmentPath.trim();
    }
    
    // Validate required fields before creating document
    if (!leaveRequestData.userId || !leaveRequestData.leaveType || !leaveRequestData.reason) {
      console.error('Missing required fields in leaveRequestData:', {
        hasUserId: !!leaveRequestData.userId,
        hasLeaveType: !!leaveRequestData.leaveType,
        hasReason: !!leaveRequestData.reason,
      });
      return res.status(400).json({ msg: 'Missing required fields for leave request' });
    }
    
    // Validate dates array
    if (!Array.isArray(parsedDates) || parsedDates.length === 0) {
      console.error('Invalid dates array:', parsedDates);
      return res.status(400).json({ msg: 'Invalid dates array. Please provide at least one valid date.' });
    }
    
    console.log('Creating leave request with data:', {
      userId: leaveRequestData.userId.toString(),
      leaveType: leaveRequestData.leaveType,
      datesCount: parsedDates.length,
      daysCount: leaveRequestData.daysCount,
      hasAttachment: !!leaveRequestData.attachment,
      attachment: attachmentPath || 'none',
      organizationPrefix: leaveRequestData.organizationPrefix,
    });
    
    const leaveRequest = new LeaveRequestCollection(leaveRequestData);

    // Save the single document with comprehensive error handling
    try {
      // Validate the document before saving (Mongoose validation)
      const validationError = leaveRequest.validateSync();
      if (validationError) {
        console.error('Mongoose validation error:', validationError);
        const validationErrors: any = {};
        if (validationError.errors) {
          Object.keys(validationError.errors).forEach((key) => {
            validationErrors[key] = validationError.errors[key].message;
          });
        }
        return res.status(400).json({ 
          msg: 'Validation error', 
          errors: validationErrors,
          details: validationError.message 
        });
      }
      
      await leaveRequest.save();
      console.log('Leave request saved successfully:', leaveRequest._id);
    } catch (saveErr: any) {
      console.error('Error saving leave request:', {
        message: saveErr?.message || 'Unknown save error',
        name: saveErr?.name,
        code: saveErr?.code,
        errors: saveErr?.errors,
        stack: saveErr?.stack,
        leaveRequestData: {
          userId: leaveRequestData.userId?.toString(),
          leaveType: leaveRequestData.leaveType,
          daysCount: leaveRequestData.daysCount,
          hasAttachment: !!leaveRequestData.attachment,
        },
      });
      
      // If save fails and we have a file, we might want to clean it up
      // But for now, just throw the error
      throw saveErr;
    }

    // Manually populate user details for response (can't use Mongoose populate with org-specific collections)
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const user = await UserCollection.findById(userIdObjectId)
      .select('email profile.firstName profile.lastName')
      .lean();

    const leaveRequestObj = leaveRequest.toObject();
    if (user) {
      leaveRequestObj.userId = {
        _id: user._id,
        email: user.email,
        profile: user.profile,
      };
    }

    res.status(201).json({
      msg: 'Leave request submitted successfully',
      leaveRequest: leaveRequestObj,
    });
  } catch (err: any) {
    console.error('Apply Leave Error:', {
      message: err?.message || 'Unknown error',
      stack: err?.stack,
      name: err?.name,
      code: err?.code,
      body: req.body,
      hasFile: !!req.file,
      fileInfo: req.file ? { filename: req.file.filename, path: req.file.path } : null,
      user: req.user ? { id: req.user.id, collectionPrefix: req.user.collectionPrefix } : null,
    });
    
    // If there was a file uploaded but save failed, we might want to clean it up
    // For now, just log it
    
    res.status(500).json({ 
      msg: 'Server error while applying for leave', 
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  }
};

// @route   GET /api/leaves/my-leaves
// @desc    Get leave requests for the logged-in user
// @access  Private (All authenticated users)
export const getMyLeaves = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix, id: userId } = req.user!;

    // Get the organization-specific LeaveRequest model
    const LeaveRequestCollection = createLeaveRequestModel(`${collectionPrefix}_leave_requests`);

    // Convert userId to ObjectId for proper query
    const userIdObjectId = new Types.ObjectId(userId.toString());

    // Find all leave requests for this user, sorted by createdAt (newest first)
    // Mongoose will return empty array if collection doesn't exist
    const leaveRequests = await LeaveRequestCollection.find({ userId: userIdObjectId })
      .sort({ createdAt: -1 })
      .lean();

    // Manually populate userId and approvedBy user data
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    
    // Get current user to fetch custom quota
    const currentUser = await UserCollection.findById(userIdObjectId)
      .select('customLeaveQuota')
      .lean();
    
    // Get organization settings for default quotas
    const OrganizationSettingsCollection = createOrganizationSettingsModel();
    const orgSettings = await OrganizationSettingsCollection.findOne({ organizationPrefix: collectionPrefix }).lean();
    
    // Determine effective quotas (custom or default)
    const effectiveQuota = {
      pl: currentUser?.customLeaveQuota?.pl ?? orgSettings?.yearlyQuotaPL ?? 12,
      cl: currentUser?.customLeaveQuota?.cl ?? orgSettings?.yearlyQuotaCL ?? 12,
      sl: currentUser?.customLeaveQuota?.sl ?? orgSettings?.yearlyQuotaSL ?? 10,
    };
    
    const populatedLeaves = await Promise.all(
      (leaveRequests || []).map(async (leave: any) => {
        // Populate userId (CRITICAL: This fixes PDF showing "N/A" for name/email)
        if (leave.userId) {
          try {
            const user = await UserCollection.findById(leave.userId)
              .select('email profile.firstName profile.lastName')
              .lean();
            if (user) {
              leave.userId = {
                _id: user._id,
                email: user.email,
                profile: user.profile,
              };
            }
          } catch (err) {
            console.error('Error populating userId:', err);
          }
        }

        // Populate approvedBy
        if (leave.approvedBy) {
          try {
            const approver = await UserCollection.findById(leave.approvedBy)
              .select('email profile.firstName profile.lastName')
              .lean();
            if (approver) {
              leave.approvedBy = {
                _id: approver._id,
                email: approver.email,
                profile: approver.profile,
              };
            }
          } catch (err) {
            console.error('Error populating approvedBy:', err);
          }
        }
        return leave;
      })
    );

    // Return leaves with quota information
    res.json({
      leaves: populatedLeaves,
      quota: effectiveQuota,
    });
  } catch (err: any) {
    console.error('Error in getMyLeaves:', {
      message: err?.message || 'Unknown error',
      stack: err?.stack,
      collectionPrefix: req.user?.collectionPrefix,
      userId: req.user?.id,
    });
    res.status(500).json({ 
      msg: 'Server error while fetching leaves', 
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  }
};

// @route   GET /api/leaves/organization
// @desc    Get all leave requests for the organization (for Admins/Staff)
// @access  Private (SuperAdmin, CompanyAdmin, Manager, SessionAdmin)
export const getOrganizationLeaves = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix, role } = req.user!;

    // Only Admins and Staff can view all leaves
    const allowedRoles = ['SuperAdmin', 'CompanyAdmin', 'Manager', 'SessionAdmin'];
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({ msg: 'Not authorized to view organization leaves' });
    }

    // Get query parameters for filtering
    const { status, leaveType, userId } = req.query;
    const { id: currentUserId } = req.user!;
    const currentUserIdObjectId = new Types.ObjectId(currentUserId.toString());

    // Build filter object
    const filter: any = { organizationPrefix: collectionPrefix };
    if (status) {
      filter.status = status;
    }
    if (leaveType) {
      filter.leaveType = leaveType;
    }

    // Handle userId filter
    if (userId) {
      // If userId is explicitly provided in query, use it
      try {
        const requestedUserId = new Types.ObjectId(userId as string);
        
        // CRITICAL FIX: Prevent self-approval - if requesting own pending leaves, return empty
        if (status === 'Pending' && requestedUserId.toString() === currentUserId.toString()) {
          return res.json([]);
        }
        
        filter.userId = requestedUserId;
      } catch (err) {
        return res.status(400).json({ msg: 'Invalid userId format' });
      }
    } else {
      // CRITICAL FIX: When status is Pending (or not specified), exclude current user
      // This prevents admins from seeing and approving their own leave requests
      if (status === 'Pending' || !status) {
        filter.userId = { $ne: currentUserIdObjectId };
      }
    }

    // Get the organization-specific LeaveRequest model
    const LeaveRequestCollection = createLeaveRequestModel(`${collectionPrefix}_leave_requests`);

    // Find all leave requests matching the filter, sorted by createdAt (newest first)
    // Mongoose will return empty array if collection doesn't exist
    const leaveRequests = await LeaveRequestCollection.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    // Manually populate userId and approvedBy user data
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const populatedLeaves = await Promise.all(
      (leaveRequests || []).map(async (leave: any) => {
        // Populate userId
        if (leave.userId) {
          try {
            const user = await UserCollection.findById(leave.userId)
              .select('email profile.firstName profile.lastName')
              .lean();
            if (user) {
              leave.userId = {
                _id: user._id,
                email: user.email,
                profile: user.profile,
              };
            }
          } catch (err) {
            console.error('Error populating userId:', err);
          }
        }

        // Populate approvedBy
        if (leave.approvedBy) {
          try {
            const approver = await UserCollection.findById(leave.approvedBy)
              .select('email profile.firstName profile.lastName')
              .lean();
            if (approver) {
              leave.approvedBy = {
                _id: approver._id,
                email: approver.email,
                profile: approver.profile,
              };
            }
          } catch (err) {
            console.error('Error populating approvedBy:', err);
          }
        }

        return leave;
      })
    );

    res.json(populatedLeaves);
  } catch (err: any) {
    console.error('Error in getOrganizationLeaves:', {
      message: err?.message || 'Unknown error',
      stack: err?.stack,
      collectionPrefix: req.user?.collectionPrefix,
      role: req.user?.role,
    });
    res.status(500).json({ 
      msg: 'Server error while fetching organization leaves', 
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  }
};

// @route   PUT /api/leaves/:id/status
// @desc    Update leave request status (Approve/Reject)
// @access  Private (SuperAdmin, CompanyAdmin, Manager, SessionAdmin)
export const updateLeaveStatus = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { collectionPrefix, id: approverId, role } = req.user!;
    const { id } = req.params;
    const { status, rejectionReason } = req.body;

    // Only Admins and Staff can approve/reject leaves
    const allowedRoles = ['SuperAdmin', 'CompanyAdmin', 'Manager', 'SessionAdmin'];
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({ msg: 'Not authorized to update leave status' });
    }

    // Validate status
    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ msg: 'Status must be either "Approved" or "Rejected"' });
    }

    // If rejected, rejectionReason is required
    if (status === 'Rejected' && !rejectionReason) {
      return res.status(400).json({ msg: 'Rejection reason is required when rejecting a leave request' });
    }

    // Get the organization-specific LeaveRequest model
    const LeaveRequestCollection = createLeaveRequestModel(`${collectionPrefix}_leave_requests`);

    // Find the leave request
    const leaveRequest = await LeaveRequestCollection.findById(id);

    if (!leaveRequest) {
      return res.status(404).json({ msg: 'Leave request not found' });
    }

    // Check if leave request belongs to the same organization
    if (leaveRequest.organizationPrefix !== collectionPrefix) {
      return res.status(403).json({ msg: 'Not authorized to update this leave request' });
    }

    // Check if already processed
    if (leaveRequest.status !== 'Pending') {
      return res.status(400).json({ msg: `Leave request has already been ${leaveRequest.status.toLowerCase()}` });
    }

    // Update leave request status
    leaveRequest.status = status;
    leaveRequest.approvedBy = new Types.ObjectId(approverId);
    if (status === 'Rejected' && rejectionReason) {
      leaveRequest.rejectionReason = rejectionReason;
    }

    await leaveRequest.save();

    // Manually populate user details for response
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const leaveRequestObj = leaveRequest.toObject();

    // Populate userId
    if (leaveRequestObj.userId) {
      try {
        const user = await UserCollection.findById(leaveRequestObj.userId)
          .select('email profile.firstName profile.lastName')
          .lean();
        if (user) {
          leaveRequestObj.userId = {
            _id: user._id,
            email: user.email,
            profile: user.profile,
          };
        }
      } catch (err) {
        console.error('Error populating userId:', err);
      }
    }

    // Populate approvedBy
    if (leaveRequestObj.approvedBy) {
      try {
        const approver = await UserCollection.findById(leaveRequestObj.approvedBy)
          .select('email profile.firstName profile.lastName')
          .lean();
        if (approver) {
          leaveRequestObj.approvedBy = {
            _id: approver._id,
            email: approver.email,
            profile: approver.profile,
          };
        }
      } catch (err) {
        console.error('Error populating approvedBy:', err);
      }
    }

    // TODO: When Approved, deduct from user's quota
    // This would require tracking leavesTaken in the User model
    // For now, we'll just save the leave request
    // Future enhancement: Add leavesTaken tracking to User model

    res.json({
      msg: `Leave request ${status.toLowerCase()} successfully`,
      leaveRequest: leaveRequestObj,
    });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
};

// @route   DELETE /api/leaves/:id
// @desc    Delete a leave request (only if status is Pending)
// @access  Private (User can only delete their own leave requests)
export const deleteLeave = async (req: Request, res: Response) => {
  try {
    const { collectionPrefix, id: userId } = req.user!;
    const { id } = req.params;

    // Get the organization-specific LeaveRequest model
    const LeaveRequestCollection = createLeaveRequestModel(`${collectionPrefix}_leave_requests`);

    // Find the leave request
    const leaveRequest = await LeaveRequestCollection.findById(id);

    if (!leaveRequest) {
      return res.status(404).json({ msg: 'Leave request not found' });
    }

    // Security Check: Ensure the leave request belongs to the current user
    const userIdObjectId = new Types.ObjectId(userId.toString());
    if (leaveRequest.userId.toString() !== userIdObjectId.toString()) {
      return res.status(403).json({ msg: 'Not authorized to delete this leave request' });
    }

    // Status Check: Only allow deletion if status is 'Pending'
    if (leaveRequest.status !== 'Pending') {
      return res.status(400).json({ 
        msg: `Cannot delete ${leaveRequest.status.toLowerCase()} leave request. Only pending requests can be deleted.` 
      });
    }

    // Check if leave request belongs to the same organization
    if (leaveRequest.organizationPrefix !== collectionPrefix) {
      return res.status(403).json({ msg: 'Not authorized to delete this leave request' });
    }

    // Delete the leave request
    await leaveRequest.deleteOne();

    res.json({ msg: 'Leave request deleted successfully' });
  } catch (err: any) {
    console.error('Error in deleteLeave:', {
      message: err?.message || 'Unknown error',
      stack: err?.stack,
      collectionPrefix: req.user?.collectionPrefix,
      userId: req.user?.id,
      leaveId: req.params.id,
    });
    res.status(500).json({ 
      msg: 'Server error while deleting leave request', 
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  }
};

