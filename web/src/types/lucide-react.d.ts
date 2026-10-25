/*
 * lucide-react@1.61.0 points `typings` at dist/lucide-react.d.ts, but the published
 * package contains no .d.ts files at all. Without this, `tsc -b` fails on every file
 * that imports an icon, which takes `npm run build` -- and therefore any deploy --
 * down with it.
 *
 * Declaring the module wholesale would make `LucideIcon` a namespace rather than a
 * type, which breaks AppShell.tsx's `icon: LucideIcon` prop. So the icons the app
 * actually imports are declared individually, and real typing is preserved.
 *
 * Adding a new icon to the app means adding its name here. That is deliberate: it
 * keeps the list honest rather than silently widening to `any`.
 *
 * The version number is also well ahead of lucide-react's published 0.x line and is
 * worth verifying independently.
 */
declare module 'lucide-react' {
  import type { ComponentType, SVGProps } from 'react';

  export interface LucideProps extends SVGProps<SVGSVGElement> {
    size?: string | number;
    absoluteStrokeWidth?: boolean;
  }

  export type LucideIcon = ComponentType<LucideProps>;

  export const ArrowLeft: LucideIcon;
  export const ArrowRight: LucideIcon;
  export const ArrowUp: LucideIcon;
  export const BadgeCheck: LucideIcon;
  export const BookOpen: LucideIcon;
  export const CalendarDays: LucideIcon;
  export const CalendarRange: LucideIcon;
  export const CalendarSync: LucideIcon;
  export const ChartLine: LucideIcon;
  export const ChevronDown: LucideIcon;
  export const ChevronLeft: LucideIcon;
  export const ChevronRight: LucideIcon;
  export const CircleCheck: LucideIcon;
  export const CircleDashed: LucideIcon;
  export const CircleX: LucideIcon;
  export const Database: LucideIcon;
  export const Download: LucideIcon;
  export const Eraser: LucideIcon;
  export const ExternalLink: LucideIcon;
  export const Gauge: LucideIcon;
  export const Home: LucideIcon;
  export const LayoutGrid: LucideIcon;
  export const Map: LucideIcon;
  export const Menu: LucideIcon;
  export const MessagesSquare: LucideIcon;
  export const Moon: LucideIcon;
  export const PanelLeftClose: LucideIcon;
  export const PanelLeftOpen: LucideIcon;
  export const Pause: LucideIcon;
  export const Play: LucideIcon;
  export const Radio: LucideIcon;
  export const RefreshCw: LucideIcon;
  export const RotateCcw: LucideIcon;
  export const Search: LucideIcon;
  export const Settings: LucideIcon;
  export const ShieldCheck: LucideIcon;
  export const SlidersHorizontal: LucideIcon;
  export const Sparkles: LucideIcon;
  export const Square: LucideIcon;
  export const Sun: LucideIcon;
  export const Table2: LucideIcon;
  export const Ticket: LucideIcon;
  export const Upload: LucideIcon;
  export const UserRound: LucideIcon;
  export const UserRoundCog: LucideIcon;
  export const Users: LucideIcon;
  export const UtensilsCrossed: LucideIcon;
  export const X: LucideIcon;
  export const Zap: LucideIcon;
}
