import type { Env, AuthResult } from '../types';

export class AuthService {
  constructor(private env: Env) {}

  /**
   * Validates API key against D1 allow-list
   */
  async validateApiKey(request: Request): Promise<AuthResult> {
    try {
      const apiKey = this.extractApiKey(request);

      if (!apiKey) {
        return { success: false, error: 'Missing API key' };
      }

      // Query D1 for the API key
      const result = await this.env.USAGE_DB
        .prepare('SELECT id, key FROM cloud_api_keys WHERE key = ? LIMIT 1')
        .bind(apiKey)
        .first<{ id: string; key: string }>();

      if (!result) {
        return { success: false, error: 'Invalid API key' };
      }

      return { success: true, keyId: result.id, apiKey: apiKey };
    } catch (error) {
      console.error('Auth validation error:', error);
      return { success: false, error: 'Authentication failed' };
    }
  }

  /**
   * Extracts API key from Authorization header or X-Eliza-Cloud-Key header
   */
  private extractApiKey(request: Request): string | null {
    // Try Authorization: Bearer <key>
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    // Try X-Eliza-Cloud-Key header
    const keyHeader = request.headers.get('X-Eliza-Cloud-Key');
    if (keyHeader) {
      return keyHeader;
    }

    return null;
  }
}