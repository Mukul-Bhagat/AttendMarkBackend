import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import connectDB from '../config/db';
import Organization from '../models/Organization';
import UserOrganizationMap from '../models/UserOrganizationMap';
import createUserModel from '../models/User';

// Load environment variables from backend/.env
const envPath = path.join(__dirname, '../../.env');
dotenv.config({ path: envPath });

// Fix Mongoose deprecation warning
mongoose.set('strictQuery', false);

interface UserDoc {
  _id: mongoose.Types.ObjectId;
  email: string;
  role: string;
}

const migrateUsers = async () => {
  try {
    console.log('🚀 Starting UserOrganizationMap migration...\n');

    // 1. Connect to MongoDB
    await connectDB();
    console.log('✅ Connected to MongoDB\n');

    // 2. Fetch all organizations
    const organizations = await Organization.find({}).sort({ name: 1 });
    console.log(`📋 Found ${organizations.length} organization(s)\n`);

    if (organizations.length === 0) {
      console.log('⚠️  No organizations found. Nothing to migrate.');
      await mongoose.connection.close();
      process.exit(0);
    }

    let totalUsersProcessed = 0;
    let totalMapped = 0;
    const errors: string[] = [];

    // 3. For each organization
    for (const org of organizations) {
      console.log(`\n📦 Processing organization: ${org.name} (${org.collectionPrefix})`);
      
      try {
        // Determine the collection name
        const collectionName = `${org.collectionPrefix}_users`;
        
        // Create the user model for this organization
        const UserCollection = createUserModel(collectionName);
        
        // Fetch all users from that collection
        const users = await UserCollection.find({}).select('email role');
        
        console.log(`   Found ${users.length} user(s) in this organization`);
        
        if (users.length === 0) {
          console.log(`   ⏭️  Skipping (no users found)`);
          continue;
        }

        // 4. For each user, upsert into UserOrganizationMap
        for (const user of users) {
          try {
            const userEmail = user.email.toLowerCase();
            
            // Upsert: Add organization to user's organizations array (avoid duplicates)
            const result = await UserOrganizationMap.findOneAndUpdate(
              { email: userEmail },
              {
                $addToSet: {
                  // $addToSet prevents duplicates
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
            totalUsersProcessed++;
            console.log(`   ✅ Mapped user: ${userEmail} -> ${org.name} (${user.role})`);
          } catch (userErr: any) {
            const errorMsg = `   ❌ Error mapping user ${user.email} in ${org.name}: ${userErr.message}`;
            errors.push(errorMsg);
            console.error(errorMsg);
            totalUsersProcessed++;
          }
        }
      } catch (orgErr: any) {
        const errorMsg = `❌ Error processing organization ${org.name}: ${orgErr.message}`;
        errors.push(errorMsg);
        console.error(errorMsg);
      }
    }

    // 5. Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 Migration Summary:');
    console.log('='.repeat(60));
    console.log(`Total organizations processed: ${organizations.length}`);
    console.log(`Total users processed: ${totalUsersProcessed}`);
    console.log(`Successfully mapped: ${totalMapped}`);
    console.log(`Errors: ${errors.length}`);
    
    if (errors.length > 0) {
      console.log('\n⚠️  Errors encountered:');
      errors.forEach((err, index) => {
        console.log(`   ${index + 1}. ${err}`);
      });
    }
    
    console.log('\n✅ Migration completed!\n');

    // 6. Close the connection
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ Migration failed:', error.message);
    console.error(error.stack);
    await mongoose.connection.close();
    process.exit(1);
  }
};

// Run the migration
migrateUsers();

