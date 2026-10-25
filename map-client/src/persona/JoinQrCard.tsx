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
 * The 64px live character the handoff shows in the right column is not drawn. It would need three.js
 * in map-client (which this branch does not have) and a second WebGL context on the map page, for a
 * decorative thumbnail. The star mark stands there instead, which earns its place: it is the same
 * mark that labels joined characters out on the map.
 */

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { JOINED_MARK } from './model';
import { JoinCharacter } from './JoinCharacter';

/** An address that only ever means "the device reading it", and so is useless in a QR code. */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname);
}

/**
 * Where the phone should land.
 *
 * The order matters, because the one way this feature fails silently is a QR code holding an
 * address the phone cannot reach:
 *  1. VITE_JOIN_URL, when a display is pointed at another host deliberately.
 *  2. The page's own origin -- correct in production, where the display is on a real hostname and
 *     the dashboard serves both itself and map.html, so /join is a sibling of this page.
 *  3. In development the origin is `localhost`, which to a phone means the phone. The dev server
 *     supplies this machine's LAN host (see joinHost() in web/vite.config.ts), and the port and
 *     protocol come from this page -- the display is served by the very server the phone needs.
 */
export function joinUrl(): string {
  const configured = import.meta.env.VITE_JOIN_URL as string | undefined;
  if (configured) return configured;
  const { protocol, hostname, port } = window.location;
  const lanHost = import.meta.env.VITE_JOIN_HOST as string | undefined;
  if (lanHost && isLoopback(hostname)) return `${protocol}//${lanHost}${port ? `:${port}` : ''}/join`;
  return `${window.location.origin}/join`;
}

/** True when this code cannot be scanned from another device, whatever it says on the card. */
export function joinUrlIsReachable(url: string): boolean {
  try {
    return !isLoopback(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function JoinQrCard({ url = joinUrl() }: { url?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // A loopback code is worth saying out loud: it looks exactly like a working one on the display,
  // and the only symptom is every phone in the room failing to load the page.
  const reachable = joinUrlIsReachable(url);

  // Once per URL. The code is a 360px PNG scaled down to 120, so it stays crisp on a big display.
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

  return (
    <section className="join-card" aria-labelledby="join-card-title">
      <div className="join-qr">
        {src && <img src={src} alt={`QR code linking to ${url}`} width={120} height={120} />}
        {failed && (
          <span className="join-qr-fallback" role="alert">
            Code unavailable
          </span>
        )}
      </div>
      {/* A real character, because the card is asking for one. */}
      <JoinCharacter />

      <div className="join-card-body">
        <span className="join-card-mark" aria-hidden="true">
          {JOINED_MARK}
        </span>
        <p className="join-card-title" id="join-card-title">
          Put yourself on the map
        </p>
        {/* One line: the card is now sized by its code, and a second sentence
            overflowed it onto the map. What the character then does is the
            thing the map itself shows. */}
        <p className="join-card-note">
          {reachable ? 'Scan to build your character' : 'Local address: set VITE_JOIN_URL to scan'}
        </p>
        <p className="join-card-url">{url.replace(/^https?:\/\//, '')}</p>
      </div>
    </section>
  );
}
