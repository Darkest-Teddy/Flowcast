// A toolbar button that opens a small panel above it (Camera, Layers). A disclosure, not a modal:
// focus stays where it was, Escape or a press outside closes it, and closing with Escape returns
// focus to the button.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface Props {
  /** The button's visible content (an icon and a short word). */
  label: ReactNode;
  /** The panel's accessible name, also the button's. */
  title: string;
  /** Shown as the button's tooltip, e.g. a keyboard hint. */
  hint?: string;
  className?: string;
  children: ReactNode;
}

export function Popover({ label, title, hint, className, children }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`popover${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        ref={buttonRef}
        className="tool"
        aria-expanded={open}
        aria-controls={id}
        aria-label={title}
        title={hint ?? title}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      <div className="popover-panel" id={id} role="group" aria-label={title} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
