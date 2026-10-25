import { createContext, Fragment, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { api, resetAccountData } from '../data/api';
import { CROWD_STORAGE_KEY } from '../lib/crowdReports';
import { auth, DEV_AUTH_BYPASS } from './client';
import { AccountError } from './AccountError';
import type { Role, Session } from '../data/types';

interface SessionState {
  session: Session | null;
  ready: boolean;
  error: string | null;
  /** Signed in with Google, but the Flowcast profile didn't load: show AccountError, not the landing page. */
  profileFailed: boolean;
  signIn: (from?: string) => Promise<void>;
  refreshSession: () => Promise<void>;
  signOut: () => Promise<void>;
  hasRole: (role: Role) => boolean;
}
const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profileFailed, setProfileFailed] = useState(false);
  const [identity, setIdentity] = useState<string | null>(null);
  const userId = useRef<string | null>(null);
  const revision = useRef(0);

  function clearAccount(id: string | null) {
    revision.current++;
    userId.current = id;
    resetAccountData();
    setSession(null);
    setProfileFailed(false);
    setIdentity(id);
  }

  async function refreshSession() {
    const version = ++revision.current;
    let signedIn = false; // past Google: a failure from here on is the profile's, not the sign-in's
    try {
      if (!DEV_AUTH_BYPASS) {
        const { data, error: sdkError } = await (await auth.getClient()).auth.getSession();
        if (sdkError) throw sdkError;
        if (version !== revision.current) return;
        if (!data.session) { clearAccount(null); setReady(true); return; }
      }
      signedIn = true;
      const profile = await api.getSession();
      if (version === revision.current) { setSession(profile); setError(null); setProfileFailed(false); setReady(true); }
    } catch (e) {
      if (version === revision.current) {
        setSession(null);
        setError(e instanceof Error ? e.message : 'Your Flowcast profile could not be loaded.');
        setProfileFailed(signedIn);
        setReady(true);
      }
    }
  }

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Local demo (client.ts DEV_AUTH_BYPASS): no Google session to watch; the server knows the account.
    if (DEV_AUTH_BYPASS) { void refreshSession(); return () => { active = false; revision.current++; }; }
    auth.getClient().then((client) => {
      if (!active) return;
      const { data } = client.auth.onAuthStateChange((_event, sdkSession) => {
        if (!active) return;
        const id = sdkSession?.user.id ?? null;
        if (id !== userId.current || !sdkSession) {
          clearAccount(id);
          setReady(!sdkSession);
        }
        clearTimeout(timer);
        // Do not call SDK methods while onAuthStateChange holds its session lock.
        if (sdkSession) timer = setTimeout(() => { if (active) void refreshSession(); }, 0);
      });
      unsubscribe = () => data.subscription.unsubscribe();
      void refreshSession();
    }).catch((e: Error) => { if (active) { setError(e.message); setReady(true); } });
    return () => { active = false; revision.current++; clearTimeout(timer); unsubscribe?.(); };
  }, []);

  const value: SessionState = {
    session, ready, error, profileFailed,
    signIn: (from) => auth.signIn(from, window.location.origin),
    refreshSession,
    async signOut() {
      // Hide private pages while the SDK revokes and removes the browser session.
      setReady(false);
      clearAccount(null);
      // Which suggested places this browser would ask about stays with the student who saw them.
      try { window.localStorage.removeItem(CROWD_STORAGE_KEY); } catch { /* Storage may be disabled. */ }
      try { if (!DEV_AUTH_BYPASS) await auth.signOut(); setError(null); }
      catch (e) { setError(e instanceof Error ? e.message : 'Sign-out failed.'); throw e; }
      finally { setReady(true); }
    },
    hasRole: (role) => session?.roles.includes(role) ?? false,
  };
  return <SessionContext.Provider value={value}><Fragment key={identity}>{children}</Fragment></SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

/**
 * Whether this browser holds a Supabase sign-in (supabase-js keeps it in localStorage as
 * sb-<project>-auth-token). Read synchronously, so `/` can show the landing page at once to a
 * visitor who has never signed in instead of waiting for the session check.
 */
export function mayBeSignedIn(): boolean {
  if (DEV_AUTH_BYPASS) return true;
  try {
    for (let i = 0; i < localStorage.length; i++) if (/^sb-.+-auth-token$/.test(localStorage.key(i) ?? '')) return true;
    return false;
  } catch {
    return true; // storage blocked: wait for the check
  }
}

export function RequireAuth({ role, children }: { role?: Role; children: ReactNode }) {
  const { session, ready, profileFailed, hasRole } = useSession();
  const location = useLocation();
  // The check takes about a second: keep the page blank rather than flash a loading message.
  if (!ready) return <p role="status" className="visually-hidden">Loading your account…</p>;
  // Signed in but no profile: sending them to /signin would loop through Google back to here.
  if (!session && profileFailed) return <AccountError />;
  if (!session) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  if (role && !hasRole(role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
