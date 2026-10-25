import { createContext, Fragment, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { api, resetAccountData } from '../data/api';
import { auth } from './client';
import type { Role, Session } from '../data/types';

interface SessionState {
  session: Session | null;
  ready: boolean;
  error: string | null;
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
  const [identity, setIdentity] = useState<string | null>(null);
  const userId = useRef<string | null>(null);
  const revision = useRef(0);

  function clearAccount(id: string | null) {
    revision.current++;
    userId.current = id;
    resetAccountData();
    setSession(null);
    setIdentity(id);
  }

  async function refreshSession() {
    const version = ++revision.current;
    try {
      const { data, error: sdkError } = await (await auth.getClient()).auth.getSession();
      if (sdkError) throw sdkError;
      if (version !== revision.current) return;
      if (!data.session) { clearAccount(null); setReady(true); return; }
      const profile = await api.getSession();
      if (version === revision.current) { setSession(profile); setError(null); setReady(true); }
    } catch (e) {
      if (version === revision.current) {
        setSession(null);
        setError(e instanceof Error ? e.message : 'Your Flowcast profile could not be loaded.');
        setReady(true);
      }
    }
  }

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
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
    session, ready, error,
    signIn: (from) => auth.signIn(from, window.location.origin),
    refreshSession,
    async signOut() {
      // Hide private pages while the SDK revokes and removes the browser session.
      setReady(false);
      clearAccount(null);
      try { await auth.signOut(); setError(null); }
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

export function RequireAuth({ role, children }: { role?: Role; children: ReactNode }) {
  const { session, ready, hasRole } = useSession();
  const location = useLocation();
  if (!ready) return <p role="status">Loading your account…</p>;
  if (!session) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  if (role && !hasRole(role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
