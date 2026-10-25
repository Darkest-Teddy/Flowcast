import {
  BadgeCheck,
  BookOpen,
  DoorOpen,
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
  Menu,
  Users,
} from 'lucide-react';
import { Link, NavLink } from 'react-router';
import { useSession } from '../auth/session';
import { config } from '../config';
import { Avatar } from '../ui';
import { MapBackdrop } from './MapBackdrop';
import { AppShell, type NavItem, type NavSection, type TabBarConfig } from './AppShell';
import styles from './LayoutFooter.module.css';

export function StudentLayout() {
  const { session, hasRole } = useSession();

  const home: NavItem = { to: '/', label: 'Home', icon: Home, end: true };
  const ask: NavItem = { to: '/ask', label: 'Ask Flowcast', icon: MessagesSquare };
  const schedule: NavItem = { to: '/schedule', label: 'Schedule', icon: CalendarDays };
  const study: NavItem = { to: '/study', label: 'Study spots', icon: BookOpen };
  const forecasts: NavItem = { to: '/forecasts', label: 'Forecasts', icon: Gauge };
  const events: NavItem = { to: '/events', label: 'Events', icon: Ticket };
  const eventImpact: NavItem = { to: '/event-impact', label: 'Event impact', icon: CalendarRange };
  const map: NavItem = { to: config.mapUrl, label: 'Campus map', icon: Map, external: true };
  const welcome: NavItem = { to: '/welcome', label: 'Get started', icon: Sparkles };
  const clubs: NavItem = { to: '/clubs', label: 'Clubs', icon: Users };
  const meetings: NavItem = { to: '/meetings', label: 'Club meetings', icon: DoorOpen };
  const account: NavSection = {
    label: 'Account',
    items: [
      welcome,
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

  const sections: NavSection[] = [
    { items: [home, ask] },
    { label: 'Plan', items: [schedule, study, forecasts] },
    { label: 'Campus life', items: [events, eventImpact, clubs, meetings] },
    ...(club ? [club] : []),
    account,
  ];

  const tabBar: TabBarConfig = {
    tabs: [home, schedule, forecasts, events, clubs],
    more: {
      label: 'More',
      icon: Menu,
      header: session && (
        <Link to="/profile" className={`${styles.footer} ${styles.profile}`} title="Your profile">
          <Avatar name={session.user.name || 'Google user'} />
          <span className={styles.name}>{session.user.name || 'Google user'}</span>
        </Link>
      ),
      sections: [
        account,
        { label: 'More', items: [study, ask, meetings, eventImpact, map] },
        ...(club ? [club] : []),
        ...(hasRole('admin') ? [{ label: 'Admin', items: [{ to: '/admin', label: 'Admin area', icon: LayoutGrid }] }] : []),
      ],
    },
  };

  return (
    <>
      <MapBackdrop />
      <AppShell
        sections={sections}
        tabBar={tabBar}
        sidebarFooter={
          session && (
            <div className={styles.footer}>
              <NavLink to="/profile" className={({ isActive }) => `${styles.profile} ${isActive ? styles.profileOn : ''}`} title="Your profile">
                <Avatar name={session.user.name || 'Google user'} />
                <span className={styles.name} data-rail="hide">{session.user.name || 'Google user'}</span>
              </NavLink>
              {hasRole('admin') && <Link to="/admin" className={styles.admin} data-rail="hide">Admin</Link>}
            </div>
          )
        }
      />
    </>
  );
}
