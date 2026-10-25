import { Suspense, lazy, type ComponentType, type ReactNode } from 'react';
import { createBrowserRouter, RouterProvider, useMatch } from 'react-router';
import { mayBeSignedIn, RequireAuth, SessionProvider, useSession } from './auth/session';
import { AdminLayout } from './layouts/AdminLayout';
import { StudentLayout } from './layouts/StudentLayout';
import Home from './pages/Home';
import SignIn from './pages/SignIn';
import AuthCallback from './pages/AuthCallback';

/*
 * Home (the signed-in front page), sign-in and the auth callback ship in the main bundle; every other
 * page is its own chunk, fetched when its route is first visited. A signed-in visit to / otherwise
 * paid for every page's code, the landing page's animation libraries (motion, lenis) included.
 * Route `lazy` loads the chunk before the navigation commits, so the old page stays up meanwhile
 * instead of blanking behind a Suspense fallback.
 */
type PageModule = Promise<{ default: ComponentType }>;
function page(load: () => PageModule, wrap: (page: ReactNode) => ReactNode = (p) => p) {
  return {
    lazy: async () => {
      const { default: Page } = await load();
      return { element: wrap(<Page />) };
    },
    // On a first load straight onto a lazy page, its layout (sidebar, header) renders around an empty
    // outlet until the chunk arrives, rather than the whole app waiting blank.
    HydrateFallback: Blank,
  };
}
function Blank() {
  return null;
}
const signedIn = (role?: 'admin' | 'clubOfficer') => (p: ReactNode) => <RequireAuth role={role}>{p}</RequireAuth>;

/*
 * The landing page and the public privacy policy are what a signed-out visitor sees at / and /privacy.
 * They are rendered by StudentArea rather than a route, so they use React.lazy; for a browser with no
 * stored sign-in the download starts now, alongside the main bundle, rather than after first render.
 */
const loadLanding = () => import('./pages/Landing');
const loadPublicPrivacy = () => import('./pages/PublicPrivacy');
const Landing = lazy(loadLanding);
const PublicPrivacy = lazy(loadPublicPrivacy);
if (!mayBeSignedIn()) {
  const path = window.location.pathname;
  if (path === '/' || path === '/landing') void loadLanding();
  else if (path === '/privacy') void loadPublicPrivacy();
}

/*
 * /join is the one page that needs three.js, and it is reached by scanning a QR code rather than by
 * navigating the dashboard. Loaded on demand so its ~600 kB of renderer stays out of the bundle
 * every other page pays for.
 */
const Join = lazy(() => import('./pages/Join'));

/**
 * The student area. `/` itself is public: a signed-out visitor gets the landing page there, while
 * every page under it still sends them to /signin. Signed-in people get Home in the student layout.
 */
function StudentArea() {
  const { session, ready, profileFailed } = useSession();
  const atIndex = useMatch('/') !== null;
  const atPrivacy = useMatch('/privacy') !== null;
  // Signed out: no stored sign-in means the landing page right away, without waiting for the check.
  // Signed in with a profile that didn't load: RequireAuth shows AccountError instead.
  if (atIndex && !session && !profileFailed && (ready || !mayBeSignedIn())) return <Suspense fallback={null}><Landing /></Suspense>;
  // The privacy policy and terms are public (Google's OAuth review links here); signed in, /privacy adds the account tools.
  if (atPrivacy && !session && !profileFailed && (ready || !mayBeSignedIn())) return <Suspense fallback={null}><PublicPrivacy /></Suspense>;
  return (
    <RequireAuth>
      <StudentLayout />
    </RequireAuth>
  );
}

const router = createBrowserRouter([
  { path: '/auth/callback', element: <AuthCallback /> },
  { path: '/signin', element: <SignIn /> },
  { path: '/landing', element: <Suspense fallback={null}><Landing /></Suspense> }, // the landing page for everyone, signed in or not
  // Scanned from the QR card on the map display. Public and outside the student shell on purpose:
  // whoever scans it is a passer-by with a phone, not a signed-in user, and the builder's stage
  // needs the whole viewport.
  {
    path: '/join',
    element: (
      <Suspense fallback={null}>
        <Join />
      </Suspense>
    ),
  },
  { path: '/welcome', ...page(() => import('./pages/Welcome'), signedIn()) },
  { path: '/clubs/register', ...page(() => import('./pages/club/ClubApply'), signedIn()) },
  // Scanned at a meeting's door: works signed out too, keeping the code across Google sign-in (CheckIn.tsx).
  { path: '/checkin/:meetingId?', ...page(() => import('./pages/CheckIn')) },
  {
    path: '/',
    element: <StudentArea />,
    children: [
      { index: true, element: <Home /> },
      { path: 'ask', ...page(() => import('./pages/Ask')) },
      { path: 'schedule', ...page(() => import('./pages/Schedule')) },
      { path: 'forecasts', ...page(() => import('./pages/Forecasts')) },
      { path: 'study', ...page(() => import('./pages/Study')) },
      { path: 'events', ...page(() => import('./pages/Events')) },
      { path: 'event-impact', ...page(() => import('./pages/EventImpact')) },
      { path: 'clubs', ...page(() => import('./pages/Clubs')) },
      { path: 'meetings', ...page(() => import('./pages/Meetings')) },
      { path: 'clubs/:clubId', ...page(() => import('./pages/ClubDetail')) },
      { path: 'profile', ...page(() => import('./pages/Profile')) },
      { path: 'calendars', ...page(() => import('./pages/Calendars')) },
      { path: 'privacy', ...page(() => import('./pages/Privacy')) },
      { path: 'settings', ...page(() => import('./pages/Settings')) },
      { path: 'club', ...page(() => import('./pages/club/ClubPage'), signedIn('clubOfficer')) },
      { path: 'club/calendar', ...page(() => import('./pages/club/ClubCalendar'), signedIn('clubOfficer')) },
    ],
  },
  {
    path: '/admin',
    element: <RequireAuth role="admin"><AdminLayout /></RequireAuth>,
    children: [
      { index: true, ...page(() => import('./pages/admin/Overview')) },
      { path: 'data-sources', ...page(() => import('./pages/admin/DataSources')) },
      { path: 'simulation', ...page(() => import('./pages/admin/Simulation')) },
      { path: 'live', ...page(() => import('./pages/admin/LiveDemo')) },
      { path: 'clubs', ...page(() => import('./pages/admin/ClubVerification')) },
      { path: 'users', ...page(() => import('./pages/admin/Users')) },
      { path: 'agent-brain', ...page(() => import('./pages/admin/AgentBrain')) },
      { path: 'settings', ...page(() => import('./pages/admin/AdminSettings')) },
    ],
  },
]);

export function App() {
  return (
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  );
}
