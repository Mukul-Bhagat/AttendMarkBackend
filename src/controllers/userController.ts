import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import createUserModel from '../models/User';
import UserOrganizationMap from '../models/UserOrganizationMap';
import Organization from '../models/Organization';
import AuditLog from '../models/AuditLog';
import path from 'path';
import fs from 'fs';
import mongoose from 'mongoose';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { sendEmail } from '../utils/email';
import { logAction } from '../utils/auditLogger';

// @route   GET /api/users/my-organization
export const getOrganizationUsers = async (req: Request, res: Response) => {
  const { collectionPrefix, role: requesterRole } = req.user!;

  try {
    // 1. Get the organization-specific User model
    const UserCollection = createUserModel(`${collectionPrefix}_users`);

    // 2. Determine which roles to fetch
    // Default: Exclude PLATFORM_OWNER (they must remain invisible to tenant admins)
    // For Platform Owner: Also include COMPANY_ADMIN so they can manage them
    let roleFilter: any = { role: { $ne: 'PLATFORM_OWNER' } };
    
    // If Platform Owner is requesting, include COMPANY_ADMIN in the results
    // (The filter already includes COMPANY_ADMIN by default since we only exclude PLATFORM_OWNER)
    // This is just for clarity - the filter will return all roles except PLATFORM_OWNER

    // 3. Find all users in that collection
    // We only select fields the admin needs to see
    // Include registeredDeviceId explicitly using + prefix (it's marked select: false in schema)
    // Include customLeaveQuota for quota management
    const users = await UserCollection.find(roleFilter).select(
      'profile.firstName profile.lastName profile.phone email role +registeredDeviceId customLeaveQuota'
    );

    res.json(users);
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   POST /api/users/staff
// @desc    Create a new staff member (Manager or SessionAdmin) - Only SuperAdmin can do this
// @access  Private (SuperAdmin only)
export const createStaff = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { collectionPrefix, role: requesterRole } = req.user!;

  // Only SuperAdmin can create staff members
  if (requesterRole !== 'SuperAdmin') {
    return res.status(403).json({ msg: 'Only Super Admin can create staff members' });
  }

  const { email, password, role, firstName, lastName, phone } = req.body;

  // Validate that the role is either Manager or SessionAdmin
  if (role !== 'Manager' && role !== 'SessionAdmin') {
    return res.status(400).json({ msg: 'Role must be either Manager or SessionAdmin' });
  }

  try {
    // Get the organization-specific User model
    const UserCollection = createUserModel(`${collectionPrefix}_users`);

    // Check if user already exists
    const existingUser = await UserCollection.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ msg: 'User with this email already exists' });
    }

    // Create the new staff member
    const newStaff = new UserCollection({
      email: email.toLowerCase(),
      password, // Will be hashed by the pre-save hook
      role,
      profile: {
        firstName,
        lastName,
        phone: phone || undefined,
      },
      mustResetPassword: true, // Staff members must reset password on first login
    });

    await newStaff.save();

    // Add user to UserOrganizationMap
    const org = await Organization.findOne({ collectionPrefix });
    if (org) {
      await UserOrganizationMap.findOneAndUpdate(
        { email: email.toLowerCase() },
        {
          $push: {
            organizations: {
              orgName: org.name,
              prefix: collectionPrefix,
              role: role,
              userId: newStaff._id.toString(),
            },
          },
        },
        { upsert: true, new: true }
      );
    }

    // Log staff creation to audit log
    await logAction(
      'CREATE_STAFF',
      {
        id: req.user!.id,
        email: req.user!.email,
        role: requesterRole,
        collectionPrefix,
      },
      newStaff._id,
      {
        message: `Added new user: ${firstName} ${lastName} (${email.toLowerCase()}).`,
        firstName,
        lastName,
        email: email.toLowerCase(),
        role,
      },
      org?._id,
      org?.name,
      email.toLowerCase()
    );

    // Send welcome email with login credentials
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const welcomeEmailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h3 style="color: #f04129;">Welcome to AttendMark!</h3>
        <p>Your account has been created by your administrator.</p>
        <p><strong>Email:</strong> ${email.toLowerCase()}</p>
        <p><strong>Temporary Password:</strong> <code style="background-color: #f0f0f0; padding: 2px 6px; border-radius: 3px;">${password}</code></p>
        <p>Please log in at: <a href="${clientUrl}">${clientUrl}</a></p>
        <p style="color: #666; font-size: 14px;">Note: You will be asked to change this password on your first login.</p>
      </div>
    `;

    try {
      await sendEmail({
        email: email.toLowerCase(),
        subject: 'Welcome to AttendMark - Your Login Credentials',
        message: welcomeEmailHtml,
      });
    } catch (emailErr: any) {
      console.error('User created but failed to send welcome email:', emailErr.message);
      // Don't fail user creation if email fails
    }

    // Return user without password
    const userResponse = await UserCollection.findById(newStaff._id).select('-password');

    res.status(201).json({
      msg: `${role} created successfully`,
      user: userResponse,
    });
  } catch (err: any) {
    console.error(err.message);
    if (err.code === 11000) {
      return res.status(400).json({ msg: 'User with this email already exists' });
    }
    res.status(500).send('Server error');
  }
};

// @route   POST /api/users/bulk
// @desc    Bulk create EndUsers from CSV data
// @access  Private (SuperAdmin or CompanyAdmin)
export const bulkCreateUsers = async (req: Request, res: Response) => {
  const { collectionPrefix, role: requesterRole } = req.user!;

  // 1. Security Check: Only SuperAdmin or CompanyAdmin can bulk create users
  if (requesterRole !== 'SuperAdmin' && requesterRole !== 'CompanyAdmin') {
    return res.status(403).json({ msg: 'Not authorized' });
  }

  const { users, temporaryPassword, useRandomPassword } = req.body;

  // Validate input
  if (!Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ msg: 'Users array is required and must not be empty' });
  }

  // Validate password requirements
  if (!useRandomPassword) {
    if (!temporaryPassword || temporaryPassword.length < 6) {
      return res.status(400).json({ msg: 'Temporary password is required and must be at least 6 characters when not using random passwords' });
    }
  }

  try {
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    let successCount = 0;
    let duplicateCount = 0;
    const errors: string[] = [];
    const emailPromises: Promise<void>[] = [];
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

    // Process each user
    for (const [index, userData] of users.entries()) {
      const rowNumber = index + 1;
      
      try {
        const { firstName, lastName, email, role, phone } = userData;

        // Validate required fields
        if (!firstName || !lastName || !email) {
          errors.push(`Row ${rowNumber}: Missing required fields (FirstName, LastName, Email) for ${email || 'unknown'}`);
          continue;
        }

        // Handle role mapping (case-insensitive)
        // If role column is missing or empty, default to EndUser
        let finalRole: string;
        const normalizedRole = (role !== undefined && role !== null ? String(role) : '').trim();
        
        if (!normalizedRole || normalizedRole.toLowerCase() === 'user' || normalizedRole.toLowerCase() === 'enduser') {
          finalRole = 'EndUser';
        } else if (normalizedRole.toLowerCase() === 'manager') {
          finalRole = 'Manager';
        } else if (normalizedRole.toLowerCase() === 'sessionadmin' || normalizedRole.toLowerCase() === 'session admin') {
          finalRole = 'SessionAdmin';
        } else {
          errors.push(`Row ${rowNumber}: Invalid role "${role}" for ${email}. Role must be 'Manager' or 'SessionAdmin' (case-insensitive), or empty/missing (defaults to 'User')`);
          continue;
        }

        // Check if user already exists (wrap in try/catch for duplicate key errors)
        let existingUser;
        try {
          existingUser = await UserCollection.findOne({ email: email.toLowerCase() });
        } catch (dbErr: any) {
          console.error(`Row ${rowNumber}: Database error checking existing user:`, dbErr.message);
          errors.push(`Row ${rowNumber}: Error checking duplicate email "${email}"`);
          continue;
        }
        
        if (existingUser) {
          duplicateCount++;
          errors.push(`Row ${rowNumber}: Duplicate email "${email}" already exists`);
          continue;
        }

        // Generate password: random if useRandomPassword is true, otherwise use temporaryPassword
        let userPassword: string;
        if (useRandomPassword) {
          // Generate a random 6-character alphanumeric password
          // Using crypto for secure randomness
          const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
          userPassword = '';
          for (let i = 0; i < 6; i++) {
            const randomIndex = crypto.randomBytes(1)[0] % chars.length;
            userPassword += chars[randomIndex];
          }
        } else {
          userPassword = temporaryPassword;
        }

        // Create new user with the determined role (wrap in try/catch)
        try {
          const newUser = new UserCollection({
            email: email.toLowerCase(),
            password: userPassword, // Will be hashed by the pre-save hook
            role: finalRole,
            profile: {
              firstName: firstName.trim(),
              lastName: lastName.trim(),
              phone: phone ? phone.trim() : undefined,
            },
            mustResetPassword: true,
          });

          await newUser.save();
          
          // Add user to UserOrganizationMap
          try {
            const org = await Organization.findOne({ collectionPrefix });
            if (org) {
              await UserOrganizationMap.findOneAndUpdate(
                { email: email.toLowerCase() },
                {
                  $push: {
                    organizations: {
                      orgName: org.name,
                      prefix: collectionPrefix,
                      role: finalRole,
                      userId: newUser._id.toString(),
                    },
                  },
                },
                { upsert: true, new: true }
              );
            }
          } catch (mapErr: any) {
            // Log but don't fail the entire import if UserOrganizationMap update fails
            console.error(`Row ${rowNumber}: Error updating UserOrganizationMap for ${email}:`, mapErr.message);
          }
          
          successCount++;

          // Queue welcome email (don't await - collect for Promise.all)
          const roleDisplayName = finalRole === 'EndUser' ? 'User' : finalRole;
          const welcomeEmailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h3 style="color: #f04129;">Welcome to AttendMark!</h3>
              <p>Your account has been created by your administrator.</p>
              <p><strong>Email:</strong> ${email.toLowerCase()}</p>
              ${finalRole !== 'EndUser' ? `<p><strong>Role:</strong> ${roleDisplayName}</p>` : ''}
              <p><strong>Temporary Password:</strong> <code style="background-color: #f0f0f0; padding: 2px 6px; border-radius: 3px;">${userPassword}</code></p>
              <p>Please log in at: <a href="${clientUrl}">${clientUrl}</a></p>
              <p style="color: #666; font-size: 14px;">Note: You will be asked to change this password on your first login.</p>
            </div>
          `;

          emailPromises.push(
            sendEmail({
              email: email.toLowerCase(),
              subject: 'Welcome to AttendMark - Your Login Credentials',
              message: welcomeEmailHtml,
            }).catch((emailErr: any) => {
              console.error(`User ${email} created but failed to send welcome email:`, emailErr.message);
              // Don't fail - just log
            })
          );
        } catch (saveErr: any) {
          // Handle duplicate email or other database errors
          if (saveErr.code === 11000 || saveErr.message?.includes('duplicate')) {
            duplicateCount++;
            errors.push(`Row ${rowNumber}: Duplicate email "${email || 'unknown'}" already exists`);
          } else {
            console.error(`Row ${rowNumber}: Error saving user:`, saveErr.message);
            errors.push(`Row ${rowNumber}: Failed to create user: ${saveErr.message || 'Unknown error'}`);
          }
          continue;
        }
      } catch (rowErr: any) {
        // Catch any unexpected errors for this row
        console.error(`Row ${rowNumber}: Unexpected error:`, rowErr.message);
        errors.push(`Row ${rowNumber}: Processing error: ${rowErr.message || 'Unknown error'}`);
        continue;
      }
    }

    // Send all welcome emails in parallel (don't block response)
    Promise.all(emailPromises).catch((err) => {
      console.error('Error sending bulk welcome emails:', err);
    });

    res.status(201).json({
      msg: `Bulk import completed: ${successCount} users created, ${duplicateCount} duplicates skipped`,
      successCount,
      duplicateCount,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    console.error('Error in bulk user creation:', err);
    res.status(500).json({ msg: 'Server error during bulk import', error: err.message });
  }
};

// @route   POST /api/users/staff/bulk
// @desc    Bulk create Staff members (Manager or SessionAdmin) from CSV data
// @access  Private (SuperAdmin only)
export const bulkCreateStaff = async (req: Request, res: Response) => {
  const { collectionPrefix, role: requesterRole } = req.user!;

  // 1. Security Check: Only SuperAdmin can bulk create staff
  if (requesterRole !== 'SuperAdmin') {
    return res.status(403).json({ msg: 'Only Super Admin can bulk create staff members' });
  }

  const { staff, temporaryPassword, useRandomPassword } = req.body;

  // Validate input
  if (!Array.isArray(staff) || staff.length === 0) {
    return res.status(400).json({ msg: 'Staff array is required and must not be empty' });
  }

  // Validate password requirements
  if (!useRandomPassword) {
    if (!temporaryPassword || temporaryPassword.length < 6) {
      return res.status(400).json({ msg: 'Temporary password is required and must be at least 6 characters when not using random passwords' });
    }
  }

  try {
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    let successCount = 0;
    let duplicateCount = 0;
    const errors: string[] = [];
    const emailPromises: Promise<void>[] = [];
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

    // Process each staff member
    for (let index = 0; index < staff.length; index++) {
      const staffData = staff[index];
      const { firstName, lastName, email, role, phone } = staffData;
      const rowNumber = index + 1;

      // Validate required fields
      if (!firstName || !lastName || !email || !role) {
        errors.push(`Row ${rowNumber}: Missing required fields for ${email || 'unknown'}`);
        continue;
      }

      // Validate role (case-insensitive)
      const normalizedRole = role.trim();
      const validRoles = ['Manager', 'SessionAdmin'];
      const roleMatch = validRoles.find(r => r.toLowerCase() === normalizedRole.toLowerCase());
      
      if (!roleMatch) {
        errors.push(`Row ${rowNumber}: Invalid role "${role}" for ${email}. Role must be 'Manager' or 'SessionAdmin' (case-insensitive)`);
        continue;
      }
      
      // Use the properly cased role
      const finalRole = roleMatch;

      // Check if user already exists
      const existingUser = await UserCollection.findOne({ email: email.toLowerCase() });
      if (existingUser) {
        duplicateCount++;
        errors.push(`Row ${rowNumber}: Duplicate email ${email} already exists`);
        continue;
      }

      // Generate password: random if useRandomPassword is true, otherwise use temporaryPassword
      let userPassword: string;
      if (useRandomPassword) {
        // Generate a random 6-character alphanumeric password
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        userPassword = '';
        for (let i = 0; i < 6; i++) {
          const randomIndex = crypto.randomBytes(1)[0] % chars.length;
          userPassword += chars[randomIndex];
        }
      } else {
        userPassword = temporaryPassword;
      }

      // Create new staff member
      const newStaff = new UserCollection({
        email: email.toLowerCase(),
        password: userPassword, // Will be hashed by the pre-save hook
        role: finalRole,
        profile: {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone ? phone.trim() : undefined,
        },
        mustResetPassword: true, // Staff members must reset password on first login
      });

      await newStaff.save();

      // Add user to UserOrganizationMap
      const org = await Organization.findOne({ collectionPrefix });
      if (org) {
        await UserOrganizationMap.findOneAndUpdate(
          { email: email.toLowerCase() },
          {
            $push: {
              organizations: {
                orgName: org.name,
                prefix: collectionPrefix,
                role: finalRole,
                userId: newStaff._id.toString(),
              },
            },
          },
          { upsert: true, new: true }
        );
      }

      successCount++;

      // Queue welcome email (don't await - collect for Promise.all)
      const welcomeEmailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h3 style="color: #f04129;">Welcome to AttendMark!</h3>
          <p>Your staff account has been created by your administrator.</p>
          <p><strong>Email:</strong> ${email.toLowerCase()}</p>
          <p><strong>Role:</strong> ${finalRole}</p>
          <p><strong>Temporary Password:</strong> <code style="background-color: #f0f0f0; padding: 2px 6px; border-radius: 3px;">${userPassword}</code></p>
          <p>Please log in at: <a href="${clientUrl}">${clientUrl}</a></p>
          <p style="color: #666; font-size: 14px;">Note: You will be asked to change this password on your first login.</p>
        </div>
      `;

      emailPromises.push(
        sendEmail({
          email: email.toLowerCase(),
          subject: 'Welcome to AttendMark - Your Staff Login Credentials',
          message: welcomeEmailHtml,
        }).catch((emailErr: any) => {
          console.error(`Staff ${email} created but failed to send welcome email:`, emailErr.message);
          // Don't fail - just log
        })
      );
    }

    // Send all welcome emails in parallel (don't block response)
    Promise.all(emailPromises).catch((err) => {
      console.error('Error sending bulk welcome emails:', err);
    });

    res.status(201).json({
      msg: `Bulk import completed: ${successCount} staff members created, ${duplicateCount} duplicates skipped`,
      successCount,
      duplicateCount,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    console.error('Error in bulk staff creation:', err);
    res.status(500).json({ msg: 'Server error during bulk import', error: err.message });
  }
};

// @route   POST /api/users/staff/bulk-import
// @desc    Bulk import Staff members (Manager or SessionAdmin) from CSV data
// @access  Private (SuperAdmin or CompanyAdmin or Platform Owner)
export const bulkImportStaff = async (req: Request, res: Response) => {
  const { collectionPrefix, role: requesterRole } = req.user!;

  // 1. Security Check: Only SuperAdmin, CompanyAdmin, or Platform Owner can bulk import staff
  if (requesterRole !== 'SuperAdmin' && requesterRole !== 'CompanyAdmin' && requesterRole !== 'PLATFORM_OWNER') {
    return res.status(403).json({ msg: 'Not authorized to bulk import staff members' });
  }

  const { staff } = req.body; // Array of { firstName, lastName, email, phone, role }

  // Validate input
  if (!Array.isArray(staff) || staff.length === 0) {
    return res.status(400).json({ msg: 'Staff array is required and must not be empty' });
  }

  try {
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    let successCount = 0;
    let duplicateCount = 0;
    const errors: string[] = [];
    const emailPromises: Promise<void>[] = [];
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

    // Process each staff member
    for (let index = 0; index < staff.length; index++) {
      const staffData = staff[index];
      const { firstName, lastName, email, phone, role } = staffData;
      const rowNumber = index + 1;

      // Validate required fields
      if (!firstName || !lastName || !email || !role) {
        errors.push(`Row ${rowNumber}: Missing required fields (firstName, lastName, email, or role)`);
        continue;
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        errors.push(`Row ${rowNumber}: Invalid email format for ${email}`);
        continue;
      }

      // Validate role (case-insensitive)
      const normalizedRole = role.trim();
      const validRoles = ['Manager', 'SessionAdmin'];
      const roleMatch = validRoles.find(r => r.toLowerCase() === normalizedRole.toLowerCase());
      
      if (!roleMatch) {
        errors.push(`Row ${rowNumber}: Invalid role "${role}" for ${email}. Role must be 'Manager' or 'SessionAdmin'`);
        continue;
      }
      
      // Use the properly cased role
      const finalRole = roleMatch;

      // Check if user already exists
      const existingUser = await UserCollection.findOne({ email: email.toLowerCase() });
      if (existingUser) {
        duplicateCount++;
        errors.push(`Row ${rowNumber}: User with email ${email} already exists`);
        continue;
      }

      // Generate default password: "Staff@123" or random 6-digit numeric
      // Using default "Staff@123" as specified, but can be changed to random if needed
      const defaultPassword = 'Staff@123';
      // Alternative: Generate random 6-digit numeric password
      // const defaultPassword = crypto.randomInt(100000, 999999).toString();

      // Create new staff member
      const newStaff = new UserCollection({
        email: email.toLowerCase(),
        password: defaultPassword, // Will be hashed by the pre-save hook
        role: finalRole,
        profile: {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone ? phone.trim() : undefined,
        },
        mustResetPassword: true, // Staff members must reset password on first login
      });

      await newStaff.save();

      // Add user to UserOrganizationMap
      const org = await Organization.findOne({ collectionPrefix });
      if (org) {
        await UserOrganizationMap.findOneAndUpdate(
          { email: email.toLowerCase() },
          {
            $push: {
              organizations: {
                orgName: org.name,
                prefix: collectionPrefix,
                role: finalRole,
                userId: newStaff._id.toString(),
              },
            },
          },
          { upsert: true, new: true }
        );
      }

      successCount++;

      // Send welcome email
      const welcomeEmailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h3 style="color: #f04129;">Welcome to AttendMark!</h3>
          <p>Your staff account has been created by your administrator.</p>
          <p><strong>Email:</strong> ${email.toLowerCase()}</p>
          <p><strong>Role:</strong> ${finalRole}</p>
          <p><strong>Temporary Password:</strong> <code style="background-color: #f0f0f0; padding: 4px 8px; border-radius: 4px; font-size: 16px; font-weight: bold;">${defaultPassword}</code></p>
          <p>Please log in at: <a href="${clientUrl}">${clientUrl}</a></p>
          <p style="color: #666; font-size: 14px;">Note: You will be asked to change this password on your first login.</p>
        </div>
      `;

      emailPromises.push(
        sendEmail({
          email: email.toLowerCase(),
          subject: 'Welcome to AttendMark - Your Staff Login Credentials',
          message: welcomeEmailHtml,
        }).catch((emailErr: any) => {
          console.error(`Staff ${email} created but failed to send welcome email:`, emailErr.message);
          // Don't fail - just log
        })
      );
    }

    // Send all welcome emails in parallel (don't block response)
    Promise.all(emailPromises).catch((err) => {
      console.error('Error sending bulk welcome emails:', err);
    });

    // Get organization details for audit log
    const org = await Organization.findOne({ collectionPrefix });

    // Log bulk import to audit log
    if (successCount > 0) {
      await logAction(
        'BULK_IMPORT_STAFF',
        {
          id: req.user!.id,
          email: req.user!.email,
          role: requesterRole,
          collectionPrefix,
        },
        undefined, // No specific target user for bulk import
        {
          message: `Imported ${successCount} new staff members via CSV.`,
          successCount,
          duplicateCount,
          totalProcessed: staff.length,
        },
        org?._id,
        org?.name
      );
    }

    res.status(201).json({
      msg: `Successfully imported ${successCount} staff members${duplicateCount > 0 ? `. ${duplicateCount} duplicates skipped.` : ''}`,
      successCount,
      duplicateCount,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    console.error('Error in bulk import staff:', err.message);
    res.status(500).json({ msg: 'Server error while bulk importing staff members' });
  }
};

// @route   POST /api/users/end-user
// @desc    Create a new EndUser
// @access  Private (SuperAdmin or CompanyAdmin)
export const createEndUser = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { collectionPrefix, role: requesterRole } = req.user!;

  // 1. Security Check: Only SuperAdmin or CompanyAdmin can create users
  if (requesterRole !== 'SuperAdmin' && requesterRole !== 'CompanyAdmin') {
    return res.status(403).json({ msg: 'Not authorized' });
  }

  const { email, password, firstName, lastName, phone } = req.body;

  try {
    // 2. Get the correct User collection
    const UserCollection = createUserModel(`${collectionPrefix}_users`);

    // 3. Check if user already exists
    const existingUser = await UserCollection.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ msg: 'User with this email already exists' });
    }

    // 4. Create new EndUser
    const newEndUser = new UserCollection({
      email: email.toLowerCase(),
      password, // Will be hashed by the pre-save hook
      role: 'EndUser', // Hard-code the role
      profile: {
        firstName,
        lastName,
        phone: phone || undefined,
      },
      mustResetPassword: true,
    });

    await newEndUser.save();

    // Add user to UserOrganizationMap
    const org = await Organization.findOne({ collectionPrefix });
    if (org) {
      await UserOrganizationMap.findOneAndUpdate(
        { email: email.toLowerCase() },
        {
          $push: {
            organizations: {
              orgName: org.name,
              prefix: collectionPrefix,
              role: 'EndUser',
              userId: newEndUser._id.toString(),
            },
          },
        },
        { upsert: true, new: true }
      );
    }

    // Log user creation to audit log
    await logAction(
      'CREATE_USER',
      {
        id: req.user!.id,
        email: req.user!.email,
        role: requesterRole,
        collectionPrefix,
      },
      newEndUser._id,
      {
        message: `Added new user: ${firstName} ${lastName} (${email.toLowerCase()}).`,
        firstName,
        lastName,
        email: email.toLowerCase(),
        role: 'EndUser',
      },
      org?._id,
      org?.name,
      email.toLowerCase()
    );

    // Send welcome email with login credentials
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const welcomeEmailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h3 style="color: #f04129;">Welcome to AttendMark!</h3>
        <p>Your account has been created by your administrator.</p>
        <p><strong>Email:</strong> ${email.toLowerCase()}</p>
        <p><strong>Temporary Password:</strong> <code style="background-color: #f0f0f0; padding: 2px 6px; border-radius: 3px;">${password}</code></p>
        <p>Please log in at: <a href="${clientUrl}">${clientUrl}</a></p>
        <p style="color: #666; font-size: 14px;">Note: You will be asked to change this password on your first login.</p>
      </div>
    `;

    try {
      await sendEmail({
        email: email.toLowerCase(),
        subject: 'Welcome to AttendMark - Your Login Credentials',
        message: welcomeEmailHtml,
      });
    } catch (emailErr: any) {
      console.error('User created but failed to send welcome email:', emailErr.message);
      // Don't fail user creation if email fails
    }

    // Return user without password
    const userResponse = await UserCollection.findById(newEndUser._id).select('-password');

    res.status(201).json({
      msg: 'EndUser created successfully',
      user: userResponse,
    });
  } catch (err: any) {
    console.error(err.message);
    if (err.code === 11000) {
      return res.status(400).json({ msg: 'User with this email already exists' });
    }
    res.status(500).send('Server error');
  }
};

// @route   PUT /api/users/:userId/reset-device
// @desc    Reset a user's registered device ID and generate new password
// @access  Private (SuperAdmin or CompanyAdmin)
export const resetDevice = async (req: Request, res: Response) => {
  const { collectionPrefix, role: requesterRole } = req.user!;
  const { userId } = req.params;

  // 1. Security Check: Allow SuperAdmin, CompanyAdmin, and Platform Owner
  if (requesterRole !== 'SuperAdmin' && requesterRole !== 'CompanyAdmin' && requesterRole !== 'PLATFORM_OWNER') {
    return res.status(403).json({ msg: 'Not authorized' });
  }

  try {
    // 2. Get the User collection
    const UserCollection = createUserModel(`${collectionPrefix}_users`);

    // 3. Find the user
    // Data Integrity: Using findById (not delete methods) to preserve all user data
    const user = await UserCollection.findById(userId);
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // 4. Clear Security Locks: Set registeredDeviceId and registeredUserAgent to null
    // Data Integrity: Only modifying these 3 fields. All other fields (Name, Email, Profile Picture, etc.) are preserved
    user.registeredDeviceId = undefined;
    user.registeredUserAgent = undefined;

    // 5. Generate New Password: Create a secure 6-digit numeric string (e.g., "482910")
    // Using crypto.randomInt for cryptographically secure random number generation
    const newPassword = crypto.randomInt(100000, 999999).toString();

    // 6. Hash Password: Hash this new password using bcrypt
    // Note: The User model has a pre-save hook that automatically hashes passwords
    // We'll set the plain password and let the pre-save hook handle the hashing
    // This ensures consistency with the rest of the codebase
    user.password = newPassword;
    user.mustResetPassword = true;
    
    // 7. Update User: Save the new password (will be hashed by pre-save hook) and cleared device fields
    // Data Integrity: Updating credentials only. User history and profile data are preserved because _id remains unchanged.
    // Using user.save() ensures only modified fields are updated, preserving all other data
    await user.save();

    // 8. Send Email: Email the user with the new temporary 6-digit PIN
    const emailSubject = 'Action Required: Device Reset & New Login PIN';
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #f04129;">Device Reset Notification</h2>
        <p>Your device binding has been reset by the administrator.</p>
        <p><strong>Your new temporary login PIN is: <code style="background-color: #f0f0f0; padding: 4px 8px; border-radius: 4px; font-size: 18px; font-weight: bold; letter-spacing: 2px;">${newPassword}</code></strong></p>
        <p>Please use this PIN to log in on your new device.</p>
        <p style="color: #666; font-size: 12px; margin-top: 20px;">If you did not request this reset, please contact your administrator immediately.</p>
      </div>
    `;

    try {
      await sendEmail({
        email: user.email,
        subject: emailSubject,
        message: emailHtml,
      });
    } catch (emailErr: any) {
      console.error('Error sending reset email:', emailErr);
      // Don't fail the request if email fails, but log it
      // The password was already reset, so we continue
    }

    // 9. Return user object (excluding password) to confirm account still exists with all data intact
    // Fetch the updated user without password field to return in response
    const updatedUser = await UserCollection.findById(userId).select('-password');
    
    res.json({
      msg: 'Device restriction removed. User can now link a new device. A new 6-digit PIN has been sent to their email.',
      user: updatedUser, // Return user object to confirm Name/Email/profile data are preserved
    });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   DELETE /api/users/:userId
// @desc    Delete a user account - Only SuperAdmin can delete users
// @access  Private (SuperAdmin only)
export const deleteUser = async (req: Request, res: Response) => {
  const { collectionPrefix, role: requesterRole, id: requesterId } = req.user!;
  const { userId } = req.params;

  // Validate userId is a valid ObjectId (prevent route conflicts like "profile-picture")
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ msg: 'Invalid user ID format' });
  }

  // 1. Security Check - Only SuperAdmin can delete users
  if (requesterRole !== 'SuperAdmin') {
    return res.status(403).json({ msg: 'Only Super Admin can delete users' });
  }

  // 2. Prevent SuperAdmin from deleting themselves
  if (userId === requesterId) {
    return res.status(400).json({ msg: 'You cannot delete your own account' });
  }

  try {
    // 3. Get the User collection
    const UserCollection = createUserModel(`${collectionPrefix}_users`);

    // 4. Find the user
    const user = await UserCollection.findById(userId);
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // 5. Prevent deleting SuperAdmin accounts (except the one making the request, which is already blocked above)
    if (user.role === 'SuperAdmin') {
      return res.status(400).json({ msg: 'Cannot delete Super Admin accounts' });
    }

    // Store user details for audit log before deletion
    const userName = `${user.profile?.firstName || ''} ${user.profile?.lastName || ''}`.trim() || user.email;
    const userEmail = user.email;
    const userRole = user.role;

    // Get organization details for audit log
    const org = await Organization.findOne({ collectionPrefix });

    // 6. Delete the user
    await UserCollection.findByIdAndDelete(userId);

    // Log user deletion to audit log
    await logAction(
      'DELETE_USER',
      {
        id: requesterId,
        email: req.user!.email,
        role: requesterRole,
        collectionPrefix,
      },
      userId,
      {
        message: `Deleted user: ${userName}.`,
        deletedUserName: userName,
        deletedUserEmail: userEmail,
        deletedUserRole: userRole,
      },
      org?._id,
      org?.name,
      userEmail
    );

    res.json({
      msg: 'User account deleted successfully',
    });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   PUT /api/users/:userId/reset-device-only
// @desc    Reset a user's registered device ID ONLY (without password reset) - Platform Owner only
// @access  Private (Platform Owner only)
export const resetDeviceOnly = async (req: Request, res: Response) => {
  const { collectionPrefix, role: requesterRole, id: performerId, email: performerEmail } = req.user!;
  const { userId } = req.params;

  // STRICT CHECK: Only Platform Owner can use this endpoint
  if (requesterRole !== 'PLATFORM_OWNER') {
    return res.status(403).json({ msg: 'Forbidden: Only Platform Owner can use this endpoint' });
  }

  // Validate userId is a valid ObjectId
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ msg: 'Invalid user ID format' });
  }

  try {
    // Get the User collection
    const UserCollection = createUserModel(`${collectionPrefix}_users`);

    // Find the user
    const user = await UserCollection.findById(userId).select('+registeredDeviceId +registeredUserAgent');
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Store old values for audit log
    const oldDeviceId = user.registeredDeviceId;
    const oldUserAgent = user.registeredUserAgent;

    // Clear Security Locks: Set registeredDeviceId and registeredUserAgent to null
    user.registeredDeviceId = undefined;
    user.registeredUserAgent = undefined;

    // Save the user (only device fields are modified)
    await user.save();

    // Log the action in AuditLog
    await AuditLog.create({
      organizationPrefix: collectionPrefix,
      action: 'DEVICE_RESET',
      performedBy: {
        userId: performerId.toString(),
        email: performerEmail,
        role: 'PLATFORM_OWNER',
      },
      targetUser: {
        userId: userId.toString(),
        email: user.email,
      },
      details: {
        oldDeviceId: oldDeviceId || null,
        oldUserAgent: oldUserAgent || null,
        note: 'Device reset without password change (Platform Owner action)',
      },
    });

    res.json({
      msg: 'Device restriction removed. User can now link a new device.',
      user: {
        id: user._id,
        email: user.email,
        registeredDeviceId: null,
      },
    });
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
};

// @route   POST /api/users/profile-picture
// @desc    Upload profile picture for the logged-in user
// @access  Private
export const uploadProfilePicture = async (req: Request, res: Response) => {
  const { collectionPrefix, id: userId } = req.user!;

  try {
    if (!req.file) {
      return res.status(400).json({ msg: 'No file uploaded' });
    }

    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const user = await UserCollection.findById(userId);

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Delete old profile picture if exists
    if (user.profilePicture) {
      const oldImagePath = path.join(__dirname, '../../public', user.profilePicture);
      if (fs.existsSync(oldImagePath)) {
        fs.unlinkSync(oldImagePath);
      }
    }

    // Save new profile picture URL (relative to public folder)
    const profilePictureUrl = `/uploads/${req.file.filename}`;
    user.profilePicture = profilePictureUrl;
    await user.save();

    res.json({
      msg: 'Profile picture uploaded successfully',
      profilePicture: profilePictureUrl,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        profile: user.profile,
        profilePicture: user.profilePicture,
        createdAt: user.createdAt,
      },
    });
  } catch (err: any) {
    console.error('Error uploading profile picture:', err);
    res.status(500).json({ msg: 'Server error while uploading profile picture' });
  }
};

// @route   PUT /api/users/profile
// @desc    Update user profile (firstName, lastName, phone, bio)
// @access  Private
export const updateProfile = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { collectionPrefix, id: userId } = req.user!;
  const { firstName, lastName, phone, bio } = req.body;

  try {
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const user = await UserCollection.findById(userId);

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Update profile fields
    if (firstName) user.profile.firstName = firstName;
    if (lastName) user.profile.lastName = lastName;
    if (phone !== undefined) user.profile.phone = phone || undefined;
    if (bio !== undefined) user.profile.bio = bio || undefined;

    await user.save();

    res.json({
      msg: 'Profile updated successfully',
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        profile: user.profile,
        profilePicture: user.profilePicture,
        createdAt: user.createdAt,
      },
    });
  } catch (err: any) {
    console.error('Error updating profile:', err);
    res.status(500).json({ msg: 'Server error while updating profile' });
  }
};

// @route   PUT /api/users/change-password
// @desc    Change user password
// @access  Private
export const changePassword = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { collectionPrefix, id: userId } = req.user!;
  const { oldPassword, newPassword } = req.body;

  try {
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const user = await UserCollection.findById(userId).select('+password');

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Verify old password
    const isMatch = await user.matchPassword(oldPassword);
    if (!isMatch) {
      return res.status(400).json({ msg: 'Current password is incorrect' });
    }

    // Update password (will be hashed by pre-save hook)
    user.password = newPassword;
    await user.save();

    res.json({ msg: 'Password changed successfully' });
  } catch (err: any) {
    console.error('Error changing password:', err);
    res.status(500).json({ msg: 'Server error while changing password' });
  }
};

// @route   PUT /api/users/:userId/quota
// @desc    Update a user's custom leave quota (or reset to default)
// @access  Private (SuperAdmin or CompanyAdmin)
export const updateUserQuota = async (req: Request, res: Response) => {
  const { collectionPrefix, role: requesterRole } = req.user!;
  const { userId } = req.params;
  const { pl, cl, sl, resetToDefault } = req.body;

  // Security Check: Only SuperAdmin or CompanyAdmin can update quotas
  if (requesterRole !== 'SuperAdmin' && requesterRole !== 'CompanyAdmin') {
    return res.status(403).json({ msg: 'Not authorized' });
  }

  // Validate userId is a valid ObjectId
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ msg: 'Invalid user ID format' });
  }

  try {
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const user = await UserCollection.findById(userId);

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // If resetToDefault is true, set customLeaveQuota to null
    if (resetToDefault === true) {
      user.customLeaveQuota = null;
      await user.save();

      return res.json({
        msg: 'User quota reset to organization default',
        user: {
          id: user._id,
          email: user.email,
          customLeaveQuota: null,
        },
      });
    }

    // Validate quota values if provided
    if (pl !== undefined && (typeof pl !== 'number' || pl < 0)) {
      return res.status(400).json({ msg: 'PL (Personal Leave) must be a non-negative number' });
    }
    if (cl !== undefined && (typeof cl !== 'number' || cl < 0)) {
      return res.status(400).json({ msg: 'CL (Casual Leave) must be a non-negative number' });
    }
    if (sl !== undefined && (typeof sl !== 'number' || sl < 0)) {
      return res.status(400).json({ msg: 'SL (Sick Leave) must be a non-negative number' });
    }

    // Update custom quota
    if (user.customLeaveQuota === null || user.customLeaveQuota === undefined) {
      user.customLeaveQuota = {
        pl: pl !== undefined ? pl : 0,
        cl: cl !== undefined ? cl : 0,
        sl: sl !== undefined ? sl : 0,
      };
    } else {
      if (pl !== undefined) user.customLeaveQuota.pl = pl;
      if (cl !== undefined) user.customLeaveQuota.cl = cl;
      if (sl !== undefined) user.customLeaveQuota.sl = sl;
    }

    await user.save();

    res.json({
      msg: 'User quota updated successfully',
      user: {
        id: user._id,
        email: user.email,
        customLeaveQuota: user.customLeaveQuota,
      },
    });
  } catch (err: any) {
    console.error('Error updating user quota:', err);
    res.status(500).json({ msg: 'Server error while updating quota' });
  }
};

// @route   DELETE /api/users/profile-picture
// @desc    Remove profile picture for the logged-in user
// @access  Private
export const removeProfilePicture = async (req: Request, res: Response) => {
  const { collectionPrefix, id: userId } = req.user!;

  try {
    const UserCollection = createUserModel(`${collectionPrefix}_users`);
    const user = await UserCollection.findById(userId);

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Delete profile picture file if exists
    if (user.profilePicture) {
      const oldImagePath = path.join(__dirname, '../../public', user.profilePicture);
      if (fs.existsSync(oldImagePath)) {
        fs.unlinkSync(oldImagePath);
      }
    }

    // Clear profile picture from user (set to undefined to remove it)
    user.profilePicture = undefined;
    await user.save();

    res.json({
      msg: 'Profile picture removed successfully',
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        profile: user.profile,
        profilePicture: user.profilePicture,
        createdAt: user.createdAt,
      },
    });
  } catch (err: any) {
    console.error('Error removing profile picture:', err);
    res.status(500).json({ msg: 'Server error while removing profile picture' });
  }
};

