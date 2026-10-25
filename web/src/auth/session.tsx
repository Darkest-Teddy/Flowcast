// A browser-linked guest profile, not an authenticated Google account.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { api } from '../data/api';
import type { Role, Session } from '../data/types';

interface SessionState {
  session: Session | null;
  ready: boolean;
  startLocalSession: () => Promise<void>;
  refreshSession: () => Promise<void>;
  signOut: () => void;
  hasRole: (role: Role) => boolean;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    api.getSession().then((s) => {
      if (active) setSession(s);
    }).catch(() => {
      if (active) setSession(null);
    }).finally(() => {
      if (active) setReady(true);
    });
    return () => { active = false; };
  }, []);

  const value: SessionState = {
    session,
    ready,
    async startLocalSession() {
      setSession(await api.getSession());
    },
    async refreshSession() {
      setSession(await api.getSession());
    },
    signOut() {
      setSession(null);
    },
    hasRole: (role) => session?.roles.includes(role) ?? false,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

/** Sends signed-out visitors to /signin, and non-admins away from admin pages. */
export function RequireAuth({ role, children }: { role?: Role; children: ReactNode }) {
  const { session, ready, hasRole } = useSession();
  const location = useLocation();
  if (!ready) return null;
  if (!session) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  if (role && !hasRole(role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
