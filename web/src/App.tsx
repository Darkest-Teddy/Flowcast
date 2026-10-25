import { Suspense, lazy } from 'react';
import { createBrowserRouter, RouterProvider, useMatch } from 'react-router';
import { mayBeSignedIn, RequireAuth, SessionProvider, useSession } from './auth/session';
import { AdminLayout } from './layouts/AdminLayout';
import { StudentLayout } from './layouts/StudentLayout';
import Home from './pages/Home';
import Ask from './pages/Ask';
import Landing from './pages/Landing';
import Legal from './pages/Legal';
import SignIn from './pages/SignIn';
import AuthCallback from './pages/AuthCallback';
import Welcome from './pages/Welcome';
import Schedule from './pages/Schedule';
import Forecasts from './pages/Forecasts';
import Study from './pages/Study';
import Events from './pages/Events';
import EventImpact from './pages/EventImpact';
import Clubs from './pages/Clubs';
import Meetings from './pages/Meetings';
import Profile from './pages/Profile';
import Calendars from './pages/Calendars';
import Privacy from './pages/Privacy';
import Settings from './pages/Settings';
import ClubPage from './pages/club/ClubPage';
import ClubCalendar from './pages/club/ClubCalendar';
import ClubApply from './pages/club/ClubApply';
import Overview from './pages/admin/Overview';
import DataSources from './pages/admin/DataSources';
import Simulation from './pages/admin/Simulation';
import LiveDemo from './pages/admin/LiveDemo';
import ClubVerification from './pages/admin/ClubVerification';
import Users from './pages/admin/Users';
import AgentBrain from './pages/admin/AgentBrain';
import AdminSettings from './pages/admin/AdminSettings';

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
  const { session, ready } = useSession();
  const atIndex = useMatch('/') !== null;
  // Signed out: no stored sign-in means the landing page right away, without waiting for the check.
  if (atIndex && !session && (ready || !mayBeSignedIn())) return <Landing />;
  return (
    <RequireAuth>
      <StudentLayout />
    </RequireAuth>
  );
}

const router = createBrowserRouter([
  { path: '/auth/callback', element: <AuthCallback /> },
  { path: '/signin', element: <SignIn /> },
  { path: '/landing', element: <Landing /> }, // the landing page for everyone, signed in or not
  // The privacy policy and terms, public: they are linked from the landing footer, and nobody should
  // have to sign in to read what they would be agreeing to. The dashboard shows the same documents
  // under /privacy, beside the download and delete controls.
  { path: '/legal', element: <Legal /> },
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
  { path: '/welcome', element: <RequireAuth><Welcome /></RequireAuth> },
  { path: '/clubs/register', element: <RequireAuth><ClubApply /></RequireAuth> },
  {
    path: '/',
    element: <StudentArea />,
    children: [
      { index: true, element: <Home /> },
      { path: 'ask', element: <Ask /> },
      { path: 'schedule', element: <Schedule /> },
      { path: 'forecasts', element: <Forecasts /> },
      { path: 'study', element: <Study /> },
      { path: 'events', element: <Events /> },
      { path: 'event-impact', element: <EventImpact /> },
      { path: 'clubs', element: <Clubs /> },
      { path: 'meetings', element: <Meetings /> },
      { path: 'profile', element: <Profile /> },
      { path: 'calendars', element: <Calendars /> },
      { path: 'privacy', element: <Privacy /> },
      { path: 'settings', element: <Settings /> },
      { path: 'club', element: <RequireAuth role="clubOfficer"><ClubPage /></RequireAuth> },
      { path: 'club/calendar', element: <RequireAuth role="clubOfficer"><ClubCalendar /></RequireAuth> },
    ],
  },
  {
    path: '/admin',
    element: <RequireAuth role="admin"><AdminLayout /></RequireAuth>,
    children: [
      { index: true, element: <Overview /> },
      { path: 'data-sources', element: <DataSources /> },
      { path: 'simulation', element: <Simulation /> },
      { path: 'live', element: <LiveDemo /> },
      { path: 'clubs', element: <ClubVerification /> },
      { path: 'users', element: <Users /> },
      { path: 'agent-brain', element: <AgentBrain /> },
      { path: 'settings', element: <AdminSettings /> },
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
