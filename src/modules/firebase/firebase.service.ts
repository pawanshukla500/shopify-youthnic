import fs from 'fs';
import axios from 'axios';
import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { getAuth } from 'firebase-admin/auth';
import { config } from '../../config';
import logger from '../../utils/logger';

const RTDB_BASE_URL = config.firebase.rtdbUrl || 'https://shopify-134b9-default-rtdb.firebaseio.com';

// Initialize Firebase Admin SDK singleton with service account credentials
let firebaseAdminApp: App | null = null;
try {
  if (getApps().length === 0) {
    let serviceAccount: any = null;
    if (config.firebase.serviceAccountPath && fs.existsSync(config.firebase.serviceAccountPath)) {
      serviceAccount = JSON.parse(fs.readFileSync(config.firebase.serviceAccountPath, 'utf8'));
    } else if (config.firebase.serviceAccountJson) {
      serviceAccount = JSON.parse(config.firebase.serviceAccountJson);
    }

    if (serviceAccount) {
      firebaseAdminApp = initializeApp({
        credential: cert(serviceAccount),
        storageBucket: config.firebase.storageBucket || 'shopify-134b9.firebasestorage.app',
        databaseURL: RTDB_BASE_URL,
      });
      logger.info('Firebase Admin SDK initialized successfully', {
        projectId: serviceAccount.project_id,
        storageBucket: config.firebase.storageBucket,
      });
    }
  } else {
    firebaseAdminApp = getApps()[0];
  }
} catch (err: any) {
  logger.warn('Failed to initialize Firebase Admin SDK', { error: err.message });
}

export interface CustomerHistoryEvent {
  id?: string;
  type: 'INBOUND_EMAIL' | 'OUTBOUND_EMAIL' | 'WHATSAPP' | 'DELHIVERY_TRACKING' | 'ORDER_EVENT';
  channel: 'EMAIL' | 'WHATSAPP' | 'SYSTEM' | 'DELHIVERY';
  title: string;
  description: string;
  timestamp: string;
  sender?: string;
  recipient?: string;
  orderId?: number;
  shopifyOrderName?: string;
  waybillNumber?: string;
  urgency?: string;
  status?: string;
  metadata?: any;
}

export class FirebaseService {
  private baseUrl: string;

  constructor(baseUrl = RTDB_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Helper to sanitize phone or email for Firebase keys (cannot contain '.', '#', '$', '[', or ']')
   */
  public sanitizeKey(input: string): string {
    return (input || 'unknown').replace(/[.#$\[\]]/g, '_').toLowerCase().trim();
  }

  /**
   * Ping Firebase Realtime Database to check connectivity and measure latency
   */
  async ping(): Promise<{ status: 'ok' | 'error'; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await axios.get(`${this.baseUrl}/health_check.json`, { timeout: 5000 });
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (err: any) {
      logger.error('Firebase RTDB ping failed', { error: err.message });
      return { status: 'error', latencyMs: Date.now() - start, error: err.message };
    }
  }

  /**
   * Sync an inbound customer support email/ticket to Firebase RTDB
   */
  async syncInboundEmail(ticket: {
    id: number;
    orderId?: number | null;
    shopifyOrderName?: string | null;
    fromEmail: string;
    fromName?: string | null;
    toEmail: string;
    subject: string;
    bodyText?: string | null;
    category: string;
    urgency: string;
    sentiment: string;
    flagReason?: string | null;
    suggestedReply?: string | null;
    status: string;
    createdAt: Date | string;
  }): Promise<boolean> {
    try {
      const payload = {
        ...ticket,
        updatedAt: new Date().toISOString(),
      };

      // 1. Write to /inbound_emails/:id
      await axios.put(`${this.baseUrl}/inbound_emails/${ticket.id}.json`, payload, { timeout: 6000 });

      // 2. If linked to an order, also update /orders_support/:orderId
      if (ticket.orderId) {
        await axios.patch(
          `${this.baseUrl}/orders_support/${ticket.orderId}.json`,
          {
            hasUrgentSupport: ticket.urgency === 'URGENT' || ticket.urgency === 'HIGH',
            latestTicketId: ticket.id,
            category: ticket.category,
            urgency: ticket.urgency,
            updatedAt: new Date().toISOString(),
          },
          { timeout: 6000 }
        );
      }

      logger.info('Synced inbound email to Firebase RTDB', { ticketId: ticket.id });
      return true;
    } catch (err: any) {
      logger.error('Failed to sync inbound email to Firebase RTDB', { error: err.message, ticketId: ticket.id });
      return false;
    }
  }

  /**
   * Sync an event into the unified Customer History timeline
   */
  async syncCustomerHistory(customerIdentifier: string, event: CustomerHistoryEvent): Promise<boolean> {
    try {
      const key = this.sanitizeKey(customerIdentifier);
      const eventWithTs = {
        ...event,
        timestamp: event.timestamp || new Date().toISOString(),
      };

      // Push to /customer_history/:key/events
      await axios.post(`${this.baseUrl}/customer_history/${key}/events.json`, eventWithTs, { timeout: 6000 });

      // Update summary node
      await axios.patch(
        `${this.baseUrl}/customer_history/${key}/summary.json`,
        {
          lastActivityAt: eventWithTs.timestamp,
          lastActivityType: event.type,
          lastChannel: event.channel,
          lastSubject: event.title,
        },
        { timeout: 6000 }
      );

      return true;
    } catch (err: any) {
      logger.error('Failed to sync customer history to Firebase RTDB', { error: err.message, customerIdentifier });
      return false;
    }
  }

  /**
   * Fetch customer history events from Firebase RTDB
   */
  async getCustomerHistory(customerIdentifier: string): Promise<CustomerHistoryEvent[]> {
    try {
      const key = this.sanitizeKey(customerIdentifier);
      const res = await axios.get(`${this.baseUrl}/customer_history/${key}/events.json`, { timeout: 6000 });
      if (!res.data) return [];

      const events: CustomerHistoryEvent[] = Object.entries(res.data).map(([id, val]: [string, any]) => ({
        id,
        ...val,
      }));

      // Sort descending by timestamp
      events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      return events;
    } catch (err: any) {
      logger.error('Failed to get customer history from Firebase RTDB', { error: err.message, customerIdentifier });
      return [];
    }
  }

  /**
   * Sync a self-learned knowledge pattern to Firebase RTDB
   */
  async syncKnowledgePattern(pattern: {
    patternKey: string;
    intent: string;
    keywords: string;
    recommendedUrgency: string;
    suggestedAction: string;
    autoReplyTemplate: string;
    confidence: number;
    usageCount: number;
    isLearned: boolean;
  }): Promise<boolean> {
    try {
      const sanitizedKey = this.sanitizeKey(pattern.patternKey);
      await axios.put(`${this.baseUrl}/knowledge_base/patterns/${sanitizedKey}.json`, pattern, { timeout: 6000 });
      return true;
    } catch (err: any) {
      logger.error('Failed to sync knowledge pattern to Firebase RTDB', { error: err.message, patternKey: pattern.patternKey });
      return false;
    }
  }

  /**
   * Fetch all knowledge patterns from Firebase RTDB
   */
  async getKnowledgePatterns(): Promise<any[]> {
    try {
      const res = await axios.get(`${this.baseUrl}/knowledge_base/patterns.json`, { timeout: 6000 });
      if (!res.data) return [];
      return Object.values(res.data);
    } catch (err: any) {
      logger.error('Failed to get knowledge patterns from Firebase RTDB', { error: err.message });
      return [];
    }
  }

  /**
   * Update real-time system diagnostics in Firebase RTDB
   */
  async updateSystemDiagnostics(diagnostics: any): Promise<boolean> {
    try {
      await axios.put(
        `${this.baseUrl}/system_diagnostics.json`,
        {
          ...diagnostics,
          updatedAt: new Date().toISOString(),
        },
        { timeout: 6000 }
      );
      return true;
    } catch (err: any) {
      logger.warn('Failed to update system diagnostics in Firebase RTDB', { error: err.message });
      return false;
    }
  }

  /**
   * Access the default Firebase Cloud Storage Bucket
   */
  public getStorageBucket() {
    if (!firebaseAdminApp) {
      throw new Error('Firebase Admin SDK is not initialized. Check service account configuration.');
    }
    return getStorage(firebaseAdminApp).bucket();
  }

  /**
   * Upload binary buffer (e.g. shipping label, proof of return, ticket attachment) to Firebase Storage
   */
  public async uploadBuffer(
    destinationPath: string,
    buffer: Buffer,
    contentType = 'application/octet-stream',
    isPublic = true
  ): Promise<{ url: string; path: string; bucket: string }> {
    const bucket = this.getStorageBucket();
    const file = bucket.file(destinationPath);
    await file.save(buffer, {
      metadata: { contentType },
      public: isPublic,
      resumable: false,
    });
    const url = `https://storage.googleapis.com/${bucket.name}/${destinationPath}`;
    logger.info('Uploaded file to Firebase Cloud Storage', { destinationPath, bucket: bucket.name, url });
    return { url, path: destinationPath, bucket: bucket.name };
  }

  /**
   * Upload an order-scoped artifact to Firebase Storage.
   * Files are organized per-order so access can be granted per-order later.
   *
   * Path convention:
   *   orders/{orderId}/{type}-{epochMs}.{ext}
   *
   * Example: orders/12345/epod-1719430000000.jpg
   *
   * Public by default — order artifacts (labels, POD, QC) are operator-facing and
   * never contain customer payment data. Tighten with `isPublic=false` if you ever
   * store receipts or proofs of identity.
   */
  public async uploadOrderArtifact(
    orderId: number | string,
    type: 'label' | 'epod' | 'signature' | 'qc' | 'sorter' | 'invoice' | 'misc',
    buffer: Buffer,
    contentType: string,
    extension: string,
    isPublic = true
  ): Promise<{ url: string; path: string; bucket: string }> {
    const safeOrderId = String(orderId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeType = type.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeExt = extension.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin';
    const destinationPath = `orders/${safeOrderId}/${safeType}-${Date.now()}.${safeExt}`;
    return this.uploadBuffer(destinationPath, buffer, contentType, isPublic);
  }

  /**
   * Probe Firebase Cloud Storage bucket health and connectivity
   */
  public async checkStorageHealth(): Promise<{
    status: 'ok' | 'error';
    bucket: string;
    exists: boolean;
    latencyMs: number;
    error?: string;
  }> {
    const start = Date.now();
    try {
      const bucket = this.getStorageBucket();
      const [exists] = await bucket.exists();
      return {
        status: exists ? 'ok' : 'error',
        bucket: bucket.name,
        exists,
        latencyMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        status: 'error',
        bucket: config.firebase.storageBucket,
        exists: false,
        latencyMs: Date.now() - start,
        error: err.message,
      };
    }
  }

  /**
   * Verify Firebase Auth ID token server-side
   */
  public async verifyIdToken(idToken: string) {
    if (!firebaseAdminApp) {
      throw new Error('Firebase Admin SDK not initialized.');
    }
    return getAuth(firebaseAdminApp).verifyIdToken(idToken);
  }

  public isAdminReady(): boolean {
    return Boolean(firebaseAdminApp);
  }

  /**
   * Admin: create a Firebase Auth user with a chosen password (for Settings → Create Operator).
   * Sets displayName + role custom claims (admin=true for Admin roles).
   */
  public async createUserWithPassword(input: {
    email: string;
    password: string;
    displayName?: string;
    role?: string;
  }): Promise<{ uid: string; email: string }> {
    if (!firebaseAdminApp) throw new Error('Firebase Admin SDK not initialized — cannot create login user.');
    if (!input.password || input.password.length < 6) {
      throw new Error('Password must be at least 6 characters.');
    }
    const isAdmin = /admin/i.test(input.role || '');
    const user = await getAuth(firebaseAdminApp).createUser({
      email: input.email.toLowerCase().trim(),
      password: input.password,
      displayName: input.displayName?.trim() || undefined,
      emailVerified: false,
      disabled: false,
    });
    await getAuth(firebaseAdminApp).setCustomUserClaims(user.uid, {
      admin: isAdmin,
      role: input.role || 'OPERATOR',
    });
    logger.info('Firebase user created by admin', { uid: user.uid, email: user.email, isAdmin });
    return { uid: user.uid, email: user.email || input.email };
  }

  /**
   * Admin: set a new password / displayName / disabled flag / role claims for an existing user.
   * Lookup by email when uid is unknown (roster rows predate Firebase linkage).
   */
  public async updateUserByEmail(
    email: string,
    patch: { newPassword?: string; displayName?: string; disabled?: boolean; role?: string }
  ): Promise<{ uid: string }> {
    if (!firebaseAdminApp) throw new Error('Firebase Admin SDK not initialized — cannot update login user.');
    const auth = getAuth(firebaseAdminApp);
    const existing = await auth.getUserByEmail(email.toLowerCase().trim());
    const update: any = {};
    if (patch.newPassword) {
      if (patch.newPassword.length < 6) throw new Error('Password must be at least 6 characters.');
      update.password = patch.newPassword;
    }
    if (patch.displayName !== undefined) update.displayName = patch.displayName;
    if (patch.disabled !== undefined) update.disabled = patch.disabled;
    if (Object.keys(update).length) await auth.updateUser(existing.uid, update);
    if (patch.role !== undefined) {
      await auth.setCustomUserClaims(existing.uid, {
        admin: /admin/i.test(patch.role),
        role: patch.role,
      });
    }
    // Revoke sessions when password/disabled changes so old tokens stop working.
    if (patch.newPassword || patch.disabled !== undefined) {
      await auth.revokeRefreshTokens(existing.uid).catch(() => {});
    }
    logger.info('Firebase user updated by admin', { uid: existing.uid, email });
    return { uid: existing.uid };
  }

  /**
   * Admin: generate a password-reset link (for “send reset email” without knowing the password).
   */
  public async generatePasswordResetLink(email: string): Promise<string> {
    if (!firebaseAdminApp) throw new Error('Firebase Admin SDK not initialized.');
    return getAuth(firebaseAdminApp).generatePasswordResetLink(email.toLowerCase().trim());
  }

  /**
   * Admin: disable (or delete) a Firebase user when the roster row is suspended/removed.
   */
  public async disableUserByEmail(email: string, disabled = true): Promise<void> {
    if (!firebaseAdminApp) return;
    try {
      const auth = getAuth(firebaseAdminApp);
      const existing = await auth.getUserByEmail(email.toLowerCase().trim());
      await auth.updateUser(existing.uid, { disabled });
      if (disabled) await auth.revokeRefreshTokens(existing.uid).catch(() => {});
    } catch (e: any) {
      // Roster-only users (never had Firebase login) — nothing to disable.
      if (e?.code !== 'auth/user-not-found') throw e;
    }
  }

  public async deleteUserByEmail(email: string): Promise<void> {
    if (!firebaseAdminApp) return;
    try {
      const auth = getAuth(firebaseAdminApp);
      const existing = await auth.getUserByEmail(email.toLowerCase().trim());
      await auth.deleteUser(existing.uid);
    } catch (e: any) {
      if (e?.code !== 'auth/user-not-found') throw e;
    }
  }
}

export const firebaseService = new FirebaseService();
export default firebaseService;

