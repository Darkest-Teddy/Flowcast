import { createBrowserRouter, RouterProvider } from 'react-router';
import { RequireAuth, SessionProvider } from './auth/session';
import { AdminLayout } from './layouts/AdminLayout';
import { StudentLayout } from './layouts/StudentLayout';
import Home from './pages/Home';
import SignIn from './pages/SignIn';
import Welcome from './pages/Welcome';
import Schedule from './pages/Schedule';
import Forecasts from './pages/Forecasts';
import Events from './pages/Events';
import Clubs from './pages/Clubs';
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

const router = createBrowserRouter([
  { path: '/signin', element: <SignIn /> },
  { path: '/welcome', element: <RequireAuth><Welcome /></RequireAuth> },
  { path: '/clubs/register', element: <RequireAuth><ClubApply /></RequireAuth> },
  {
    path: '/',
    element: <RequireAuth><StudentLayout /></RequireAuth>,
    children: [
      { index: true, element: <Home /> },
      { path: 'schedule', element: <Schedule /> },
      { path: 'forecasts', element: <Forecasts /> },
      { path: 'events', element: <Events /> },
      { path: 'clubs', element: <Clubs /> },
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
