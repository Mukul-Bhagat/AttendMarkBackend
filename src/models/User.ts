import { Schema, model, Document, Model, Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

// This is the INTERFACE for a user
export interface IUser extends Document {
  email: string;
  password?: string;
  role: 'SuperAdmin' | 'CompanyAdmin' | 'Manager' | 'SessionAdmin' | 'EndUser' | 'PLATFORM_OWNER';
  profile: {
    firstName: string;
    lastName: string;
    phone?: string;
    bio?: string;
  };
  profilePicture?: string;
  mustResetPassword: boolean;
  registeredDeviceId?: string; // Device ID for device-locking feature
  registeredUserAgent?: string; // Browser/OS signature for device-locking feature
  customLeaveQuota?: {
    pl: number; // Personal Leave
    cl: number; // Casual Leave
    sl: number; // Sick Leave
  } | null; // If null, use Organization Defaults
  resetPasswordToken?: string;
  resetPasswordExpire?: Date;
  lastLogin?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  getResetPasswordToken(): string;
  matchPassword(enteredPassword: string): Promise<boolean>;
}

// This is the User SCHEMA (the structure)
const UserSchema: Schema = new Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
  },
  password: {
    type: String,
    required: true,
    minlength: 6,
    select: false, // Don't return password on queries
  },
  role: {
    type: String,
    enum: ['SuperAdmin', 'CompanyAdmin', 'Manager', 'SessionAdmin', 'EndUser', 'PLATFORM_OWNER'],
    required: true,
  },
  profile: {
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    phone: { type: String },
    bio: { type: String },
  },
  profilePicture: {
    type: String,
  },
  mustResetPassword: {
    type: Boolean,
    default: true,
  },
  registeredDeviceId: {
    type: String,
    select: false, // Don't return by default, only when explicitly requested
  },
  registeredUserAgent: {
    type: String,
    select: false, // Don't return by default, only when explicitly requested
  },
  customLeaveQuota: {
    pl: { type: Number, min: 0 },
    cl: { type: Number, min: 0 },
    sl: { type: Number, min: 0 },
  },
  resetPasswordToken: {
    type: String,
    select: false,
  },
  resetPasswordExpire: {
    type: Date,
    select: false,
  },
  lastLogin: {
    type: Date,
  },
}, { timestamps: true });

// Hash password before saving
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password as string, salt);
  next();
});

// Method to compare passwords
UserSchema.methods.matchPassword = async function (enteredPassword: string): Promise<boolean> {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Method to generate password reset token
UserSchema.methods.getResetPasswordToken = function (): string {
  // Generate token
  const resetToken = crypto.randomBytes(20).toString('hex');

  // Hash token and set to resetPasswordToken field
  this.resetPasswordToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');

  // Set expire (10 minutes)
  this.resetPasswordExpire = new Date(Date.now() + 10 * 60 * 1000);

  return resetToken;
};

// *** THIS IS THE IMPORTANT PART ***
// This is not a model. It is a FACTORY that creates a model
// for a specific organization's collection.
const createUserModel = (collectionName: string): Model<IUser> => {
  return model<IUser>(collectionName, UserSchema, collectionName);
};

export default createUserModel;

