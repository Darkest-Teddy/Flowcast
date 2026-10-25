import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { Menu, X, type LucideIcon } from 'lucide-react';
import styles from './AppShell.module.css';
import { Logo } from '../ui/Logo';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  end?: boolean;
  external?: boolean;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

/**
 * Phones only (860px and under): a floating tab bar replaces the sidebar. `tabs` are the tabs in
 * order; `more` is the last tab, a button that opens a menu with everything else.
 */
export interface TabBarConfig {
  tabs: NavItem[];
  more: { label: string; icon: LucideIcon; header?: ReactNode; sections: NavSection[] };
}

/** Same width as the `max-width: 860px` breakpoint in AppShell.module.css. */
const COMPACT = '(max-width: 860px)';

function isActive(item: NavItem, pathname: string) {
  return item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/** Arrow keys, Home and End move focus through the links inside `container`. */
function moveFocus(e: KeyboardEvent, container: HTMLElement | null) {
  if (!container || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const links = Array.from(container.querySelectorAll<HTMLElement>('a[href]'));
  if (!links.length) return;
  e.preventDefault();
  const at = links.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'Home' ? 0 : e.key === 'End' ? links.length - 1 : e.key === 'ArrowDown' ? (at + 1) % links.length : (at - 1 + links.length) % links.length;
  links[next].focus();
}

/**
 * Sidebar frame shared by the student app and admin area. On phones, use a menu button
 * for the admin drawer or the student floating tab bar.
 */
export function AppShell({
  sections,
  brandTag,
  sidebarFooter,
  tabBar,
}: {
  sections: NavSection[];
  brandTag?: string;
  sidebarFooter?: ReactNode;
  tabBar?: TabBarConfig;
}) {
  const [open, setOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();

  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const moreMenu = useRef<HTMLDivElement>(null);
  const moreId = useId();

  // Any navigation closes the drawer and the menu.
  useEffect(() => {
    setOpen(false);
    setMoreOpen(false);
  }, [pathname]);

  // Drawer: focus moves in when it opens and back to the menu button when it shuts (after the
  // render that lifts `inert` off the page, or the focus call would be ignored). Escape shuts it,
  // and so does growing past the phone breakpoint, so the inert page never gets stuck.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      const returnFocus = wasOpen.current && (!document.activeElement || document.activeElement === document.body || closeButton.current?.closest('aside')?.contains(document.activeElement));
      wasOpen.current = false;
      if (returnFocus) menuButton.current?.focus();
      return;
    }
    wasOpen.current = true;
    closeButton.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const wide = window.matchMedia(COMPACT);
    const onWide = () => !wide.matches && setOpen(false);
    document.addEventListener('keydown', onKey);
    wide.addEventListener('change', onWide);
    return () => {
      document.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', onWide);
    };
  }, [open]);

  // Tab bar menu: focus the first link on open; a press anywhere outside closes it.
  useEffect(() => {
    if (!moreOpen) return;
    moreMenu.current?.querySelector<HTMLElement>('a[href]')?.focus();
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!moreMenu.current?.contains(target) && !moreButton.current?.contains(target)) setMoreOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [moreOpen]);

  const closeMore = (returnFocus: boolean) => {
    setMoreOpen(false);
    if (returnFocus) moreButton.current?.focus();
  };

  const moreItems = tabBar?.more.sections.flatMap((s) => s.items) ?? [];
  const moreActive = moreItems.some((i) => isActive(i, pathname));
  const MoreIcon = tabBar?.more.icon;

  return (
    <div className={`${styles.shell} ${tabBar ? styles.withTabBar : ''}`}>
      <aside className={`${styles.sidebar} ${open ? styles.open : ''}`} aria-label="Main">
        <div className={styles.brand}>
          {/* The wordmark goes home, the way a site's name does. The close button stays outside it:
              a button nested in a link is not operable by keyboard or screen reader. */}
          <Link to="/landing" className={styles.brandLink} onClick={() => setOpen(false)}>
            <Logo className={styles.mark} />
            <span>Flowcast</span>
          </Link>
          {brandTag && <span className={styles.brandTag}>{brandTag}</span>}
          <button ref={closeButton} className={styles.close} onClick={() => setOpen(false)} aria-label="Close menu">
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
                  reloadDocument={item.external}
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

      <div className={styles.main} inert={open || undefined}>
        {!tabBar && <button ref={menuButton} className={styles.menu} onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>
          <Menu aria-hidden />
        </button>}
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>

      {tabBar && MoreIcon && (
        // The menu is a sibling of the bar, not a child: a blurred element inside another blurred
        // element only blurs its parent, not the page. It comes after the bar so Tab goes from the
        // Account button straight into it, and leaving it (focus outside the dock) closes it.
        <div
          className={styles.dock}
          onBlur={(e) => {
            if (moreOpen && !e.currentTarget.contains(e.relatedTarget as Node | null)) setMoreOpen(false);
          }}
        >
          <nav className={styles.tabBar} aria-label="Tabs">
            {tabBar.tabs.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} reloadDocument={item.external} className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabOn : ''}`}>
                <item.icon aria-hidden className={styles.tabIcon} />
                <span>{item.label}</span>
              </NavLink>
            ))}
            <button
              ref={moreButton}
              type="button"
              className={`${styles.tab} ${moreActive || moreOpen ? styles.tabOn : ''}`}
              aria-expanded={moreOpen}
              aria-controls={moreId}
              onClick={() => setMoreOpen((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && moreOpen) closeMore(true);
                else if (e.key === 'ArrowUp' && !moreOpen) {
                  e.preventDefault();
                  setMoreOpen(true);
                }
              }}
            >
              <MoreIcon aria-hidden className={styles.tabIcon} />
              <span>{tabBar.more.label}</span>
            </button>
          </nav>

          <div
            ref={moreMenu}
            id={moreId}
            className={styles.sheet}
            hidden={!moreOpen}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                closeMore(true);
              } else moveFocus(e, moreMenu.current);
            }}
          >
            {tabBar.more.header && <div className={styles.sheetHeader}>{tabBar.more.header}</div>}
            {tabBar.more.sections.map((section, i) => (
              <nav key={section.label ?? i} className={styles.sheetGroup} aria-label={section.label ?? tabBar.more.label}>
                {section.label && <div className={styles.groupLabel}>{section.label}</div>}
                {section.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                  reloadDocument={item.external}
                    onClick={() => setMoreOpen(false)}
                    className={({ isActive }) => `${styles.sheetItem} ${isActive ? styles.active : ''}`}
                  >
                    <item.icon aria-hidden className={styles.itemIcon} />
                    <span className={styles.itemLabel}>{item.label}</span>
                  </NavLink>
                ))}
              </nav>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
