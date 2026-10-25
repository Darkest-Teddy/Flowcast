/*
 * The what-if's area, drawn on the map and dragged there.
 *
 * A scenario used to pick one building from a dropdown, which is not how any of
 * these things work: a fire alarm empties its neighbours, an earthquake does not
 * stop at a property line, and a sell-out crowd at Fenway arrives across a whole
 * district. So a what-if is a centre and a radius, and the radius is set by
 * dragging a handle on the map rather than by typing a number into a form.
 *
 * The circle is drawn as a projected polygon, not an SVG circle. On a pitched 3D
 * view a circle on the ground is an ellipse on screen, and a screen-space circle
 * would promise an area the simulation is not using. Forty-eight points around
 * the real ground circle, each projected through the map's own projection, is
 * the shape the engine actually means.
 */

import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { Projector } from './layers/placement';

/** Mean Earth radius, for offsetting a lng/lat by metres. */
const EARTH = 6378137;
const POINTS = 48;

export interface WhatIfCircleFrame {
  centre: [number, number] | null;
  radiusMetres: number;
  /** The scenario's hue, as "r, g, b". */
  rgb: string;
  /** What is at the centre, named on the map beside the dot. */
  centreName: string | null;
  project: Projector;
}

export interface WhatIfCircleHandle {
  update(frame: WhatIfCircleFrame): void;
}

/** A point `metres` from `centre` at `bearing` radians clockwise from north. */
function offset(centre: [number, number], metres: number, bearing: number): [number, number] {
  const [lng, lat] = centre;
  const dLat = (metres * Math.cos(bearing)) / EARTH;
  const dLng = (metres * Math.sin(bearing)) / (EARTH * Math.cos((lat * Math.PI) / 180));
  return [lng + (dLng * 180) / Math.PI, lat + (dLat * 180) / Math.PI];
}

export function WhatIfCircle({
  ref,
  onRadius,
  onDragEnd,
}: {
  ref: Ref<WhatIfCircleHandle>;
  /** Live, while dragging: the pointer's distance from the centre, in metres. */
  onRadius: (metres: number) => void;
  onDragEnd: () => void;
}) {
  const rootRef = useRef<SVGSVGElement>(null);
  const polyRef = useRef<SVGPolygonElement>(null);
  const hitRef = useRef<SVGPolygonElement>(null);
  const handleRef = useRef<SVGCircleElement>(null);
  const labelRef = useRef<SVGGElement>(null);
  const onRadiusRef = useRef(onRadius);
  onRadiusRef.current = onRadius;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;

  // The latest frame, so a pointer move can convert px back to metres without
  // the component re-rendering (it never does; everything here is imperative).
  const frame = useRef<WhatIfCircleFrame | null>(null);
  const dragging = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      update(next) {
        frame.current = next;
        const svg = rootRef.current;
        const poly = polyRef.current;
        const handle = handleRef.current;
        const label = labelRef.current;
        if (!svg || !poly || !handle || !label) return;

        if (!next.centre || next.radiusMetres <= 0) {
          svg.style.display = 'none';
          return;
        }
        svg.style.display = '';
        /*
         * Painted from here rather than through a CSS custom property.
         *
         * SVG fill and stroke took the property inconsistently, and a var() that
         * fails to resolve makes the declaration invalid, which for `fill` means
         * black: the ring came out as an opaque black disc over the campus. Real
         * colour strings cannot fail that way.
         */
        poly.style.fill = `rgba(${next.rgb}, 0.07)`;
        poly.style.stroke = `rgb(${next.rgb})`;
        handle.style.stroke = `rgb(${next.rgb})`;
        const rect = label.querySelector('rect');
        if (rect) rect.style.stroke = `rgba(${next.rgb}, 0.5)`;

        let east: [number, number] = [0, 0];
        const points: string[] = [];
        for (let i = 0; i < POINTS; i++) {
          const bearing = (i / POINTS) * Math.PI * 2;
          const [x, y] = next.project(offset(next.centre, next.radiusMetres, bearing));
          points.push(`${Math.round(x)},${Math.round(y)}`);
          // Bearing π/2 is due east, where the handle sits.
          if (i === Math.round(POINTS / 4)) east = [x, y];
        }
        poly.setAttribute('points', points.join(' '));
        hitRef.current?.setAttribute('points', points.join(' '));

        const [cx, cy] = next.project(next.centre);
        handle.setAttribute('cx', String(east[0]));
        handle.setAttribute('cy', String(east[1]));
        label.setAttribute('transform', `translate(${east[0]}, ${east[1] + 26})`);
        const text = label.querySelector('text');
        if (text) {
          text.textContent = next.radiusMetres >= 1000
            ? `${(next.radiusMetres / 1000).toFixed(1)} km`
            : `${Math.round(next.radiusMetres)} m`;
        }
        const dot = svg.querySelector('.wi-centre') as SVGCircleElement | null;
        if (dot) {
          dot.setAttribute('cx', String(cx));
          dot.setAttribute('cy', String(cy));
          dot.style.fill = `rgb(${next.rgb})`;
        }

        /*
         * The centre, named. The panel says what it is, but the panel is on the
         * other side of the screen from the dot, and for a fixed centre like
         * Fenway the name is the only thing that explains why the circle is
         * where it is.
         */
        const name = svg.querySelector('.wi-centre-name') as SVGTextElement | null;
        if (name) {
          name.textContent = next.centreName ?? '';
          name.setAttribute('x', String(cx));
          name.setAttribute('y', String(cy - 14));
        }
      },
    }),
    [],
  );

  /*
   * Dragging. The pointer is captured on the handle so the gesture survives
   * leaving it, and every event is stopped so the map underneath never pans:
   * dragging the handle and dragging the map are the same gesture otherwise.
   */
  useEffect(() => {
    const svg = rootRef.current;
    const handle = handleRef.current;
    if (!svg || !handle) return;

    const radiusAt = (clientX: number, clientY: number): number | null => {
      const f = frame.current;
      const svg = rootRef.current;
      if (!f?.centre || !svg) return null;
      const box = svg.getBoundingClientRect();
      const px = clientX - box.left;
      const py = clientY - box.top;
      const [cx, cy] = f.project(f.centre);
      // Convert the pointer's pixel distance back to metres using the scale at
      // this centre and zoom: one metre east, measured in pixels.
      const [ex, ey] = f.project(offset(f.centre, 100, Math.PI / 2));
      const pxPer100m = Math.hypot(ex - cx, ey - cy) || 1;
      return (Math.hypot(px - cx, py - cy) / pxPer100m) * 100;
    };

    /*
     * The gesture, shared by the handle and the ring.
     *
     * Capture goes on the handle whichever of them started it, so the pointer
     * can leave the 24px dot and keep dragging; without it the gesture dies the
     * moment you move faster than the circle follows. Every event is stopped so
     * the map underneath never pans: dragging the edge and dragging the map are
     * otherwise the same gesture.
     */
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragging.current = true;
      svg.classList.add('is-dragging');
      handle.setPointerCapture(e.pointerId);
      // Jump to where the press landed, so a click on the ring sets the radius
      // as well as starting a drag from it.
      const metres = radiusAt(e.clientX, e.clientY);
      if (metres !== null) onRadiusRef.current(metres);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      e.preventDefault();
      e.stopPropagation();
      const metres = radiusAt(e.clientX, e.clientY);
      if (metres !== null) onRadiusRef.current(metres);
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      svg.classList.remove('is-dragging');
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      onDragEndRef.current();
    };

    // The ring is the discoverable one: a dashed circle you can grab anywhere
    // reads as resizable, where a lone dot on its east edge has to be found.
    const grips = [handle, polyRef.current, hitRef.current].filter(Boolean) as Element[];
    for (const el of grips) el.addEventListener('pointerdown', onDown as EventListener);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    return () => {
      for (const el of grips) el.removeEventListener('pointerdown', onDown as EventListener);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
  }, []);

  return (
    <svg ref={rootRef} className="wi-circle" style={{ display: 'none' }} aria-hidden="true">
      <polygon ref={polyRef} className="wi-ring" points="" />
      {/* Invisible and wider than the dashes: a 1.5px stroke is not a hit target. */}
      <polygon ref={hitRef} className="wi-grip" points="" />
      <circle className="wi-centre" r={6} />
      <text className="wi-centre-name" textAnchor="middle" />
      <g ref={labelRef} className="wi-label">
        <rect x={-30} y={-11} width={60} height={22} rx={11} />
        <text textAnchor="middle" dominantBaseline="central" />
      </g>
      {/* Last, so it takes the pointer ahead of the ring it sits on. */}
      <circle ref={handleRef} className="wi-handle" r={12} />
    </svg>
  );
}
