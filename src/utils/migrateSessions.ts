/**
 * Migration Script: Group existing sessions into ClassBatches
 * 
 * This script can be run manually or via an admin endpoint to:
 * 1. Create a "Legacy Class" for each organization
 * 2. Optionally link existing sessions to this Legacy Class
 * 
 * Usage:
 * - Run this script once per organization to migrate existing data
 * - Existing sessions without classBatchId will remain standalone (backward compatible)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import createClassBatchModel from '../models/ClassBatch';
import createSessionModel from '../models/Session';
import Organization from '../models/Organization';

dotenv.config();

interface MigrationOptions {
  organizationPrefix?: string; // If provided, only migrate this organization
  createLegacyClass?: boolean; // Create a "Legacy Class" for orphaned sessions
  linkSessions?: boolean; // Link existing sessions to Legacy Class
}

/**
 * Migrate sessions for a specific organization
 */
const migrateOrganization = async (
  organizationPrefix: string,
  options: MigrationOptions = {}
): Promise<{ success: boolean; message: string; stats?: any }> => {
  try {
    const ClassBatchCollection = createClassBatchModel(`${organizationPrefix}_classbatches`);
    const SessionCollection = createSessionModel(`${organizationPrefix}_sessions`);

    // Count existing sessions without classBatchId
    const orphanedSessions = await SessionCollection.countDocuments({
      $or: [
        { classBatchId: { $exists: false } },
        { classBatchId: null },
      ],
    });

    if (orphanedSessions === 0) {
      return {
        success: true,
        message: `No orphaned sessions found for ${organizationPrefix}. Migration not needed.`,
      };
    }

    let legacyClassId: string | null = null;

    // Create Legacy Class if requested
    if (options.createLegacyClass) {
      // Check if Legacy Class already exists
      const existingLegacy = await ClassBatchCollection.findOne({
        name: 'Legacy Class',
      });

      if (existingLegacy) {
        legacyClassId = existingLegacy._id.toString();
        console.log(`Using existing Legacy Class for ${organizationPrefix}`);
      } else {
        // Create new Legacy Class
        // Note: We need a createdBy user ID. For migration, we'll use a placeholder.
        // In production, you might want to use the first SuperAdmin's ID.
        const legacyClass = new ClassBatchCollection({
          name: 'Legacy Class',
          description: 'Auto-created during migration. Contains sessions created before ClassBatch system was implemented.',
          createdBy: 'migration-script', // Placeholder - update if needed
          organizationPrefix,
        });
        await legacyClass.save();
        legacyClassId = legacyClass._id.toString();
        console.log(`Created Legacy Class for ${organizationPrefix}`);
      }
    }

    // Link sessions to Legacy Class if requested
    let linkedCount = 0;
    if (options.linkSessions && legacyClassId) {
      const result = await SessionCollection.updateMany(
        {
          $or: [
            { classBatchId: { $exists: false } },
            { classBatchId: null },
          ],
        },
        {
          $set: { classBatchId: legacyClassId },
        }
      );
      linkedCount = result.modifiedCount;
      console.log(`Linked ${linkedCount} sessions to Legacy Class for ${organizationPrefix}`);
    }

    return {
      success: true,
      message: `Migration completed for ${organizationPrefix}`,
      stats: {
        orphanedSessions,
        legacyClassCreated: options.createLegacyClass ? (legacyClassId ? true : false) : false,
        legacyClassId,
        sessionsLinked: linkedCount,
      },
    };
  } catch (error: any) {
    console.error(`Migration error for ${organizationPrefix}:`, error.message);
    return {
      success: false,
      message: `Migration failed for ${organizationPrefix}: ${error.message}`,
    };
  }
};

/**
 * Migrate all organizations
 */
const migrateAllOrganizations = async (options: MigrationOptions = {}) => {
  try {
    // Connect to database
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/attendmark';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Get all organizations
    const organizations = await Organization.find();
    console.log(`Found ${organizations.length} organizations to migrate`);

    const results = [];
    for (const org of organizations) {
      const result = await migrateOrganization(org.collectionPrefix, options);
      results.push({
        organization: org.name,
        prefix: org.collectionPrefix,
        ...result,
      });
    }

    console.log('\n=== Migration Summary ===');
    results.forEach((result) => {
      console.log(`${result.organization} (${result.prefix}): ${result.message}`);
      if (result.stats) {
        console.log(`  - Orphaned Sessions: ${result.stats.orphanedSessions}`);
        console.log(`  - Sessions Linked: ${result.stats.sessionsLinked}`);
      }
    });

    await mongoose.disconnect();
    console.log('\nMigration completed. Disconnected from MongoDB.');

    return results;
  } catch (error: any) {
    console.error('Migration error:', error.message);
    await mongoose.disconnect();
    throw error;
  }
};

/**
 * Run migration if this script is executed directly
 */
if (require.main === module) {
  const args = process.argv.slice(2);
  const options: MigrationOptions = {
    createLegacyClass: args.includes('--create-legacy'),
    linkSessions: args.includes('--link-sessions'),
  };

  const orgPrefix = args.find(arg => arg.startsWith('--org='))?.split('=')[1];
  if (orgPrefix) {
    options.organizationPrefix = orgPrefix;
  }

  if (options.organizationPrefix) {
    // Migrate single organization
    mongoose
      .connect(process.env.MONGO_URI || 'mongodb://localhost:27017/attendmark')
      .then(() => {
        console.log('Connected to MongoDB');
        return migrateOrganization(options.organizationPrefix!, options);
      })
      .then((result) => {
        console.log(result.message);
        if (result.stats) {
          console.log('Stats:', result.stats);
        }
        process.exit(result.success ? 0 : 1);
      })
      .catch((error) => {
        console.error('Migration failed:', error);
        process.exit(1);
      });
  } else {
    // Migrate all organizations
    migrateAllOrganizations(options)
      .then(() => {
        process.exit(0);
      })
      .catch((error) => {
        console.error('Migration failed:', error);
        process.exit(1);
      });
  }
}

export { migrateOrganization, migrateAllOrganizations };

