import { Schema, model, Document, Model, Types } from 'mongoose';

// LeaveRequest interface
export interface ILeaveRequest extends Document {
  userId: Types.ObjectId;
  leaveType: 'Personal' | 'Casual' | 'Sick' | 'Extra';
  startDate: Date; // Derived: min date from dates array (for sorting/filtering)
  endDate: Date; // Derived: max date from dates array (for sorting/filtering)
  dates: Date[]; // Array of specific dates selected (supports non-consecutive dates)
  daysCount: number;
  reason: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  approvedBy?: Types.ObjectId;
  rejectionReason?: string;
  attachment?: string; // File path/URL for attached document
  sendTo?: Types.ObjectId[]; // Array of user IDs to send the leave request to
  organizationPrefix: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// LeaveRequest schema
const LeaveRequestSchema: Schema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    required: true,
    // Note: No ref - we manually populate user data due to organization-specific collections
  },
  leaveType: {
    type: String,
    enum: ['Personal', 'Casual', 'Sick', 'Extra'],
    required: true,
  },
  startDate: {
    type: Date,
    required: true,
  },
  endDate: {
    type: Date,
    required: true,
  },
  dates: {
    type: [Date],
    required: false, // Optional for backward compatibility
    default: [],
  },
  daysCount: {
    type: Number,
    required: true,
    min: 0.5, // Allow half days
  },
  reason: {
    type: String,
    required: true,
    trim: true,
  },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected'],
    default: 'Pending',
  },
  approvedBy: {
    type: Schema.Types.ObjectId,
    // Note: No ref - we manually populate user data due to organization-specific collections
  },
  rejectionReason: {
    type: String,
    trim: true,
  },
  attachment: {
    type: String, // File path/URL for attached document
    required: false, // Optional field
  },
  sendTo: {
    type: [Schema.Types.ObjectId],
    required: false, // Optional field
    default: [],
    // Note: No ref - we manually populate user data due to organization-specific collections
  },
  organizationPrefix: {
    type: String,
    required: true,
  },
}, { timestamps: true });

// Index for faster lookups
LeaveRequestSchema.index({ userId: 1, organizationPrefix: 1 });
LeaveRequestSchema.index({ organizationPrefix: 1, status: 1 });
LeaveRequestSchema.index({ startDate: 1, endDate: 1 });

// Factory function to create LeaveRequest model for a specific organization
const createLeaveRequestModel = (collectionName: string): Model<ILeaveRequest> => {
  return model<ILeaveRequest>(collectionName, LeaveRequestSchema, collectionName);
};

export default createLeaveRequestModel;

