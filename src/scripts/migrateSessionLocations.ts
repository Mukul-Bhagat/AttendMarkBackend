/**
 * Migration Script: Fix Existing Sessions with Missing Coordinates
 * 
 * This script finds all PHYSICAL/HYBRID sessions that have Google Maps links
 * but are missing coordinates, and attempts to extract coordinates from the links.
 * 
 * Run with: ts-node src/scripts/migrateSessionLocations.ts
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import createSessionModel from '../models/Session';
import { extractCoordinatesFromGoogleMapsLink } from '../utils/mapsParser';
import Organization from '../models/Organization';

dotenv.config();

interface MigrationResult {
  totalSessions: number;
  fixedSessions: number;
  failedSessions: number;
  skippedSessions: number;
  errors: Array<{ sessionId: string; error: string }>;
}

async function migrateSessionLocations(): Promise<void> {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      throw new Error('MONGO_URI environment variable is not set');
    }

    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Get all organizations
    const organizations = await Organization.find({});
    console.log(`📊 Found ${organizations.length} organizations`);

    const result: MigrationResult = {
      totalSessions: 0,
      fixedSessions: 0,
      failedSessions: 0,
      skippedSessions: 0,
      errors: [],
    };

    // Process each organization
    for (const org of organizations) {
      const collectionPrefix = org.collectionPrefix;
      console.log(`\n🔍 Processing organization: ${org.name} (${collectionPrefix})`);

      const SessionCollection = createSessionModel(`${collectionPrefix}_sessions`);

      // Find sessions that require location but are missing coordinates
      const sessions = await SessionCollection.find({
        $and: [
          {
            $or: [
              { sessionType: 'PHYSICAL' },
              { sessionType: 'HYBRID' },
            ],
          },
          {
            $or: [
              // LINK type without coordinates
              {
                'location.type': 'LINK',
                $or: [
                  { 'location.geolocation': { $exists: false } },
                  { 'location.geolocation.latitude': { $exists: false } },
                  { 'location.geolocation.longitude': { $exists: false } },
                  { 'location.geolocation.latitude': null },
                  { 'location.geolocation.longitude': null },
                ],
                'location.link': { $exists: true, $ne: '' },
              },
              // Legacy: has location link but no geolocation
              {
                location: { $exists: false },
                geolocation: { $exists: false },
                physicalLocation: { $exists: true, $ne: '' },
              },
            ],
          },
        ],
      });

      console.log(`   Found ${sessions.length} sessions to check`);

      for (const session of sessions) {
        result.totalSessions++;

        try {
          let linkToParse: string | null = null;
          let needsUpdate = false;

          // Check new location structure
          if (session.location && session.location.type === 'LINK' && session.location.link) {
            linkToParse = session.location.link;
            
            // Check if coordinates are missing
            if (!session.location.geolocation ||
                typeof session.location.geolocation.latitude !== 'number' ||
                typeof session.location.geolocation.longitude !== 'number' ||
                isNaN(session.location.geolocation.latitude) ||
                isNaN(session.location.geolocation.longitude)) {
              needsUpdate = true;
            }
          }
          // Check legacy structure
          else if (!session.location && session.physicalLocation) {
            linkToParse = session.physicalLocation;
            needsUpdate = true;
          }

          if (!linkToParse || !needsUpdate) {
            result.skippedSessions++;
            continue;
          }

          // Try to extract coordinates
          const extractedCoords = extractCoordinatesFromGoogleMapsLink(linkToParse);

          if (extractedCoords) {
            // Update session with extracted coordinates
            if (session.location && session.location.type === 'LINK') {
              session.location.geolocation = {
                latitude: extractedCoords.latitude,
                longitude: extractedCoords.longitude,
              };
            } else {
              // Legacy: create location object
              session.location = {
                type: 'LINK',
                link: linkToParse,
                geolocation: {
                  latitude: extractedCoords.latitude,
                  longitude: extractedCoords.longitude,
                },
              };
            }

            await session.save();
            result.fixedSessions++;
            console.log(`   ✅ Fixed session: ${session._id} (${session.name})`);
          } else {
            // Cannot extract coordinates - mark as invalid
            result.failedSessions++;
            result.errors.push({
              sessionId: session._id.toString(),
              error: `Cannot extract coordinates from link: ${linkToParse.substring(0, 50)}...`,
            });
            console.log(`   ❌ Failed to extract coordinates for session: ${session._id} (${session.name})`);
            console.log(`      Link: ${linkToParse}`);
          }
        } catch (error: any) {
          result.failedSessions++;
          result.errors.push({
            sessionId: session._id.toString(),
            error: error.message || 'Unknown error',
          });
          console.log(`   ❌ Error processing session ${session._id}: ${error.message}`);
        }
      }
    }

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 MIGRATION SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total sessions checked: ${result.totalSessions}`);
    console.log(`✅ Fixed sessions: ${result.fixedSessions}`);
    console.log(`❌ Failed sessions: ${result.failedSessions}`);
    console.log(`⏭️  Skipped sessions: ${result.skippedSessions}`);

    if (result.errors.length > 0) {
      console.log('\n❌ ERRORS:');
      result.errors.forEach((err, index) => {
        console.log(`   ${index + 1}. Session ${err.sessionId}: ${err.error}`);
      });
    }

    console.log('\n✅ Migration completed');

    // Close connection
    await mongoose.connection.close();
    console.log('✅ Database connection closed');
  } catch (error: any) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run migration
if (require.main === module) {
  migrateSessionLocations()
    .then(() => {
      console.log('✅ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Script failed:', error);
      process.exit(1);
    });
}

export default migrateSessionLocations;

