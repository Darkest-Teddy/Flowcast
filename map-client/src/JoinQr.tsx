// A QR code on the live map linking to /join, the mobile-only screen where someone builds their
// own persona and drops it onto the map. Rendered client-side as inline SVG (qrcode-generator is
// a small, dependency-free encoder) rather than depending on an external QR image service.
import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** Assumes /join is served from this same origin -- true when map-client is mounted inside the
 *  combined web app (see web/README.md), not when map-client runs standalone on its own port. */
function joinUrl(): string {
  return `${window.location.origin}/join`;
}

export function JoinQr() {
  const { svg, url } = useMemo(() => {
    const url = joinUrl();
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return { svg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }), url };
  }, []);

  return (
    <section className="panel qr" aria-label="Join on your phone">
      <div className="qr-code" dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="qr-caption">
        Scan to add your own character
        <span className="qr-url">{url.replace(/^https?:\/\//, '')}</span>
      </p>
    </section>
  );
}
