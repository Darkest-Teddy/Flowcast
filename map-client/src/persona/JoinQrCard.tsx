/*
 * "Put yourself on the map": the corner card that invites someone to scan and join.
 *
 * Placement (and why it is not simply the handoff's "bottom left"): on this branch the bottom-left
 * corner is already the performance readout's. The card takes the corner, because it is the one
 * piece of chrome aimed at the room rather than the operator and it has to be the first thing a
 * passer-by sees, and the readout stacks directly above it (hud.css). The readout is a development
 * instrument, already relocated once by the chrome rebuild, and still dismissable with ?perf=0 and P.
 *
 * The card and the persona details card share this one slot and are never shown together: clicking a
 * character swaps the invitation for that person's details, and closing them brings it back. That
 * keeps the slot a fixed height, so nothing below it ever has to move.
 *
 * Resting, it is only a capsule; it opens into the card on a cycle, or whenever someone hovers or
 * taps it. The card keeps its full size in layout while folded, so the slot's height never changes.
 */

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { joinTone } from '../introSound';
import { JOINED_MARK } from './model';
import { JoinCharacter } from './JoinCharacter';

/** Where the phone should land. Set VITE_JOIN_URL to point a display at another host. */
export function joinUrl(): string {
  const configured = import.meta.env.VITE_JOIN_URL as string | undefined;
  if (configured) return configured;
  // The dashboard serves both itself and map.html, so the join page is a sibling of this page.
  return `${window.location.origin}/join`;
}

/*
 * The card rests as a capsule and opens on its own now and then: a display in a room should
 * catch the eye of whoever walks past, but a full card sitting in the corner all day is a sign,
 * and the map is what people came to read. Hover, focus or a tap opens it whenever someone wants.
 */
const FIRST_OPEN_MS = 4_000;
const OPEN_MS = 15_000;
const CLOSED_MS = 45_000;

export function JoinQrCard({ url = joinUrl() }: { url?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  // Bumped by a tap on the capsule, which restarts the cycle from "open".
  const [nudge, setNudge] = useState(0);

  // Once per URL. The code is a 360px PNG scaled down, so it stays crisp on a big display.
  useEffect(() => {
    let live = true;
    setFailed(false);
    QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: 'M', color: { dark: '#1d1d1f', light: '#ffffff' } })
      .then((dataUrl) => {
        if (live) setSrc(dataUrl);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [url]);

  // The cycle: rest, open, rest. Each phase schedules the next, so a tap can restart it cleanly.
  useEffect(() => {
    let timer = 0;
    const phase = (isOpen: boolean) => {
      setOpen(isOpen);
      // A tone as it pops open, on its cycle or a tap. Not on hover: that would chime at every pass of the mouse.
      if (isOpen) joinTone();
      timer = window.setTimeout(() => phase(!isOpen), isOpen ? OPEN_MS : CLOSED_MS);
    };
    if (nudge) phase(true);
    else timer = window.setTimeout(() => phase(true), FIRST_OPEN_MS);
    return () => window.clearTimeout(timer);
  }, [nudge]);

  return (
    <section className={`join${open ? ' is-open' : ''}`} aria-labelledby="join-card-title">
      <div className="join-card">
        {/* A real character, because the card is asking for one. Held still while folded away. */}
        <JoinCharacter still={!open} />

        <div className="join-card-body">
          <p className="join-card-title" id="join-card-title">
            Join the map
          </p>
          <p className="join-card-note">Scan to add yourself</p>
          <p className="join-card-url">{url.replace(/^https?:\/\//, '')}</p>
        </div>

        {/* At the edge, where the eye ends up, and on white in both themes: a dark tile does not scan. */}
        <div className="join-qr">
          {src && <img src={src} alt={`QR code linking to ${url}`} width={68} height={68} />}
          {failed && (
            <span className="join-qr-fallback" role="alert">
              Code unavailable
            </span>
          )}
        </div>
      </div>

      {/* The resting state. Closed, the card is clipped down to exactly this outline (persona.css). */}
      <button
        type="button"
        className="join-capsule"
        aria-expanded={open}
        aria-label="Join the map: show the QR code"
        onClick={() => setNudge((n) => n + 1)}
      >
        <span className="join-capsule-mark" aria-hidden="true">
          {JOINED_MARK}
        </span>
        Join the map
      </button>
    </section>
  );
}
