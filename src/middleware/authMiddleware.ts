import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Extend Express Request to include user and multer file
declare global {
  namespace Express {
    namespace Multer {
      interface File {
        fieldname: string;
        originalname: string;
        encoding: string;
        mimetype: string;
        size: number;
        destination: string;
        filename: string;
        path: string;
        buffer: Buffer;
      }
    }
    interface Request {
      user?: {
        id: string;
        email: string;
        role: string;
        collectionPrefix: string;
        organizationName: string;
      };
      file?: Multer.File;
    }
  }
}

// Protect routes - verify JWT token
export const protect = async (req: Request, res: Response, next: NextFunction) => {
  let token;

  // Check for token in Authorization header
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      // Get token from header
      token = req.headers.authorization.split(' ')[1];

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;

      // Add user info to request
      req.user = decoded.user;

      // PLATFORM_OWNER: Allow overriding collectionPrefix from query params or headers
      // This enables Platform Owner to access any organization's data
      if (req.user && req.user.role === 'PLATFORM_OWNER') {
        // Check for organization prefix in query params or headers
        const overridePrefix = 
          (req.query.organizationPrefix as string) || 
          (req.query.collectionPrefix as string) ||
          (req.headers['x-organization-prefix'] as string) ||
          (req.headers['x-collection-prefix'] as string);
        
        if (overridePrefix) {
          // Override the collectionPrefix for Platform Owner
          req.user.collectionPrefix = overridePrefix;
          // Try to get organization name if possible (optional, won't fail if not found)
          // This is handled in controllers if needed
        }
      }

      next();
    } catch (error) {
      console.error('Token verification failed:', error);
      return res.status(401).json({ msg: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    return res.status(401).json({ msg: 'Not authorized, no token' });
  }
};

// Protect routes for Power BI - accepts API key OR falls back to JWT
export const protectPowerBI = async (req: Request, res: Response, next: NextFunction) => {
  // Check for Power BI API key in header
  const apiKey = req.headers['x-api-key'] as string;
  const powerBISecretKey = process.env.POWERBI_SECRET_KEY;

  if (apiKey && powerBISecretKey && apiKey === powerBISecretKey) {
    // API key matches - create dummy admin user for Power BI
    // Allow organization prefix to be specified via header, or use default from env
    const orgPrefix = (req.headers['x-organization-prefix'] as string) || process.env.POWERBI_DEFAULT_ORG_PREFIX || '';
    
    req.user = {
      id: 'powerbi-service-account',
      email: 'powerbi@system',
      role: 'SuperAdmin',
      collectionPrefix: orgPrefix,
      organizationName: 'Power BI Access',
    };

    return next();
  }

  // API key doesn't match or not provided - fall back to standard JWT authentication
  return protect(req, res, next);
};

// Authorize routes - check if user has required role
export const authorize = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ msg: 'Not authorized, no user' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ msg: 'Not authorized to access this resource' });
    }

    next();
  };
};

