import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, Search } from 'lucide-react';
import styles from './Select.module.css';

interface Option {
  value: string;
  label: string;
  disabled: boolean;
}

/** Long lists get a filter box at the top of the menu. */
const FILTER_FROM = 12;
const GAP = 6;
const MAX_HEIGHT = 320;

/** The text of an <option>'s children: `{n} minutes` arrives as [60, " minutes"]. */
function text(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return '';
}

function optionsOf(children: ReactNode): Option[] {
  const out: Option[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>;
    if (el.type === 'option') {
      const label = text(el.props.children);
      out.push({ value: String(el.props.value ?? label), label, disabled: !!el.props.disabled });
    } else if (el.props.children) {
      out.push(...optionsOf(el.props.children)); // fragments and optgroups
    }
  });
  return out;
}

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> & {
  onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
  /** Extra class on the trigger, for fields that size it themselves. */
  className?: string;
};

/**
 * A drop-in for <select>: same <option> children, same `value`, and `onChange` still hands back
 * `event.target.value`, so callers don't change. The menu is a listbox in a portal (glass cards
 * each make their own stacking context, so a menu drawn inside one would slip under the next
 * card), placed under the trigger or above it when there's no room, with a filter on long lists.
 *
 * Keyboard: Enter, Space or the arrows open it; arrows, Home and End move; typing jumps to a
 * match (or filters, on long lists); Enter picks; Escape and Tab close.
 */
export function Select({ value, onChange, children, disabled, id, className, name, ...rest }: Props) {
  const options = useMemo(() => optionsOf(children), [children]);
  const current = String(value ?? '');
  const selected = options.find((o) => o.value === current) ?? options[0];
  const autoId = useId();
  const triggerId = id ?? `${autoId}-trigger`;
  const listId = `${autoId}-list`;
  const valueId = `${autoId}-value`;
  const { 'aria-label': ariaLabel, 'aria-labelledby': labelledBy, ...props } = rest as Record<string, string | undefined>;

  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const [place, setPlace] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const typed = useRef({ text: '', at: 0 });

  const filterable = options.length >= FILTER_FROM;
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options), [options, q]);

  const choose = useCallback((option: Option | undefined) => {
    if (!option || option.disabled) return;
    setOpen(false);
    trigger.current?.focus();
    if (option.value === current) return;
    const target = { value: option.value, name };
    onChange?.({ target, currentTarget: target } as unknown as ChangeEvent<HTMLSelectElement>);
  }, [current, name, onChange]);

  const openMenu = () => {
    if (disabled) return;
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === current)));
    setOpen(true);
  };

  // Place the menu against the trigger; flip above when there's more room there.
  const position = useCallback(() => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    const below = window.innerHeight - box.bottom - GAP - 8;
    const above = box.top - GAP - 8;
    const width = Math.min(Math.max(box.width, 260), window.innerWidth - 16);
    const left = Math.min(box.left, window.innerWidth - width - 8);
    if (below >= Math.min(MAX_HEIGHT, 180) || below >= above) setPlace({ left, width, top: box.bottom + GAP, maxHeight: Math.min(MAX_HEIGHT, below) });
    else setPlace({ left, width, bottom: window.innerHeight - box.top + GAP, maxHeight: Math.min(MAX_HEIGHT, above) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, position]);

  // Close on a press outside. (The filter on long lists focuses itself when the menu mounts.)
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  // Keep the active option in view.
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const move = (from: number, step: 1 | -1) => {
    for (let i = 1; i <= shown.length; i++) {
      const next = (from + step * i + shown.length) % shown.length;
      if (!shown[next].disabled) return next;
    }
    return from;
  };

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        openMenu();
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Typing on a closed select changes the value to the next match, like the native one.
        const now = Date.now();
        typed.current = { text: now - typed.current.at < 700 ? typed.current.text + e.key.toLowerCase() : e.key.toLowerCase(), at: now };
        const match = options.find((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text));
        if (match && match.value !== current) {
          const target = { value: match.value, name };
          onChange?.({ target, currentTarget: target } as unknown as ChangeEvent<HTMLSelectElement>);
        }
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((a) => move(a, 1)); break;
      case 'ArrowUp': e.preventDefault(); setActive((a) => move(a, -1)); break;
      case 'Home': if (!filterable) { e.preventDefault(); setActive(move(-1, 1)); } break;
      case 'End': if (!filterable) { e.preventDefault(); setActive(move(shown.length, -1)); } break;
      case 'Enter': e.preventDefault(); choose(shown[active]); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); break;
      case 'Tab': setOpen(false); break;
      case ' ': if (!filterable) { e.preventDefault(); choose(shown[active]); } break;
      default:
        if (!filterable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const now = Date.now();
          typed.current = { text: now - typed.current.at < 700 ? typed.current.text + e.key.toLowerCase() : e.key.toLowerCase(), at: now };
          const i = shown.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text));
          if (i >= 0) setActive(i);
        }
    }
  };

  const activeId = shown[active] ? `${listId}-${active}` : undefined;

  return (
    <>
      <button
        {...props}
        ref={trigger}
        // Name + value, like a native select: "Place, Mugar Library".
        aria-label={ariaLabel ? `${ariaLabel}, ${selected?.label ?? ''}` : undefined}
        aria-labelledby={ariaLabel ? undefined : `${labelledBy ?? `${triggerId}-label`} ${valueId}`}
        id={triggerId}
        type="button"
        className={`${styles.trigger} ${className ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && !filterable ? activeId : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKey}
      >
        <span id={valueId} className={styles.value}>{selected?.label ?? ''}</span>
        <svg className={styles.chevron} viewBox="0 0 16 16" aria-hidden><path d="m4.5 6.25 3.5 3.5 3.5-3.5" /></svg>
      </button>
      {name && <input type="hidden" name={name} value={current} />}
      {open && place && createPortal(
        <div
          ref={menu}
          className={`${styles.menu} ${place.bottom !== undefined ? styles.up : ''}`}
          style={{ left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}
          onKeyDown={filterable ? onKey : undefined}
        >
          {filterable && (
            <label className={styles.filter}>
              <Search aria-hidden />
              <input
                ref={(el) => { filterInput.current = el; el?.focus({ preventScroll: true }); }}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setActive(0); }}
                placeholder="Search"
                aria-label="Filter options"
                aria-controls={listId}
                aria-activedescendant={activeId}
                role="combobox"
                aria-expanded
                aria-autocomplete="list"
              />
            </label>
          )}
          <ul id={listId} role="listbox" className={styles.list} aria-labelledby={triggerId} tabIndex={-1}>
            {shown.map((o, i) => (
              <li
                key={`${o.value}-${i}`}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={o.value === current}
                aria-disabled={o.disabled || undefined}
                className={`${styles.option} ${i === active ? styles.active : ''} ${o.value === current ? styles.selected : ''}`}
                onPointerMove={() => { if (i !== active && !o.disabled) setActive(i); }}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => choose(o)}
              >
                <span>{o.label}</span>
                {o.value === current && <Check aria-hidden className={styles.check} />}
              </li>
            ))}
            {!shown.length && <li className={styles.empty} role="presentation">No matches</li>}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}
