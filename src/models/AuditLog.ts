import { Schema, model, Document, Model, Types } from 'mongoose';

// Interface for AuditLog document
export interface IAuditLog extends Document {
  organizationPrefix: string;
  organizationId?: Types.ObjectId; // Reference to Organization
  organizationName?: string; // Snapshot of organization name at time of event
  action: string; // e.g., "FORCE_ATTENDANCE_CORRECTION", "DEVICE_RESET", "CREATE_USER", etc.
  performedBy: {
    userId: string;
    email: string;
    role: string;
  };
  targetUser?: {
    userId: string;
    email: string;
  };
  details: {
    [key: string]: any; // Flexible details object
  };
  createdAt?: Date;
  updatedAt?: Date;
}

// AuditLog schema - Global collection (not organization-specific)
const AuditLogSchema: Schema = new Schema({
  organizationPrefix: {
    type: String,
    required: true,
    index: true,
  },
  organizationId: {
    type: Schema.Types.ObjectId,
    ref: 'Organization',
    index: true,
  },
  organizationName: {
    type: String,
    index: true,
  },
  action: {
    type: String,
    required: true,
    enum: [
      'FORCE_ATTENDANCE_CORRECTION',
      'DEVICE_RESET',
      'UPDATE_ORGANIZATION_STATUS',
      'CANCEL_SESSION',
      'CREATE_USER',
      'DELETE_USER',
      'CREATE_STAFF',
      'BULK_IMPORT_STAFF',
      'DELETE_STAFF',
      'OTHER',
    ],
  },
  performedBy: {
    userId: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      required: true,
    },
  },
  targetUser: {
    userId: {
      type: String,
    },
    email: {
      type: String,
    },
  },
  details: {
    type: Schema.Types.Mixed,
    default: {},
  },
}, { timestamps: true });

// Index for faster lookups
AuditLogSchema.index({ organizationPrefix: 1, createdAt: -1 });
AuditLogSchema.index({ organizationId: 1, createdAt: -1 });
AuditLogSchema.index({ 'performedBy.userId': 1 });
AuditLogSchema.index({ 'targetUser.userId': 1 });

// Export the model (global collection)
export default model<IAuditLog>('AuditLog', AuditLogSchema);

