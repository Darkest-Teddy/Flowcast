import { ArrowLeft, BadgeCheck, Database, LayoutGrid, Map, Radio, Settings, SlidersHorizontal, Sparkles, Users } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { api, useResource } from '../data/api';
import { config } from '../config';
import { AppShell, type NavSection } from './AppShell';
import styles from './LayoutFooter.module.css';

/** The admin area: a separate place with its own nav. It never embeds the map. */
export function AdminLayout() {
  // Recount on every navigation so badges catch up after a source is fixed or a club reviewed.
  const { pathname } = useLocation();
  const { data: sources } = useResource(api.getDataSources, [pathname]);
  const { data: applications } = useResource(api.getClubApplications, [pathname]);
  const sourceIssues = sources?.filter((s) => s.health === 'attention' || s.health === 'failing').length;
  const pending = applications?.filter((a) => a.status === 'pending').length;

  const sections: NavSection[] = [
    {
      items: [
        { to: '/admin', label: 'Overview', icon: LayoutGrid, end: true },
        { to: '/admin/data-sources', label: 'Data sources', icon: Database, badge: sourceIssues },
        { to: '/admin/simulation', label: 'Simulation', icon: SlidersHorizontal },
        { to: '/admin/live', label: 'Live demo', icon: Radio },
        { to: '/admin/clubs', label: 'Club verification', icon: BadgeCheck, badge: pending },
        { to: config.mapUrl, label: 'Campus map', icon: Map, external: true },
        { to: '/admin/users', label: 'Users', icon: Users },
      ],
    },
    {
      label: 'System',
      items: [
        { to: '/admin/agent-brain', label: 'Agent brain', icon: Sparkles },
        { to: '/admin/settings', label: 'Settings', icon: Settings },
      ],
    },
  ];

  return (
    <AppShell
      sections={sections}
      brandTag="Admin"
      sidebarFooter={
        <Link to="/" className={styles.back}>
          <ArrowLeft aria-hidden />
          Back to Flowcast
        </Link>
      }
    />
  );
}
