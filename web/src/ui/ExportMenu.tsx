import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import styles from './ExportMenu.module.css';

export interface ExportOption {
  label: string;
  /** What's in it, in a few words: "Every hour, every place". */
  detail?: string;
  run: () => void;
}

/**
 * "Export" in a page header: one option downloads straight away; several open a small menu
 * (role="menu", arrows to move, Enter to pick, Escape to close), drawn in a portal like Select.
 */
export function ExportMenu({ options, disabled, label = 'Export' }: { options: ExportOption[]; disabled?: boolean; label?: string }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const pick = (option: ExportOption) => {
    setOpen(false);
    button.current?.focus();
    option.run();
    setDone(option.label);
  };

  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(null), 2000);
    return () => window.clearTimeout(t);
  }, [done]);

  useLayoutEffect(() => {
    if (!open) return;
    const at = () => {
      const box = button.current?.getBoundingClientRect();
      if (box) setPlace({ top: box.bottom + 6, right: Math.max(8, window.innerWidth - box.right) });
    };
    at();
    window.addEventListener('resize', at);
    window.addEventListener('scroll', at, true);
    return () => {
      window.removeEventListener('resize', at);
      window.removeEventListener('scroll', at, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [open, active, place]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % options.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + options.length) % options.length); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); button.current?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  const single = options.length === 1;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.button}
        disabled={disabled || !options.length}
        aria-haspopup={single ? undefined : 'menu'}
        aria-expanded={single ? undefined : open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => (single ? pick(options[0]) : (setActive(0), setOpen((o) => !o)))}
        onKeyDown={(e) => { if (!single && e.key === 'ArrowDown') { e.preventDefault(); setActive(0); setOpen(true); } }}
      >
        <Download aria-hidden />
        <span>{done ? 'Downloaded' : label}</span>
      </button>
      <span className="visually-hidden" role="status">{done ? `${done} downloaded` : ''}</span>
      {open && place && createPortal(
        <div ref={menu} id={`${id}-menu`} role="menu" aria-label={label} className={styles.menu} style={{ top: place.top, right: place.right }} onKeyDown={onKey}>
          {options.map((o, i) => (
            <button key={o.label} type="button" role="menuitem" data-index={i} tabIndex={i === active ? 0 : -1}
              className={styles.item} onClick={() => pick(o)} onPointerMove={() => setActive(i)}>
              <strong>{o.label}</strong>
              {o.detail && <span>{o.detail}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
