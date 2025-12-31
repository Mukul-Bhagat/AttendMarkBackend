import { Schema, model, Document } from 'mongoose';

// This is the MASTER list of all organizations.
export interface IOrganization extends Document {
  name: string;
  collectionPrefix: string; // e.g., "org_acme"
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt?: Date;
  updatedAt?: Date;
}

const OrganizationSchema: Schema = new Schema({
  name: {
    type: String,
    required: true,
    unique: true,
  },
  // This prefix is the key to our "one table" model
  collectionPrefix: {
    type: String,
    required: true,
    unique: true,
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'SUSPENDED'],
    default: 'ACTIVE',
    required: true,
  },
}, { timestamps: true });

export default model<IOrganization>('Organization', OrganizationSchema);

