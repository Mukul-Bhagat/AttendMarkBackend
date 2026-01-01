import { Schema, model, Document, Model } from 'mongoose';

// Session interface
export interface ISession extends Document {
  name: string;
  description?: string;
  frequency: 'OneTime' | 'Daily' | 'Weekly' | 'Monthly';
  startDate: Date;
  endDate?: Date;
  startTime: string; // HH:mm format
  endTime: string; // HH:mm format
  locationType: 'Physical' | 'Virtual' | 'Hybrid'; // Legacy field, kept for backward compatibility
  sessionType: 'PHYSICAL' | 'REMOTE' | 'HYBRID'; // New field: Physical, Remote, or Hybrid
  physicalLocation?: string; // Legacy field
  virtualLocation?: string; // URL for virtual meetings
  location?: {
    type: 'LINK' | 'COORDS';
    link?: string; // Google Maps link
    geolocation?: {
      latitude: number;
      longitude: number;
    };
  };
  geolocation?: {
    latitude: number;
    longitude: number;
  }; // Legacy field, kept for backward compatibility
  radius?: number; // Radius in meters for geolocation check (DEPRECATED: Use geofence instead)
  // MapmyIndia geofence polygon (GeoJSON Polygon format)
  geofence?: {
    type: "Polygon";
    coordinates: number[][][]; // [[[lng, lat], [lng, lat], ...]]
  };
  // Location metadata for city/state validation
  city?: string;
  state?: string;
  assignedUsers: Array<{
    userId: string;
    email: string;
    firstName: string;
    lastName: string;
    mode: 'PHYSICAL' | 'REMOTE'; // Specific mode for this user (Physical or Remote)
    isLate?: boolean; // Whether this user marked attendance late
    attendanceStatus?: 'Present' | 'Absent' | 'On Leave'; // Attendance status: Present (scanned), Absent (auto-marked), or On Leave (approved leave)
  }>;
  weeklyDays?: string[]; // For Weekly frequency: ['Monday', 'Tuesday', etc.]
  sessionAdmin?: string; // User ID of the SessionAdmin assigned to this session
  createdBy: string; // User ID who created the session
  organizationPrefix: string; // To identify which organization this belongs to
  classBatchId?: string; // Reference to ClassBatch (optional for backward compatibility)
  isCancelled?: boolean; // Whether the session has been cancelled
  cancellationReason?: string; // Reason for cancellation
  isCompleted?: boolean; // Whether the session has been processed for end-of-session attendance marking
}

// Session schema
const SessionSchema: Schema = new Schema({
  name: {
    type: String,
    required: true,
  },
  description: {
    type: String,
  },
  frequency: {
    type: String,
    enum: ['OneTime', 'Daily', 'Weekly', 'Monthly'],
    required: true,
  },
  startDate: {
    type: Date,
    required: true,
  },
  endDate: {
    type: Date,
  },
  startTime: {
    type: String,
    required: true,
    match: /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, // HH:mm format
  },
  endTime: {
    type: String,
    required: true,
    match: /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, // HH:mm format
  },
  locationType: {
    type: String,
    enum: ['Physical', 'Virtual', 'Hybrid'],
    required: true,
  },
  sessionType: {
    type: String,
    enum: ['PHYSICAL', 'REMOTE', 'HYBRID'],
    required: true,
    default: 'PHYSICAL',
  },
  physicalLocation: {
    type: String,
  },
  virtualLocation: {
    type: String,
  },
  location: {
    type: {
      type: String,
      enum: ['LINK', 'COORDS'],
    },
    link: { type: String },
    geolocation: {
      latitude: { type: Number },
      longitude: { type: Number },
    },
  },
  geolocation: {
    latitude: { type: Number },
    longitude: { type: Number },
  }, // Legacy field, kept for backward compatibility
  radius: {
    type: Number, // Radius in meters (DEPRECATED: Use geofence instead)
    default: 100, // Default 100 meters
  },
  // MapmyIndia geofence polygon (GeoJSON Polygon format)
  geofence: {
    type: {
      type: String,
      enum: ['Polygon'],
      default: 'Polygon',
    },
    coordinates: {
      type: [[[Number]]], // [[[lng, lat], [lng, lat], ...]]
    },
  },
  // Location metadata for city/state validation
  city: {
    type: String,
  },
  state: {
    type: String,
  },
  assignedUsers: [{
    userId: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    firstName: {
      type: String,
      required: true,
    },
    lastName: {
      type: String,
      required: true,
    },
    mode: {
      type: String,
      enum: ['PHYSICAL', 'REMOTE'],
      required: true,
    },
    isLate: {
      type: Boolean,
      default: false,
    },
    attendanceStatus: {
      type: String,
      enum: ['Present', 'Absent', 'On Leave'],
    },
  }],
  weeklyDays: [{
    type: String,
    enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  }],
  sessionAdmin: {
    type: String, // User ID of the SessionAdmin
  },
  createdBy: {
    type: String,
    required: true,
  },
  organizationPrefix: {
    type: String,
    required: true,
  },
  classBatchId: {
    type: String, // Reference to ClassBatch _id (optional for backward compatibility)
    index: true, // Index for fast lookups
  },
  isCancelled: {
    type: Boolean,
    default: false,
  },
  cancellationReason: {
    type: String,
  },
  isCompleted: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true });

// Index for faster lookups by classBatchId
SessionSchema.index({ classBatchId: 1 });

// Factory function to create Session model for a specific organization
const createSessionModel = (collectionName: string): Model<ISession> => {
  return model<ISession>(collectionName, SessionSchema, collectionName);
};

export default createSessionModel;

