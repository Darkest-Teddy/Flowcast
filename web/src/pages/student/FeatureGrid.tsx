import type { LucideIcon } from 'lucide-react';
import {
  BadgeCheck,
  BookOpen,
  CalendarDays,
  CalendarRange,
  CalendarSync,
  Gauge,
  LayoutGrid,
  Map,
  MessagesSquare,
  Ticket,
  UserRound,
  Users,
} from 'lucide-react';
import { Link } from 'react-router';
import { config } from '../../config';
import styles from './FeatureGrid.module.css';

interface Feature {
  to: string;
  label: string;
  blurb: string;
  icon: LucideIcon;
  external?: boolean;
}

const FEATURES: Feature[] = [
  { to: '/ask', label: 'Ask Flowcast', blurb: 'Ask about crowds, walks and your day, and keep the conversation going.', icon: MessagesSquare },
  { to: '/schedule', label: 'Schedule', blurb: 'Your imported classes, with leave-by times.', icon: CalendarDays },
  { to: '/study', label: 'Study spots', blurb: 'Spaces that fit the time you have, by walk, hours and crowd.', icon: BookOpen },
  { to: '/forecasts', label: 'Forecasts', blurb: 'Hour-by-hour crowd projections and the best times this week.', icon: Gauge },
  { to: '/events', label: 'Events', blurb: 'Every public BU event, and whether it changes the map.', icon: Ticket },
  { to: '/event-impact', label: 'Event impact', blurb: 'Crowds on any date, with and without that day’s events.', icon: CalendarRange },
  { to: '/clubs', label: 'Clubs', blurb: 'Follow clubs to see their events on your dashboard.', icon: Users },
  { to: config.mapUrl, label: 'Campus map', blurb: 'The live 3D campus: crowds, transit, events and drills.', icon: Map, external: true },
  { to: '/calendars', label: 'Calendars', blurb: 'Import or replace your .ics class schedule.', icon: CalendarSync },
  { to: '/profile', label: 'Profile', blurb: 'Home building and meal times that shape your plans.', icon: UserRound },
];

/** Everything Flowcast does, one tile each, so nothing is only reachable from the sidebar. */
export function FeatureGrid({ clubOfficer, admin }: { clubOfficer: boolean; admin: boolean }) {
  const features = [
    ...FEATURES,
    ...(clubOfficer ? [{ to: '/club', label: 'Your club', blurb: 'Your club page and calendar upload.', icon: BadgeCheck }] : []),
    ...(admin ? [{ to: '/admin', label: 'Admin area', blurb: 'Data sources, simulation and club verification.', icon: LayoutGrid }] : []),
  ];
  return (
    <section className={styles.section} aria-labelledby="all-features">
      <h2 id="all-features" className={styles.heading}>Everything in Flowcast</h2>
      <ul className={styles.grid}>
        {features.map(({ to, label, blurb, icon: Icon, external }) => {
          const body = (
            <>
              <Icon aria-hidden className={styles.icon} />
              <span className={styles.label}>{label}</span>
              <span className={styles.blurb}>{blurb}</span>
            </>
          );
          return (
            <li key={to}>
              {external ? <a href={to} className={styles.tile}>{body}</a> : <Link to={to} className={styles.tile}>{body}</Link>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
