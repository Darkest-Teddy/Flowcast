import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function safeReturnRoute(value: unknown): string {
  // Keep only known app paths; queries/fragments could contain credentials or redirect instructions.
  return typeof value === 'string' && /^\/(?:ask|schedule|study|forecasts|events|event-impact|clubs(?:\/register)?|profile|calendars|privacy|settings|welcome|club(?:\/calendar)?|admin(?:\/(?:data-sources|simulation|live|clubs|users|agent-brain|settings))?)?$/.test(value) ? value : '/';
}

export function savedReturnRoute(): string {
  try { return safeReturnRoute(window.sessionStorage.getItem('flowcast.auth.return')); }
  catch { return '/'; }
}

export function createAuthClient(fetcher: typeof fetch = (...args) => fetch(...args), factory = createClient) {
  let pending: Promise<SupabaseClient> | undefined;
  let callback: Promise<string> | undefined;
  function getClient(): Promise<SupabaseClient> {
    if (!pending) pending = (async () => {
      const response = await fetcher('/api/dashboard/auth/config', { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error();
      const { url, publishableKey } = await response.json();
      if (typeof url !== 'string' || !/^https?:\/\//.test(url) || typeof publishableKey !== 'string' || !publishableKey.trim()) throw new Error();
      return factory(url, publishableKey, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    })().catch(() => {
      pending = undefined;
      throw new Error('Google sign-in is unavailable. Flowcast could not load its authentication configuration. Please try again later or contact the site administrator.');
    });
    return pending;
  }
  return {
    getClient,
    async headers(): Promise<Record<string, string>> {
      const { data, error } = await (await getClient()).auth.getSession();
      if (error) throw error;
      if (!data.session) throw new Error('Please sign in with Google to continue.');
      return { Authorization: `Bearer ${data.session.access_token}` };
    },
    async signIn(from: unknown, origin: string) {
      callback = undefined;
      const redirectTo = new URL('/auth/callback', origin);
      window.sessionStorage.setItem('flowcast.auth.return', safeReturnRoute(from));
      const { error } = await (await getClient()).auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo.href } });
      if (error) throw error;
    },
    completeCallback(href: string, clean: () => void): Promise<string> {
      if (callback) return callback;
      const url = new URL(href);
      const code = url.searchParams.get('code');
      const failed = url.searchParams.has('error') || url.searchParams.has('error_description') || new URLSearchParams(url.hash.slice(1)).has('error');
      const next = savedReturnRoute();
      // Remove credentials before any network work and retain the promise across StrictMode remounts.
      clean();
      callback = (async () => {
        if (failed) throw new Error('Google sign-in was cancelled or denied. Please try again.');
        if (!code) throw new Error('This sign-in link is missing its authorization code. Please sign in again.');
        const { error } = await (await getClient()).auth.exchangeCodeForSession(code);
        if (error) throw new Error('This sign-in link could not be verified. Please sign in again in the browser where you started.');
        try { window.sessionStorage.removeItem('flowcast.auth.return'); } catch { /* Storage may be blocked. */ }
        return next;
      })();
      return callback;
    },
    async signOut() {
      const { error } = await (await getClient()).auth.signOut({ scope: 'local' });
      if (error) throw new Error('Sign-out could not finish. Please check your connection and try again.');
    },
  };
}

export const auth = createAuthClient();
