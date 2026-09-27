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
  // - /webhooks/whatsapp: Inbound provider webhook (Kapso / Meta Cloud API).
  //   Must stay public — external couriers cannot present a Firebase user token.
  //   Verification (hub.challenge) and payload handling live in routes/api.ts.
  if (
    req.path === '/health' ||
    req.path === '/health/' ||
    req.path === '/webhooks/whatsapp' ||
    req.path.startsWith('/webhooks/whatsapp/')
  ) {
    return next();
  }

  const authHeader = req.headers.authorization;
  let idToken = '';

  if (authHeader && authHeader.startsWith('Bearer ')) {
    idToken = authHeader.substring(7).trim();
  } else if (typeof req.query.token === 'string' && req.query.token.trim()) {
    idToken = req.query.token.trim();
  } else if (typeof req.query.auth === 'string' && req.query.auth.trim()) {
    idToken = req.query.auth.trim();
  }

  if (!idToken) {
    res.status(401).json({
      error: 'Unauthorized: Authentication required. Please provide a valid Firebase Bearer token.',
      code: 'AUTH_TOKEN_MISSING',
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
