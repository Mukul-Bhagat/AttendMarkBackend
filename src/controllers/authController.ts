import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import Organization from '../models/Organization';
import createUserModel, { IUser } from '../models/User'; // Import the factory and interface
import UserOrganizationMap from '../models/UserOrganizationMap';
import { sendEmail } from '../utils/email';

// Utility to create a safe collection name
const createCollectionPrefix = (name: string): string => {
  return "org_" + name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50);
};

// @route   GET /api/auth/organizations
// @desc    Get list of all organizations for dropdown
// @access  Public
export const getOrganizations = async (_req: Request, res: Response) => {
  try {
    // Query all organizations, sorted alphabetically by name
    const organizations = await Organization.find({})
      .select('name collectionPrefix')
      .sort({ name: 1 });

    // Return lightweight array with name and prefix
    const orgList = organizations.map((org) => ({
      name: org.name,
      prefix: org.collectionPrefix,
    }));

    res.json(orgList);
  } catch (err: any) {
    console.error('Error fetching organizations:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
};

// @route   POST /api/auth/register-super-admin
export const registerSuperAdmin = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { organizationName, firstName, lastName, email, password, phone } = req.body;

  try {
    // 1. Check if organization already exists in the MASTER list
    let org = await Organization.findOne({ name: organizationName });
    if (org) {
      return res.status(400).json({ msg: 'An organization with this name already exists' });
    }

    // 2. Create the unique collection prefix
    const collectionPrefix = createCollectionPrefix(organizationName);
    
    // 3. Save the new organization to the MASTER list
    org = new Organization({
      name: organizationName,
      collectionPrefix: collectionPrefix,
    });
    await org.save();

    // 4. *** THIS IS THE MAGIC ***
    // Create a new User Model pointing to the new, unique collection
    const UserCollection = createUserModel(`${collectionPrefix}_users`);

    // 5. Check if the email is already in use *in that specific collection*
    // (This check is fast because the collection is brand new)
    let user = await UserCollection.findOne({ email });
    if (user) {
      // This should never happen on a new org, but it's good practice
      return res.status(400).json({ msg: 'This email is already in use' });
    }

    // 6. Create the new SuperAdmin user in their OWN collection
    user = new UserCollection({
      email,
      password,
      role: 'SuperAdmin',
      profile: {
        firstName,
        lastName,
        phone,
      },
    });

    await user.save();

    // 7. Add user to UserOrganizationMap
    await UserOrganizationMap.findOneAndUpdate(
      { email: email.toLowerCase() },
      {
        $push: {
          organizations: {
            orgName: organizationName,
            prefix: collectionPrefix,
            role: 'SuperAdmin',
            userId: user._id.toString(),
          },
        },
      },
      { upsert: true, new: true }
    );

    res.status(201).json({
      msg: `Organization '${organizationName}' and Super Admin created.`,
      collectionPrefix: collectionPrefix,
    });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   POST /api/auth/login
// @desc    Login user - finds organizations by email, verifies password, returns org list
export const login = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, password } = req.body;

  // Ensure organizationName is not required (ignore if present)
  if (req.body.organizationName) {
    // Silently ignore organizationName if provided (for backward compatibility)
    delete req.body.organizationName;
  }

  try {
    console.log('[LOGIN] Attempting login for:', email.toLowerCase());
    
    // 1. Check if user is Platform Owner (stored in special collection)
    const PLATFORM_OWNERS_COLLECTION = 'platform_owners_users';
    const PlatformOwnerCollection = createUserModel(PLATFORM_OWNERS_COLLECTION);
    
    let platformOwner: IUser | null = null;
    try {
      console.log('[LOGIN] Querying Platform Owner collection...');
      platformOwner = await PlatformOwnerCollection.findOne({ email: email.toLowerCase() }).select('+password');
      console.log('[LOGIN] Platform Owner query result:', platformOwner ? 'Found' : 'Not found');
    } catch (dbError: any) {
      console.error('[LOGIN] Error querying Platform Owner collection:', dbError);
      // Continue to regular user flow if Platform Owner query fails
    }
    
    if (platformOwner && platformOwner.role === 'PLATFORM_OWNER') {
      console.log('[LOGIN] Platform Owner detected, verifying password...');
      // Verify password
      if (!platformOwner.password) {
        console.error('Platform Owner found but password field is missing');
        return res.status(500).json({ msg: 'Account configuration error' });
      }
      
      let isMatch = false;
      try {
        isMatch = await platformOwner.matchPassword(password);
      } catch (pwdError: any) {
        console.error('Password verification error:', pwdError);
        return res.status(500).json({ msg: 'Error verifying password' });
      }
      
      if (!isMatch) {
        return res.status(401).json({ msg: 'Invalid credentials' });
      }

      // Platform Owner: Get all organizations for selection
      console.log('[LOGIN] Fetching all organizations...');
      const allOrganizations = await Organization.find({}).sort({ name: 1 });
      console.log('[LOGIN] Found organizations:', allOrganizations.length);
      
      // TypeScript knows platformOwner is not null here due to the if check above
      const platformOwnerId = platformOwner._id.toString();
      const orgDetails = allOrganizations.map((org) => ({
        orgName: org.name,
        prefix: org.collectionPrefix,
        role: 'PLATFORM_OWNER',
        userId: platformOwnerId,
        organizationName: org.name,
      }));

      // Generate temporary token for organization selection
      const tempPayload = {
        email: email.toLowerCase(),
        verified: true,
        isPlatformOwner: true,
      };

      if (!process.env.JWT_SECRET) {
        console.error('[LOGIN] JWT_SECRET is not defined in environment variables');
        return res.status(500).json({ msg: 'Server configuration error' });
      }

      console.log('[LOGIN] Generating JWT token...');
      try {
        jwt.sign(
          tempPayload,
          process.env.JWT_SECRET,
          { expiresIn: '5m' },
          (err, tempToken) => {
            if (err) {
              console.error('JWT signing error:', err);
              return res.status(500).json({ msg: 'Failed to generate token' });
            }
            if (!tempToken) {
              return res.status(500).json({ msg: 'Failed to generate token' });
            }
            res.json({
              tempToken,
              organizations: orgDetails,
            });
          }
        );
      } catch (jwtError: any) {
        console.error('JWT signing exception:', jwtError);
        return res.status(500).json({ msg: 'Failed to generate token' });
      }
      return;
    }

    // 2. Regular user flow: Look up email in UserOrganizationMap
    const userMap = await UserOrganizationMap.findOne({ email: email.toLowerCase() });
    
    // CRITICAL: Check if userMap exists and has organizations
    if (!userMap) {
      return res.status(401).json({ 
        msg: 'User not found. Please run the migration script to populate user data.',
        requiresMigration: true 
      });
    }

    if (!userMap.organizations || userMap.organizations.length === 0) {
      return res.status(401).json({ 
        msg: 'User has no associated organizations. Please contact your administrator.',
        requiresMigration: true 
      });
    }

    // 3. Get the first organization to verify password
    const firstOrg = userMap.organizations[0];
    if (!firstOrg || !firstOrg.prefix || !firstOrg.userId) {
      return res.status(401).json({ 
        msg: 'Invalid user organization data. Please run the migration script.',
        requiresMigration: true 
      });
    }

    const UserCollection = createUserModel(`${firstOrg.prefix}_users`);

    // 4. Find the user by userId - MUST select password since it's select: false by default
    const user = await UserCollection.findById(firstOrg.userId).select('+password');
    if (!user) {
      return res.status(401).json({ msg: 'Invalid credentials' });
    }

    // 5. Verify password against the first organization's user account
    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ msg: 'Invalid credentials' });
    }

    // 6. Get organization details for all organizations (filter out suspended ones for regular users)
    const orgDetails = await Promise.all(
      userMap.organizations.map(async (orgEntry) => {
        const org = await Organization.findOne({ collectionPrefix: orgEntry.prefix });
        // Filter out suspended organizations (they won't be able to select them)
        if (!org || org.status === 'SUSPENDED') {
          return null; // Will be filtered out
        }
        return {
          orgName: orgEntry.orgName,
          prefix: orgEntry.prefix,
          role: orgEntry.role,
          userId: orgEntry.userId,
          organizationName: org.name,
        };
      })
    );
    
    // Filter out null entries (suspended organizations)
    const activeOrgDetails = orgDetails.filter((org) => org !== null) as Array<{
      orgName: string;
      prefix: string;
      role: string;
      userId: string;
      organizationName: string;
    }>;
    
    // If no active organizations, return error
    if (activeOrgDetails.length === 0) {
      return res.status(403).json({ 
        msg: 'All your organizations are suspended. Contact support.',
      });
    }

    // 7. Generate temporary token (short-lived, 5 minutes) for organization selection
    const tempPayload = {
      email: email.toLowerCase(),
      verified: true,
    };

    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET is not defined in environment variables');
      return res.status(500).json({ msg: 'Server configuration error' });
    }

    jwt.sign(
      tempPayload,
      process.env.JWT_SECRET,
      { expiresIn: '5m' }, // Short-lived token for security
      (err, tempToken) => {
        if (err) {
          console.error('JWT signing error (regular user):', err);
          return res.status(500).json({ msg: 'Failed to generate token' });
        }
        if (!tempToken) {
          return res.status(500).json({ msg: 'Failed to generate token' });
        }
        res.json({
          tempToken, // Temporary token for organization selection
          organizations: activeOrgDetails, // List of active organizations user belongs to
        });
      }
    );
  } catch (err: any) {
    console.error('Login error:', err.message);
    console.error('Stack:', err.stack);
    console.error('Error details:', {
      email: email,
      errorType: err.constructor.name,
      errorCode: err.code,
    });
    res.status(500).json({ 
      msg: 'Server error during login',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
      details: process.env.NODE_ENV === 'development' ? {
        type: err.constructor.name,
        code: err.code,
      } : undefined
    });
  }
};

// @route   POST /api/auth/select-organization
// @desc    Complete login by selecting an organization - requires tempToken and prefix
export const selectOrganization = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { tempToken, prefix } = req.body;

  try {
    // 1. Verify temporary token
    let decoded: any;
    try {
      decoded = jwt.verify(tempToken, process.env.JWT_SECRET as string) as any;
    } catch (err) {
      return res.status(401).json({ msg: 'Invalid or expired token. Please log in again.' });
    }

    if (!decoded.email || !decoded.verified) {
      return res.status(401).json({ msg: 'Invalid token' });
    }

    // 2. Check if this is a Platform Owner login
    if (decoded.isPlatformOwner) {
      // Platform Owner: Allow access to any organization
      const PLATFORM_OWNERS_COLLECTION = 'platform_owners_users';
      const PlatformOwnerCollection = createUserModel(PLATFORM_OWNERS_COLLECTION);
      const platformOwner = await PlatformOwnerCollection.findOne({ email: decoded.email.toLowerCase() });
      
      if (!platformOwner) {
        return res.status(401).json({ msg: 'Platform Owner not found' });
      }

      // Verify organization exists
      const org = await Organization.findOne({ collectionPrefix: prefix });
      if (!org) {
        return res.status(404).json({ msg: 'Organization not found' });
      }
      
      // Platform Owner can access suspended organizations (to unsuspend them)
      // No status check needed for Platform Owner

      // Generate final JWT token with organization context for Platform Owner
      const payload = {
        user: {
          id: platformOwner._id.toString(),
          email: platformOwner.email,
          role: 'PLATFORM_OWNER',
          collectionPrefix: prefix,
          organizationName: org.name,
        },
      };

      jwt.sign(
        payload,
        process.env.JWT_SECRET as string,
        { expiresIn: '7d' },
        (err, token) => {
          if (err) throw err;
          res.json({
            token,
            user: {
              id: platformOwner._id,
              email: platformOwner.email,
              role: platformOwner.role,
              profile: platformOwner.profile,
              profilePicture: platformOwner.profilePicture,
              createdAt: platformOwner.createdAt,
              mustResetPassword: platformOwner.mustResetPassword,
            },
          });
        }
      );
      return;
    }

    // 3. Regular user flow: Find user in UserOrganizationMap
    const userMap = await UserOrganizationMap.findOne({ email: decoded.email.toLowerCase() });
    if (!userMap) {
      return res.status(401).json({ msg: 'User not found' });
    }

    // 4. Find the organization entry
    const orgEntry = userMap.organizations.find((org) => org.prefix === prefix);
    if (!orgEntry) {
      return res.status(403).json({ msg: 'You do not have access to this organization' });
    }

    // 5. Get the organization details and check status
    const org = await Organization.findOne({ collectionPrefix: prefix });
    if (!org) {
      return res.status(404).json({ msg: 'Organization not found' });
    }
    
    // Block access if organization is suspended (for regular users)
    if (org.status === 'SUSPENDED') {
      return res.status(403).json({ 
        msg: 'Organization is suspended. Contact support.',
      });
    }

    // 6. Get the user from the organization-specific collection
    const UserCollection = createUserModel(`${prefix}_users`);
    const user = await UserCollection.findById(orgEntry.userId);
    if (!user) {
      return res.status(404).json({ msg: 'User not found in organization' });
    }

    // 7. Update lastLogin timestamp (Ghost Mode: Skip for Platform Owner)
    if (user.role !== 'PLATFORM_OWNER') {
      user.lastLogin = new Date();
      await user.save();
    }

    // 8. Generate final JWT token with organization context
    const payload = {
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        collectionPrefix: prefix,
        organizationName: org.name,
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET as string,
      { expiresIn: '7d' },
      (err, token) => {
        if (err) throw err;
        res.json({
          token,
          user: {
            id: user._id,
            email: user.email,
            role: user.role,
            profile: user.profile,
            profilePicture: user.profilePicture,
            createdAt: user.createdAt,
            mustResetPassword: user.mustResetPassword,
          },
        });
      }
    );
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   POST /api/auth/switch-organization
// @desc    Switch to a different organization for the logged-in user
// @access  Private
export const switchOrganization = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { targetPrefix } = req.body;
  const { id: currentUserId, email: currentEmail, role: currentRole, collectionPrefix: currentPrefix } = req.user!;

  try {
    // 1. Platform Owner: Allow access to any organization
    if (currentRole === 'PLATFORM_OWNER') {
      const PLATFORM_OWNERS_COLLECTION = 'platform_owners_users';
      const PlatformOwnerCollection = createUserModel(PLATFORM_OWNERS_COLLECTION);
      const platformOwner = await PlatformOwnerCollection.findOne({ email: currentEmail.toLowerCase() });
      
      if (!platformOwner) {
        return res.status(401).json({ msg: 'Platform Owner not found' });
      }

      // Verify organization exists
      const org = await Organization.findOne({ collectionPrefix: targetPrefix });
      if (!org) {
        return res.status(404).json({ msg: 'Organization not found' });
      }
      
      // Platform Owner can access suspended organizations (to unsuspend them)
      // No status check needed for Platform Owner

      // Generate new JWT token with target organization context
      const payload = {
        user: {
          id: platformOwner._id.toString(),
          email: platformOwner.email,
          role: 'PLATFORM_OWNER',
          collectionPrefix: targetPrefix,
          organizationName: org.name,
        },
      };

      jwt.sign(
        payload,
        process.env.JWT_SECRET as string,
        { expiresIn: '7d' },
        (err, token) => {
          if (err) throw err;
          res.json({
            token,
            user: {
              id: platformOwner._id,
              email: platformOwner.email,
              role: platformOwner.role,
              profile: platformOwner.profile,
              profilePicture: platformOwner.profilePicture,
              createdAt: platformOwner.createdAt,
              mustResetPassword: platformOwner.mustResetPassword,
            },
          });
        }
      );
      return;
    }

    // 2. Regular user flow: Look up user in UserOrganizationMap
    const userMap = await UserOrganizationMap.findOne({ email: currentEmail.toLowerCase() });
    if (!userMap) {
      return res.status(401).json({ msg: 'User not found in organization map' });
    }

    // 3. Verify user belongs to targetPrefix
    const orgEntry = userMap.organizations.find((org) => org.prefix === targetPrefix);
    if (!orgEntry) {
      return res.status(403).json({ msg: 'You do not have access to this organization' });
    }

    // 4. Get the organization details
    const org = await Organization.findOne({ collectionPrefix: targetPrefix });
    if (!org) {
      return res.status(404).json({ msg: 'Organization not found' });
    }

    // 5. Get the user from the target organization-specific collection
    const UserCollection = createUserModel(`${targetPrefix}_users`);
    const user = await UserCollection.findById(orgEntry.userId);
    if (!user) {
      return res.status(404).json({ msg: 'User not found in organization' });
    }

    // 6. Update lastLogin timestamp (Ghost Mode: Skip for Platform Owner)
    if (user.role !== 'PLATFORM_OWNER') {
      user.lastLogin = new Date();
      await user.save();
    }

    // 7. Generate new JWT token with target organization context
    const payload = {
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        collectionPrefix: targetPrefix,
        organizationName: org.name,
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET as string,
      { expiresIn: '7d' },
      (err, token) => {
        if (err) throw err;
        res.json({
          token,
          user: {
            id: user._id,
            email: user.email,
            role: user.role,
            profile: user.profile,
            profilePicture: user.profilePicture,
            createdAt: user.createdAt,
            mustResetPassword: user.mustResetPassword,
          },
        });
      }
    );
  } catch (err: any) {
    console.error('Switch organization error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
};

// @route   GET /api/auth/my-organizations
// @desc    Get list of organizations the logged-in user belongs to
// @access  Private
export const getMyOrganizations = async (req: Request, res: Response) => {
  const { email, role } = req.user!;

  try {
    // 1. Platform Owner: Return all organizations
    if (role === 'PLATFORM_OWNER') {
      const allOrganizations = await Organization.find({}).sort({ name: 1 });
      const orgDetails = allOrganizations.map((org) => ({
        orgName: org.name,
        prefix: org.collectionPrefix,
        role: 'PLATFORM_OWNER',
        userId: req.user!.id,
        organizationName: org.name,
      }));
      return res.json({ organizations: orgDetails });
    }

    // 2. Regular user flow: Look up user in UserOrganizationMap
    const userMap = await UserOrganizationMap.findOne({ email: email.toLowerCase() });
    if (!userMap) {
      return res.status(404).json({ msg: 'User not found in organization map' });
    }

    // 3. Get organization details for all organizations
    const orgDetails = await Promise.all(
      userMap.organizations.map(async (orgEntry) => {
        const org = await Organization.findOne({ collectionPrefix: orgEntry.prefix });
        return {
          orgName: orgEntry.orgName,
          prefix: orgEntry.prefix,
          role: orgEntry.role,
          userId: orgEntry.userId,
          organizationName: org?.name || orgEntry.orgName,
        };
      })
    );

    res.json({ organizations: orgDetails });
  } catch (err: any) {
    console.error('Get my organizations error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
};

// @route   GET /api/auth/me
// @desc    Get the logged-in user's data from their token
// @access  Private
export const getMe = async (req: Request, res: Response) => {
  const { id: userId, collectionPrefix, role } = req.user!;

  try {
    // 1. Platform Owner: Get from special collection
    if (role === 'PLATFORM_OWNER') {
      const PLATFORM_OWNERS_COLLECTION = 'platform_owners_users';
      const PlatformOwnerCollection = createUserModel(PLATFORM_OWNERS_COLLECTION);
      const platformOwner = await PlatformOwnerCollection.findById(userId);

      if (!platformOwner) {
        return res.status(404).json({ msg: 'Platform Owner not found' });
      }

      // Get organization name if collectionPrefix is set
      let orgName = 'Platform';
      if (collectionPrefix) {
        const org = await Organization.findOne({ collectionPrefix });
        if (org) {
          orgName = org.name;
        }
      }

      res.json({
        user: {
          id: platformOwner._id,
          email: platformOwner.email,
          role: platformOwner.role,
          profile: platformOwner.profile,
          profilePicture: platformOwner.profilePicture,
          createdAt: platformOwner.createdAt,
          mustResetPassword: platformOwner.mustResetPassword,
          organization: orgName,
          collectionPrefix: collectionPrefix || null,
        },
      });
      return;
    }

    // 2. Regular user flow: Get the correct user collection
    const UserCollection = createUserModel(`${collectionPrefix}_users`);

    // 3. Find the user by their ID (from the token)
    const user = await UserCollection.findById(userId);

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // 4. Find the organization name
    const org = await Organization.findOne({ collectionPrefix });
    if (!org) {
      return res.status(404).json({ msg: 'Organization not found' });
    }

    // 5. Send back the same user object as the login route (plus organization)
    res.json({
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        profile: user.profile,
        profilePicture: user.profilePicture,
        createdAt: user.createdAt,
        mustResetPassword: user.mustResetPassword,
        organization: org.name,
        collectionPrefix: collectionPrefix,
      },
    });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   POST /api/auth/force-reset-password
// @desc    Force password reset - requires old password and new password
// @access  Private
export const forceResetPassword = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { id: userId, collectionPrefix } = req.user!;
  const { oldPassword, newPassword } = req.body;

  try {
    // 1. Get the correct user collection
    const UserCollection = createUserModel(`${collectionPrefix}_users`);

    // 2. Find the user by their ID - MUST select password since it's select: false by default
    const user = await UserCollection.findById(userId).select('+password');

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // 3. Verify the old password matches
    const isMatch = await user.matchPassword(oldPassword);
    if (!isMatch) {
      return res.status(401).json({ msg: 'Old password is incorrect' });
    }

    // 4. Update the password and set mustResetPassword to false
    user.password = newPassword; // Will be hashed by the pre-save hook
    user.mustResetPassword = false;

    // 5. Save the user
    await user.save();

    res.json({
      msg: 'Password reset successfully. Please log in again with your new password.',
    });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   POST /api/auth/forgot-password
// @desc    Send password reset email
// @access  Public
export const forgotPassword = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { organizationName, email } = req.body;

  try {
    // 1. Find the organization in the MASTER list to get the collectionPrefix
    const org = await Organization.findOne({ name: organizationName });
    if (!org) {
      // Don't reveal that the organization doesn't exist (security best practice)
      return res.json({
        msg: 'If that email exists in our system, you will receive a password reset link.',
      });
    }

    // 2. Get the correct user collection
    const UserCollection = createUserModel(`${org.collectionPrefix}_users`);

    // 3. Find the user by email - MUST select reset token fields
    const user = await UserCollection.findOne({ email }).select('+resetPasswordToken +resetPasswordExpire');

    if (!user) {
      // Don't reveal that the email doesn't exist (security best practice)
      return res.json({
        msg: 'If that email exists in our system, you will receive a password reset link.',
      });
    }

    // 4. Generate reset token
    const resetToken = user.getResetPasswordToken();
    await user.save({ validateBeforeSave: false });

    // 5. Create reset URL
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const resetUrl = `${clientUrl}/reset-password/${org.collectionPrefix}/${resetToken}`;

    // 6. Create HTML message
    const message = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h3 style="color: #333;">Password Reset Request</h3>
        <p>You requested a password reset for your AttendMark account.</p>
        <p>Click the button below to reset it (valid for 10 minutes):</p>
        <p style="margin: 25px 0;">
          <a href="${resetUrl}" style="background-color: #f04129; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">Reset Password</a>
        </p>
        <p style="color: #666; font-size: 14px;">If you did not request this, please ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="color: #999; font-size: 12px;">If the button doesn't work, copy and paste this link into your browser:</p>
        <p style="color: #999; font-size: 12px; word-break: break-all;">${resetUrl}</p>
      </div>
    `;

    try {
      await sendEmail({
        email: user.email,
        subject: 'Password Reset Request - AttendMark',
        message: message,
      });

      res.json({
        msg: 'If that email exists in our system, you will receive a password reset link.',
      });
    } catch (err: any) {
      console.error('Failed to send password reset email:', err.message);
      // Clear the reset token since email failed
      user.resetPasswordToken = undefined;
      user.resetPasswordExpire = undefined;
      await user.save({ validateBeforeSave: false });

      return res.status(500).json({ msg: 'Email could not be sent' });
    }
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   GET /api/auth/run-migration
// @desc    Run migration to populate UserOrganizationMap from existing organization collections
// @access  Public (should be protected in production)
export const runMigration = async (_req: Request, res: Response) => {
  try {
    console.log('🚀 Starting UserOrganizationMap migration via API...');

    // 1. Get all organizations
    const organizations = await Organization.find({}).sort({ name: 1 });
    
    if (organizations.length === 0) {
      return res.json({
        msg: 'No organizations found. Nothing to migrate.',
        totalUsers: 0,
        totalMapped: 0,
        errors: [],
      });
    }

    let totalUsers = 0;
    let totalMapped = 0;
    const errors: string[] = [];
    const logs: string[] = [];

    logs.push(`Found ${organizations.length} organization(s)`);

    // 2. Iterate through each organization
    for (const org of organizations) {
      try {
        logs.push(`Processing organization: ${org.name} (${org.collectionPrefix})`);
        
        const UserCollection = createUserModel(`${org.collectionPrefix}_users`);
        const users = await UserCollection.find({}).select('email role');

        logs.push(`  Found ${users.length} user(s) in this organization`);

        if (users.length === 0) {
          logs.push(`  ⏭️  Skipping (no users found)`);
          continue;
        }

        // 3. For each user, update UserOrganizationMap
        for (const user of users) {
          try {
            const userEmail = user.email.toLowerCase();
            
            await UserOrganizationMap.findOneAndUpdate(
              { email: userEmail },
              {
                $addToSet: {
                  // Use $addToSet to avoid duplicates
                  organizations: {
                    orgName: org.name,
                    prefix: org.collectionPrefix,
                    role: user.role,
                    userId: user._id.toString(),
                  },
                },
              },
              { upsert: true, new: true }
            );
            
            totalMapped++;
            logs.push(`  ✅ Mapped user: ${userEmail} -> ${org.name} (${user.role})`);
          } catch (userErr: any) {
            const errorMsg = `Error mapping user ${user.email} in ${org.name}: ${userErr.message}`;
            errors.push(errorMsg);
            logs.push(`  ❌ ${errorMsg}`);
          }
        }
        totalUsers += users.length;
      } catch (orgErr: any) {
        const errorMsg = `Error processing organization ${org.name}: ${orgErr.message}`;
        errors.push(errorMsg);
        logs.push(`❌ ${errorMsg}`);
      }
    }

    const summary = {
      msg: 'Migration completed',
      totalOrganizations: organizations.length,
      totalUsers,
      totalMapped,
      errors: errors.length > 0 ? errors : undefined,
      logs: logs.slice(0, 100), // Limit logs to first 100 entries to avoid huge response
    };

    console.log('✅ Migration completed:', summary);

    res.json(summary);
  } catch (err: any) {
    console.error('Migration error:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({ 
      msg: 'Migration failed', 
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
};

// @route   PUT /api/auth/reset-password/:collectionPrefix/:resetToken
// @desc    Reset password with token
// @access  Public
export const resetPassword = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { collectionPrefix, resetToken } = req.params;
  const { newPassword } = req.body;

  try {
    // 1. Hash the token from the URL to compare with the stored hash
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

    // 2. Get the correct user collection
    const UserCollection = createUserModel(`${collectionPrefix}_users`);

    // 3. Find user with matching token that hasn't expired
    const user = await UserCollection.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() },
    }).select('+resetPasswordToken +resetPasswordExpire');

    if (!user) {
      return res.status(400).json({ msg: 'Invalid or expired reset token' });
    }

    // 4. Set new password
    user.password = newPassword; // Will be hashed by the pre-save hook
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    user.mustResetPassword = false; // Also clear the force reset flag

    // 5. Save the user
    await user.save();

    res.json({
      msg: 'Password reset successful. You can now log in with your new password.',
    });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

