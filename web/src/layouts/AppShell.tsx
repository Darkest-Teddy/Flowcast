import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Menu, X, type LucideIcon } from 'lucide-react';
import styles from './AppShell.module.css';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  end?: boolean;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

/**
 * Sidebar + top bar frame shared by the student app and the admin area. The top bar title is the
 * label of whichever nav item matches the current route.
 */
export function AppShell({
  sections,
  brandTag,
  topbarActions,
  sidebarFooter,
}: {
  sections: NavSection[];
  brandTag?: string;
  topbarActions?: ReactNode;
  sidebarFooter?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const all = sections.flatMap((s) => s.items);
  const current =
    all.filter((i) => (i.end ? pathname === i.to : pathname === i.to || pathname.startsWith(`${i.to}/`))).sort((a, b) => b.to.length - a.to.length)[0] ??
    all[0];

  return (
    <div className={styles.shell}>
      <aside className={`${styles.sidebar} ${open ? styles.open : ''}`} aria-label="Main">
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden />
          <span>Flowcast</span>
          {brandTag && <span className={styles.brandTag}>{brandTag}</span>}
          <button className={styles.close} onClick={() => setOpen(false)} aria-label="Close menu">
            <X aria-hidden />
          </button>
        </div>
        <nav className={styles.nav}>
          {sections.map((section, i) => (
            <div key={section.label ?? i} className={styles.group}>
              {section.label && <div className={styles.groupLabel}>{section.label}</div>}
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) => `${styles.item} ${isActive ? styles.active : ''}`}
                >
                  <item.icon aria-hidden className={styles.itemIcon} />
                  <span className={styles.itemLabel}>{item.label}</span>
                  {item.badge ? <span className={styles.badge}>{item.badge}</span> : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        {sidebarFooter && <div className={styles.footer}>{sidebarFooter}</div>}
      </aside>
      {open && <div className={styles.scrim} onClick={() => setOpen(false)} aria-hidden />}

      <div className={styles.main}>
        <header className={styles.topbar}>
          <button className={styles.menu} onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu aria-hidden />
          </button>
          <span className={styles.title}>{current?.label}</span>
          <div className={styles.topActions}>{topbarActions}</div>
        </header>
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
