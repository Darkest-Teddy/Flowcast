// Who is signed in. Google sign-in is mocked until /server handles the OAuth exchange; the rest of
// the app only reads `useSession()` and doesn't care how the session was created.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { api } from '../data/api';
import type { Role, Session } from '../data/types';

const STORAGE_KEY = 'flowcast.signedIn';

interface SessionState {
  session: Session | null;
  ready: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => void;
  hasRole: (role: Role) => boolean;
}

const SessionContext = createContext<SessionState | null>(null);

function readFlag(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeFlag(on: boolean) {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage blocked: session lasts for this page load only
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!readFlag()) {
      setReady(true);
      return;
    }
    api.getSession().then((s) => {
      setSession(s);
      setReady(true);
    });
  }, []);

  const value: SessionState = {
    session,
    ready,
    async signInWithGoogle() {
      const s = await api.getSession();
      writeFlag(true);
      setSession(s);
    },
    signOut() {
      writeFlag(false);
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
