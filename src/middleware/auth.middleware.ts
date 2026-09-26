import { Request, Response, NextFunction } from 'express';
import firebaseService from '../modules/firebase/firebase.service';
import logger from '../utils/logger';

export interface AuthenticatedUser {
  uid: string;
  email?: string;
  name?: string;
  role?: string;
  claims?: Record<string, any>;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Express middleware to strictly enforce Firebase Authentication ID Tokens on protected API endpoints.
 * Requires: Authorization: Bearer <firebaseIdToken>
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Public API endpoints that do not require user authentication:
  // - /health: Required by Docker container healthcheck & Traefik ping
  if (req.path === '/health' || req.path === '/health/') {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized: Authentication required. Please provide a valid Firebase Bearer token.',
      code: 'AUTH_TOKEN_MISSING',
    });
    return;
  }

  const idToken = authHeader.substring(7).trim();
  if (!idToken) {
    res.status(401).json({
      error: 'Unauthorized: Bearer token is empty.',
      code: 'AUTH_TOKEN_EMPTY',
    });
    return;
  }

  try {
    const decodedToken = await firebaseService.verifyIdToken(idToken);
    const email = decodedToken.email || '';
    const isAdminOrDev = Boolean(
      (decodedToken as any).admin ||
      (decodedToken as any).developer ||
      email.toLowerCase() === 'returnorders@vbexports.co.in'
    );

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      name: (decodedToken as any).name || (email ? email.split('@')[0] : 'User'),
      role: isAdminOrDev ? 'ADMIN' : 'OPERATOR',
      claims: decodedToken,
    };

    next();
  } catch (error: any) {
    logger.warn('Firebase token authentication rejected', {
      error: error.message,
      path: req.originalUrl,
      ip: req.ip,
    });

    const isExpired = error.code === 'auth/id-token-expired';
    res.status(401).json({
      error: isExpired
        ? 'Unauthorized: Session expired. Please sign in again.'
        : 'Unauthorized: Invalid authentication credentials.',
      code: isExpired ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_TOKEN_INVALID',
    });
  }
}

export default requireAuth;
