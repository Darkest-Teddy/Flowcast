import {
  BadgeCheck,
  CalendarDays,
  CalendarRange,
  CalendarSync,
  Gauge,
  Home,
  LayoutGrid,
  Map,
  MessagesSquare,
  Settings,
  Sparkles,
  ShieldCheck,
  Ticket,
  Upload,
  UserRound,
  UserRoundCog,
  Users,
} from 'lucide-react';
import { Link } from 'react-router';
import { useSession } from '../auth/session';
import { config } from '../config';
import { Avatar, Button } from '../ui';
import { AppShell, type NavItem, type NavSection, type TabBarConfig } from './AppShell';
import styles from './LayoutFooter.module.css';

export function StudentLayout() {
  const { session, hasRole } = useSession();

  const home: NavItem = { to: '/', label: 'Home', icon: Home, end: true };
  const ask: NavItem = { to: '/ask', label: 'Ask Flowcast', icon: MessagesSquare };
  const schedule: NavItem = { to: '/schedule', label: 'Schedule', icon: CalendarDays };
  const forecasts: NavItem = { to: '/forecasts', label: 'Forecasts', icon: Gauge };
  const events: NavItem = { to: '/events', label: 'Events', icon: Ticket };
  const eventImpact: NavItem = { to: '/event-impact', label: 'Event impact', icon: CalendarRange };
  const clubs: NavItem = { to: '/clubs', label: 'Clubs', icon: Users };
  const account: NavSection = {
    label: 'Account',
    items: [
      { to: '/profile', label: 'Profile', icon: UserRound },
      { to: '/calendars', label: 'Calendars', icon: CalendarSync },
      { to: '/privacy', label: 'Privacy & data', icon: ShieldCheck },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  };
  const club: NavSection | null = hasRole('clubOfficer')
    ? {
        label: 'Your club',
        items: [
          { to: '/club', label: 'Club page', icon: BadgeCheck, end: true },
          { to: '/club/calendar', label: 'Upload calendar', icon: Upload },
        ],
      }
    : null;

  const sections: NavSection[] = [{ items: [home, ask, schedule, forecasts, events, eventImpact, clubs] }, account];
  if (club) sections.push(club);

  // Phones: five tabs, and an Account tab whose menu holds the rest of the sidebar, plus the
  // top bar's Get started (no room for it up there) and the Admin link from the sidebar footer.
  const tabBar: TabBarConfig = {
    tabs: [home, schedule, forecasts, events, clubs],
    more: {
      label: 'Account',
      icon: UserRoundCog,
      header: session && (
        <div className={styles.footer}>
          <Avatar name={session.user.name || 'Google user'} />
          <span className={styles.name}>{session.user.name || 'Google user'}</span>
        </div>
      ),
      sections: [
        account,
        { label: 'More', items: [ask, eventImpact, { to: '/welcome', label: 'Get started', icon: Sparkles }] },
        ...(club ? [club] : []),
        ...(hasRole('admin') ? [{ label: 'Admin', items: [{ to: '/admin', label: 'Admin area', icon: LayoutGrid }] }] : []),
      ],
    },
  };

  return (
    <AppShell
      sections={sections}
      tabBar={tabBar}
      topbarActions={
        <>
          <Button variant="ghost" to="/welcome" className={styles.wideOnly}>Get started</Button>
          <Button variant="primary" href={config.mapUrl} icon={<Map aria-hidden />}>Open the map</Button>
        </>
      }
      sidebarFooter={
        session && (
          <div className={styles.footer}>
            <Avatar name={session.user.name || 'Google user'} />
            <span className={styles.name}>{session.user.name || 'Google user'}</span>
            {hasRole('admin') && <Link to="/admin" className={styles.admin}>Admin</Link>}
          </div>
        )
      }
    />
  );
}
