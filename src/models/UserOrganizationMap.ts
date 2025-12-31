import { Schema, model, Document, Model } from 'mongoose';

// Interface for UserOrganizationMap document
export interface IUserOrganizationMap extends Document {
  email: string;
  organizations: Array<{
    orgName: string;
    prefix: string;
    role: string;
    userId: string; // User ID in the organization-specific collection
  }>;
  createdAt?: Date;
  updatedAt?: Date;
}

// UserOrganizationMap schema - Global collection
const UserOrganizationMapSchema: Schema = new Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    index: true, // Index for fast email lookups
  },
  organizations: [{
    orgName: {
      type: String,
      required: true,
    },
    prefix: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      required: true,
      enum: ['SuperAdmin', 'CompanyAdmin', 'Manager', 'SessionAdmin', 'EndUser', 'PLATFORM_OWNER'],
    },
    userId: {
      type: String,
      required: true,
    },
  }],
}, { timestamps: true });

// Index for faster lookups
UserOrganizationMapSchema.index({ email: 1 });

// Export the model (single global collection)
export default model<IUserOrganizationMap>('UserOrganizationMap', UserOrganizationMapSchema);

