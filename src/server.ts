import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import fs from 'fs';

// Load env vars FIRST - before any other imports that might need them
// Force load .env from the backend root folder (one level up from src/)
const envPath = path.join(__dirname, '../.env');
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.warn(`⚠️  Could not load .env from ${envPath}`);
  console.warn('   Trying default dotenv.config()...');
  dotenv.config(); // Fallback to default behavior
} else {
  console.log(`✅ Loaded .env from: ${envPath}`);
}

// Now import modules that depend on env vars
import connectDB from './config/db';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/userRoutes';
import sessionRoutes from './routes/sessionRoutes';
import attendanceRoutes from './routes/attendanceRoutes';
import classBatchRoutes from './routes/classBatchRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import reportRoutes from './routes/reportRoutes';
import organizationRoutes from './routes/organizationRoutes';
import leaveRoutes from './routes/leaveRoutes';
import platformRoutes from './routes/platformRoutes';
import backupRoutes from './routes/backupRoutes';
import { startAttendanceScheduler } from './cron/attendanceScheduler';

// Connect to database
connectDB();

const app = express();

// Middleware
// CORS configuration - explicitly allow frontend origin
// This ensures the frontend at attendmark.onrender.com can access the backend
const allowedOrigins = [
  'https://attendmark.onrender.com',
  'http://localhost:5173',
  'http://localhost:3000'
];

const corsOptions = {
  origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    // In development, allow all localhost origins
    if (process.env.NODE_ENV !== 'production' && origin.includes('localhost')) {
      return callback(null, true);
    }
    
    // For production, only allow specific origins
    if (process.env.NODE_ENV === 'production') {
      console.log(`CORS blocked origin: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    }
    
    // In development, allow all origins
    return callback(null, true);
  },
  credentials: true, // Allow cookies/auth headers
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  exposedHeaders: ['Authorization'],
  preflightContinue: false,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Handle FormData text fields
// Serve static files from public/uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Determine client build path (works for both local dev and Render deployment)
// Try multiple possible paths based on different deployment scenarios
const possibleClientPaths = [
  path.join(__dirname, '../../client/dist'), // Local dev: backend/dist/src -> backend -> client/dist
  path.join(__dirname, '../../../client/dist'), // Render: backend/dist/src -> backend -> root -> client/dist
  path.join(process.cwd(), 'client/dist'), // Render: from project root
  path.join(process.cwd(), '../client/dist'), // Render: from backend folder
  path.join(process.cwd(), '../../client/dist'), // Render: alternative structure
  '/opt/render/project/src/client/dist', // Render absolute path (if client is in same repo)
  path.join(process.cwd(), 'dist'), // If client is built in backend folder
];

let clientDistPath: string | null = null;
for (const clientPath of possibleClientPaths) {
  try {
    const indexPath = path.join(clientPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      clientDistPath = clientPath;
      console.log(`✓ Found client build at: ${clientDistPath}`);
      break;
    }
  } catch (error) {
    // Skip invalid paths
    continue;
  }
}

if (!clientDistPath) {
  console.log('⚠ Client build not found. Frontend will not be served by this backend.');
  console.log('  This is normal if frontend is deployed as a separate service.');
}

// Serve static files from client/dist if it exists
if (clientDistPath) {
  app.use(express.static(clientDistPath));
}

// Define Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/classes', classBatchRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/organization', organizationRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/platform', platformRoutes);
app.use('/api/backup', backupRoutes);

// Catch-all route: serve React app for all non-API routes
// This must be AFTER all API routes to allow API calls to work
app.get('*', (req, res) => {
  // Only serve index.html for non-API routes
  if (!req.path.startsWith('/api')) {
    if (clientDistPath) {
      const indexPath = path.join(clientDistPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).json({ message: 'Frontend build not found' });
      }
    } else {
      // If client build is not available, return a helpful message
      res.status(503).json({ 
        message: 'Frontend not available. This is an API-only deployment.',
        note: 'If you expected the frontend, ensure the client/dist folder exists and is accessible.'
      });
    }
  } else {
    res.status(404).json({ message: 'API route not found' });
  }
});

const PORT = process.env.PORT || 5001;

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  
  // Start the attendance scheduler cron job
  // Wait a bit for DB connection to be fully established
  setTimeout(() => {
    startAttendanceScheduler();
  }, 2000);
});

