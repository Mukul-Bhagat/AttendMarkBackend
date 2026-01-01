import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import connectDB from '../config/db';
import createUserModel from '../models/User';

// Load environment variables from backend/.env
const envPath = path.join(__dirname, '../../.env');
dotenv.config({ path: envPath });

// Fix Mongoose deprecation warning
mongoose.set('strictQuery', false);

const seedPlatformOwner = async () => {
  try {
    console.log('🚀 Starting Platform Owner seed...\n');

    // 1. Connect to MongoDB
    await connectDB();
    console.log('✅ Connected to MongoDB\n');

    // 2. Platform Owner credentials
    const PLATFORM_OWNER_EMAIL = 'supermukul@attendmark.com';
    const PLATFORM_OWNER_PASSWORD = 'attend#321';
    const PLATFORM_OWNER_FIRST_NAME = 'Platform';
    const PLATFORM_OWNER_LAST_NAME = 'Owner';
    
    // 3. Create special collection for Platform Owners
    // Platform Owners don't belong to any organization, so they use a special collection
    const PLATFORM_OWNERS_COLLECTION = 'platform_owners_users';
    const UserCollection = createUserModel(PLATFORM_OWNERS_COLLECTION);

    // 4. Check if Platform Owner already exists
    const existingUser = await UserCollection.findOne({ email: PLATFORM_OWNER_EMAIL.toLowerCase() });
    
    if (existingUser) {
      console.log(`⚠️  Platform Owner with email ${PLATFORM_OWNER_EMAIL} already exists.`);
      console.log('   Deleting existing account to force re-seed...\n');
      await UserCollection.deleteOne({ email: PLATFORM_OWNER_EMAIL.toLowerCase() });
      console.log('✅ Existing account deleted. Proceeding with re-seed...\n');
    }

    // 5. Create the Platform Owner user
    console.log('👤 Creating Platform Owner account...');
    const platformOwner = new UserCollection({
      email: PLATFORM_OWNER_EMAIL.toLowerCase(),
      password: PLATFORM_OWNER_PASSWORD, // Will be hashed by the pre-save hook
      role: 'PLATFORM_OWNER',
      profile: {
        firstName: PLATFORM_OWNER_FIRST_NAME,
        lastName: PLATFORM_OWNER_LAST_NAME,
      },
      mustResetPassword: false, // Platform Owner doesn't need to reset password
    });

    // Save the user (password will be automatically hashed by the pre-save hook)
    await platformOwner.save();
    console.log('✅ Platform Owner account created successfully!\n');

    // 7. Summary
    console.log('='.repeat(60));
    console.log('📊 Platform Owner Seed Summary:');
    console.log('='.repeat(60));
    console.log(`Email: ${PLATFORM_OWNER_EMAIL}`);
    console.log(`Role: PLATFORM_OWNER`);
    console.log(`Collection: ${PLATFORM_OWNERS_COLLECTION}`);
    console.log(`Organization: None (Platform-level account)`);
    console.log('='.repeat(60));
    console.log('\n✅ Seed completed successfully!\n');
    console.log('⚠️  IMPORTANT: This account is invisible to tenant admins.');
    console.log('   It will NOT appear in getAllUsers or getAllStaff endpoints.\n');

    // 8. Close the connection
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ Seed failed:', error.message);
    console.error(error.stack);
    await mongoose.connection.close();
    process.exit(1);
  }
};

// Run the seed
seedPlatformOwner();

