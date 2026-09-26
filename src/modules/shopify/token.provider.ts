import axios from 'axios';
import { config } from '../../config';
import logger from '../../utils/logger';

/**
 * Shopify access-token provider.
 *
 * Two authentication modes, resolved in priority order:
 *
 * 1. Dev Dashboard client credentials (required for apps created after
 *    Jan 1, 2026; legacy admin-created custom apps can no longer be created):
 *    - POST https://{shop}.myshopify.com/admin/oauth/access_token with
 *      client_id, client_secret and grant_type=client_credentials.
 *    - Tokens last 24 hours (expires_in: 86399). There is no refresh token —
 *      refreshing means repeating the same request — so we cache the token in
 *      process memory and request a new one before it expires. This keeps
 *      background jobs and webhooks from ever hitting a 401.
 *
 * 2. Legacy static token: SHOPIFY_ACCESS_TOKEN is returned as-is. Keep this
 *    only if you already hold a token from an admin-created custom app.
 *
 * The client credentials grant only works when the app and the store belong
 * to the same Shopify organization (both under the same org in the Dev
 * Dashboard). Tokens are not visible in the Shopify admin.
 */
class ShopifyTokenProvider {
  private cachedToken: string | null = null;
  private expiresAt: number = 0;

  /**
   * Serialize concurrent token requests. If several background jobs need a
   * token at the same time (first request after boot, or refresh boundary),
   * only one token endpoint call is made and all callers share its result.
   */
  private pendingRequest: Promise<string> | null = null;

  /**
   * Return a valid access token for Shopify Admin API calls.
   */
  async getAccessToken(): Promise<string> {
    const { accessToken, clientId, clientSecret } = config.shopify;

    if (accessToken) {
      return accessToken;
    }

    if (!clientId || !clientSecret) {
      throw new Error(
        'Shopify authentication is not configured. Set both SHOPIFY_CLIENT_ID and ' +
          'SHOPIFY_CLIENT_SECRET (Dev Dashboard app) or SHOPIFY_ACCESS_TOKEN (legacy custom app).'
      );
    }

    const skewMs = config.shopify.tokenRefreshSkew * 1000;
    if (this.cachedToken && this.expiresAt - skewMs > Date.now()) {
      return this.cachedToken;
    }

    if (!this.pendingRequest) {
      this.pendingRequest = this.fetchToken(clientId, clientSecret)
        .then((token) => {
          this.pendingRequest = null;
          return token;
        })
        .catch((error) => {
          this.pendingRequest = null;
          throw error;
        });
    }

    return this.pendingRequest;
  }

  private async fetchToken(clientId: string, clientSecret: string): Promise<string> {
    const tokenUrl = `https://${config.shopify.shopDomain}/admin/oauth/access_token`;

    try {
      const response = await axios.post(
        tokenUrl,
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials',
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15000,
        }
      );

      const data = response.data;
      if (!data.access_token) {
        throw new Error('Token response did not include access_token');
      }

      // Read expires_in from the response like Shopify recommends, rather than
      // hard-coding 24 hours, so the app keeps working if the lifetime changes.
      const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 86399;

      this.cachedToken = data.access_token;
      this.expiresAt = Date.now() + expiresIn * 1000;

      logger.info('Acquired Shopify access token', {
        scope: data.scope || null,
        expiresInSeconds: expiresIn,
      });

      return data.access_token;
    } catch (error: any) {
      logger.error('Failed to acquire Shopify access token', {
        status: error.response?.status || null,
        body: error.response?.data || null,
        error: error.message,
      });
      throw error;
    }
  }
}

export const shopifyTokenProvider = new ShopifyTokenProvider();
