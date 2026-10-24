import {
  BadgeCheck,
  CalendarDays,
  CalendarRange,
  CalendarSync,
  Gauge,
  Home,
  Map,
  Settings,
  ShieldCheck,
  Ticket,
  Upload,
  UserRound,
  Users,
} from 'lucide-react';
import { Link } from 'react-router';
import { useSession } from '../auth/session';
import { config } from '../config';
import { Avatar, Button } from '../ui';
import { AppShell, type NavSection } from './AppShell';
import styles from './LayoutFooter.module.css';

export function StudentLayout() {
  const { session, hasRole } = useSession();

  const sections: NavSection[] = [
    {
      items: [
        { to: '/', label: 'Home', icon: Home, end: true },
        { to: '/schedule', label: 'Schedule', icon: CalendarDays },
        { to: '/forecasts', label: 'Forecasts', icon: Gauge },
        { to: '/events', label: 'Events', icon: Ticket },
        { to: '/event-impact', label: 'Event impact', icon: CalendarRange },
        { to: '/clubs', label: 'Clubs', icon: Users },
      ],
    },
    {
      label: 'Account',
      items: [
        { to: '/profile', label: 'Profile', icon: UserRound },
        { to: '/calendars', label: 'Calendars', icon: CalendarSync },
        { to: '/privacy', label: 'Privacy & data', icon: ShieldCheck },
        { to: '/settings', label: 'Settings', icon: Settings },
      ],
    },
  ];

  if (hasRole('clubOfficer')) {
    sections.push({
      label: 'Your club',
      items: [
        { to: '/club', label: 'Club page', icon: BadgeCheck, end: true },
        { to: '/club/calendar', label: 'Upload calendar', icon: Upload },
      ],
    });
  }

  return (
    <AppShell
      sections={sections}
      topbarActions={
        <>
          <Button variant="ghost" to="/welcome">Get started</Button>
          <Button variant="primary" href={config.mapUrl} icon={<Map aria-hidden />}>Open the map</Button>
        </>
      }
      sidebarFooter={
        session && (
          <div className={styles.footer}>
            <Avatar name={session.user.name} />
            <span className={styles.name}>{session.user.name}</span>
            {hasRole('admin') && <Link to="/admin" className={styles.admin}>Admin</Link>}
          </div>
        )
      }
    />
  );
}
