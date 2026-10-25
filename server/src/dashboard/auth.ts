import { z } from 'zod';

export class DashboardAuthError extends Error {
  constructor(public readonly status: 401 | 503) {
    super(status === 401 ? 'A valid bearer token is required.' : 'Dashboard authentication is unavailable.');
  }
}
export interface AuthConfig { url: string; publishableKey: string }
export interface VerifiedUser { id: string; email: string; name: string }
export type VerifyUser = (token: string) => Promise<VerifiedUser>;

/**
 * Local development only: with FLOWCAST_DEV_AUTH_BYPASS=1 (ignored in production and on Railway),
 * the bearer token `local-dev` signs in as a fixed demo account, so the dashboard opens without
 * Google. The web app sends it when VITE_DEV_AUTH_BYPASS=1 in dev mode (web/src/auth/client.ts).
 */
export const DEV_BYPASS_TOKEN = 'local-dev';
export const DEV_BYPASS_USER: VerifiedUser = { id: '00000000-0000-4000-8000-000000000001', email: '', name: 'Local demo' };
export function devAuthBypass(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FLOWCAST_DEV_AUTH_BYPASS === '1' && env.NODE_ENV !== 'production' && !env.RAILWAY_ENVIRONMENT;
}

export function authConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  try {
    const url = new URL(env.SUPABASE_URL ?? '');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error();
    // Decode only the configured legacy API key to prevent publishing a service-role key.
    // User tokens are never decoded locally or used as identity claims.
    const legacy = key?.split('.');
    const anon = legacy?.length === 3 && JSON.parse(Buffer.from(legacy[1], 'base64url').toString()).role === 'anon';
    if (!key || !(/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) || anon)) throw new Error();
    return { url: url.origin, publishableKey: key };
  } catch { throw new DashboardAuthError(503); }
}

const userSchema = z.object({
  id: z.string().uuid(), email: z.string().optional(),
  user_metadata: z.record(z.string(), z.unknown()).optional(),
});
export function createUserVerifier(config: () => AuthConfig = authConfig, request: typeof fetch = fetch): VerifyUser {
  return async (token) => {
    const { url, publishableKey } = config();
    try {
      const response = await request(`${url}/auth/v1/user`, {
        method: 'GET', headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (response.status === 401 || response.status === 403) throw new DashboardAuthError(401);
      if (!response.ok) throw new DashboardAuthError(503);
      const parsed = userSchema.safeParse(await response.json());
      if (!parsed.success) throw new DashboardAuthError(503);
      const user = parsed.data;
      const name = user.user_metadata?.full_name ?? user.user_metadata?.name;
      return { id: user.id, email: user.email ?? '', name: typeof name === 'string' ? name.trim().slice(0, 100) : '' };
    } catch (error) {
      if (error instanceof DashboardAuthError) throw error;
      throw new DashboardAuthError(503);
    }
  };
}
