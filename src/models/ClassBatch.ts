import { Schema, model, Document, Model } from 'mongoose';

// ClassBatch interface (Parent container for Sessions)
export interface IClassBatch extends Document {
  name: string;
  description?: string;
  createdBy: string; // User ID who created the class
  defaultTime?: string; // Optional: Default time for sessions (HH:mm format)
  defaultLocation?: string; // Optional: Default location for sessions
  organizationPrefix: string; // To identify which organization this belongs to
}

// ClassBatch schema
const ClassBatchSchema: Schema = new Schema({
  name: {
    type: String,
    required: true,
  },
  description: {
    type: String,
  },
  createdBy: {
    type: String,
    required: true,
  },
  defaultTime: {
    type: String,
    match: /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, // HH:mm format
  },
  defaultLocation: {
    type: String,
  },
  organizationPrefix: {
    type: String,
    required: true,
  },
}, { timestamps: true });

// Index for faster lookups
ClassBatchSchema.index({ organizationPrefix: 1, createdAt: -1 });
ClassBatchSchema.index({ createdBy: 1 });

// Factory function to create ClassBatch model for a specific organization
const createClassBatchModel = (collectionName: string): Model<IClassBatch> => {
  return model<IClassBatch>(collectionName, ClassBatchSchema, collectionName);
};

export default createClassBatchModel;

