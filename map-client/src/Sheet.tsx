// The one panel: a sheet on the right on wide screens, a bottom sheet on phones (PHONE_QUERY).
// Phones have three detents: 'peek' (the header only), 'half' and 'full'. The grabber at the top
// is a button too: press it (Enter or Space) to step to the next size, ArrowUp / ArrowDown to grow
// or shrink, or drag it (or the header) and let go near the size you want. Wide screens open and
// close it with the header's button ('peek' is closed, anything else open).
//
// The phone sheet is always full height and slides with a transform (compositor only); at 'half'
// the scroll area gets bottom padding as tall as the hidden part, so its last rows can still be
// scrolled into view. The visible height goes on the parent as --sheet-visible (the toolbar rides
// on it) and the covered width as --sheet-space; onCover reports both for the map's padding.
// The parent gets .is-dragging during a drag, which turns those transitions off.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

export type Detent = 'peek' | 'half' | 'full';

export const PHONE_QUERY = '(max-width: 800px)';
const ORDER: Detent[] = ['peek', 'half', 'full'];
const NAMES: Record<Detent, string> = { peek: 'collapsed', half: 'half height', full: 'full height' };
/** Below this a press on the grabber is a press, not a drag (px). */
const DRAG_SLOP = 6;
/** A flick carries the sheet on by this much of its speed (ms of travel). */
const FLING_MS = 140;

/** What the sheet covers, for the map's camera padding. */
export interface SheetCover {
  /** Wide screens: px covered from the right edge (0 when closed). */
  right: number;
  /** Phones: px covered from the bottom, capped at the half detent (the map past that is hidden anyway). */
  bottom: number;
}

interface Props {
  phone: boolean;
  detent: Detent;
  onDetent: (detent: Detent) => void;
  onCover: (cover: SheetCover) => void;
  /** Title row and summary: always visible, and the drag area on phones. */
  header: ReactNode;
  /** Header buttons beside the title (they don't start a drag). */
  actions?: ReactNode;
  /** A full-width line under the title row (the live counts). */
  subheader?: ReactNode;
  children: ReactNode;
}

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return phone;
}

export function Sheet({ phone, detent, onDetent, onCover, header, actions, subheader, children }: Props) {
  const sheetRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ sheet: 0, head: 0, parent: 0, width: 0 });
  const drag = useRef<{ id: number; y0: number; offset0: number; offset: number; t: number; v: number; moved: boolean } | null>(null);
  const dragEndedAt = useRef(-Infinity); // the click that ends a drag on the grabber isn't a press

  useLayoutEffect(() => {
    const sheet = sheetRef.current!;
    const head = headRef.current!;
    const parent = sheet.parentElement!;
    const measure = () => setSize({ sheet: sheet.offsetHeight, head: head.offsetHeight, parent: parent.clientHeight, width: sheet.offsetWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sheet);
    observer.observe(head);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const open = detent !== 'peek';
  const visibleAt = useCallback((d: Detent) => {
    if (d === 'peek') return size.head;
    if (d === 'full') return size.sheet;
    return Math.min(size.sheet, Math.max(size.head, Math.round(size.parent * 0.5)));
  }, [size]);
  const offsetFor = (visible: number) => Math.max(0, size.sheet - visible);

  // The toolbar and the map follow the settled size; a drag moves --sheet-visible directly.
  const visible = phone ? visibleAt(detent) : 0;
  const space = !phone && open ? size.width + 12 : 0;
  useLayoutEffect(() => {
    const parent = sheetRef.current!.parentElement!;
    parent.style.setProperty('--sheet-visible', `${visible}px`);
    parent.style.setProperty('--sheet-space', `${space}px`);
  }, [visible, space]);
  useEffect(() => {
    onCover({ right: phone ? 0 : space, bottom: phone ? Math.min(visible, visibleAt('half')) : 0 });
  }, [phone, space, visible, visibleAt, onCover]);

  const step = (by: 1 | -1) => {
    const next = ORDER[Math.min(ORDER.length - 1, Math.max(0, ORDER.indexOf(detent) + by))];
    if (next !== detent) onDetent(next);
  };

  // While dragging, the sheet's transform and --sheet-visible are written directly (and their
  // transitions are off, via .is-dragging on the parent); letting go settles on a detent.
  const place = (offset: number) => {
    sheetRef.current!.style.transform = `translate3d(0, ${offset}px, 0)`;
    sheetRef.current!.parentElement!.style.setProperty('--sheet-visible', `${size.sheet - offset}px`);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!phone || e.button !== 0) return;
    // Buttons in the header (the weather chip) keep their own presses; the grabber drags.
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, select') && !target.closest('.sheet-grabber')) return;
    const offset = offsetFor(visible);
    drag.current = { id: e.pointerId, y0: e.clientY, offset0: offset, offset, t: e.timeStamp, v: 0, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = e.clientY - d.y0;
    if (!d.moved) {
      if (Math.abs(dy) < DRAG_SLOP) return;
      // Captured only once it's a drag, so a plain press still clicks the grabber.
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      sheetRef.current!.parentElement!.classList.add('is-dragging');
    }
    const offset = Math.min(offsetFor(size.head), Math.max(0, d.offset0 + dy));
    const dt = e.timeStamp - d.t;
    if (dt > 0) d.v = (offset - d.offset) / dt;
    d.offset = offset;
    d.t = e.timeStamp;
    place(offset);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) return; // a press: the grabber's click handles it
    dragEndedAt.current = performance.now();
    // The detent nearest to where the flick would carry the sheet; it eases there.
    const landing = size.sheet - (d.offset + d.v * FLING_MS);
    const nearest = ORDER.reduce((best, x) => (Math.abs(visibleAt(x) - landing) < Math.abs(visibleAt(best) - landing) ? x : best));
    sheetRef.current!.parentElement!.classList.remove('is-dragging');
    place(offsetFor(visibleAt(nearest)));
    if (nearest !== detent) onDetent(nearest);
  };

  const onGrabberClick = () => {
    if (performance.now() - dragEndedAt.current < 400) return;
    onDetent(detent === 'full' ? 'peek' : ORDER[ORDER.indexOf(detent) + 1]);
  };

  const offset = phone ? offsetFor(visible) : 0;
  const ready = size.sheet > 0;
  return (
    <aside
      ref={sheetRef}
      className={`sheet${phone ? ' is-phone' : ''}${open ? ' is-open' : ''}${ready ? '' : ' is-measuring'}`}
      data-detent={detent}
      aria-label="Flowcast panel"
      style={phone ? { transform: `translate3d(0, ${offset}px, 0)` } : undefined}
    >
      <div className="sheet-head" ref={headRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        {phone && (
          <button
            className="sheet-grabber"
            onClick={onGrabberClick}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp') step(1);
              else if (e.key === 'ArrowDown') step(-1);
              else return;
              e.preventDefault();
            }}
            aria-label={detent === 'full' ? 'Collapse panel' : 'Expand panel'}
            aria-expanded={open}
            aria-controls="sheet-body"
            aria-keyshortcuts="ArrowUp ArrowDown"
            aria-describedby="sheet-size"
            title="Drag, or press to resize"
          >
            <span aria-hidden="true" />
          </button>
        )}
        <span id="sheet-size" className="visually-hidden">Panel is {NAMES[detent]}. Arrow keys resize it.</span>
        <div className="sheet-title">
          <div className="sheet-heading">{header}</div>
          <div className="sheet-actions">
            {actions}
            {!phone && (
              <button
                className="sheet-toggle"
                onClick={() => onDetent(open ? 'peek' : 'full')}
                aria-expanded={open}
                aria-controls="sheet-body"
                aria-label={open ? 'Hide panel' : 'Show panel'}
                title={open ? 'Hide panel' : 'Show panel'}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
                </svg>
              </button>
            )}
          </div>
        </div>
        {subheader}
      </div>
      <div
        id="sheet-body"
        className="sheet-body"
        hidden={!phone && !open}
        inert={phone && !open}
        style={phone ? { paddingBottom: `calc(${offset}px + 16px + env(safe-area-inset-bottom))` } : undefined}
      >
        {children}
      </div>
    </aside>
  );
}
