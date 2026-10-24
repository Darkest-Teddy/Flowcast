import { WebMercatorViewport } from '@deck.gl/core';
import type { CameraState } from '../map/basemap';
import type { Projector } from '../layers/placement';

/** Fixed-place anchors can reuse their projections while the camera and source snapshot stand still. */
export class TagProjection<T> {
  private key = '';
  private source: readonly T[] | null = null;
  private revision: unknown;
  private anchors = new Map<T, [number, number]>();

  private readonly margin: number;
  constructor(margin: number) { this.margin = margin; }

  get(items: readonly T[], camera: CameraState, width: number, height: number, project: Projector,
    position: (item: T) => readonly [number, number, number], revision?: unknown,
    minZoom?: (item: T) => number): Map<T, [number, number]> {
    // CameraState omits map padding. Its projected center detects padding-only movements too.
    const center = project(camera.center);
    const key = [width, height, ...camera.center, camera.zoom, camera.pitch, camera.bearing, ...center].join(',');
    if (key === this.key && items === this.source && revision === this.revision) return this.anchors;
    const viewport = new WebMercatorViewport({ width, height, longitude: camera.center[0], latitude: camera.center[1], zoom: camera.zoom, pitch: camera.pitch, bearing: camera.bearing });
    const anchors = new Map<T, [number, number]>();
    for (const item of items) {
      if (minZoom && camera.zoom < minZoom(item)) continue;
      const [lng, lat, z] = position(item);
      const [gx, gy] = project([lng, lat]);
      const [ax, ay] = viewport.project([lng, lat, 0]);
      const [rx, ry] = viewport.project([lng, lat, z]);
      const x = gx + rx - ax, y = gy + ry - ay;
      if (x > -this.margin && x < width + this.margin && y > -this.margin && y < height + this.margin) anchors.set(item, [x, y]);
    }
    this.key = key; this.source = items; this.revision = revision; this.anchors = anchors;
    return anchors;
  }
}
