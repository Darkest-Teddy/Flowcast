// Real Three.js rendering for /join: a continuously-rotating assembled-character viewport, and
// small live-rendered thumbnails for the picker grid. Each is its own <canvas> + renderer; only
// the active tab's ~3-4 thumbnails are ever mounted at once (switching tabs unmounts the rest,
// which stops their render loops via the cleanup below), so this never runs more than a handful of
// tiny WebGL contexts at a time -- nowhere near typical per-page/browser limits.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { buildPersonaGroup } from '../../lib/personaMeshes';
import type { PartLayer } from '@map/sim/personaParts';

type ResolvedLayer = { category: string; optionId: string; layerIndex: number; layer: PartLayer };

function frameGroup(group: THREE.Group): { center: THREE.Vector3; radius: number } {
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return { center: new THREE.Vector3(0, 0.3, 0), radius: 0.5 };
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  return { center, radius: Math.max(size.x, size.y, size.z) / 2 || 0.3 };
}

function useThreeViewport(resolved: ResolvedLayer[], autoRotate: boolean, pixelSize: number) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 20);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(pixelSize, pixelSize);
    el.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(1.2, 2, 1.5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xaad4ff, 0.35);
    rim.position.set(-1.5, 0.8, -1);
    scene.add(rim);

    const group = buildPersonaGroup(resolved);
    scene.add(group);
    const { center, radius } = frameGroup(group);
    group.position.sub(center);
    camera.position.set(0, radius * 0.25, radius * 3.1);
    camera.lookAt(0, 0, 0);

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    const tick = () => {
      if (autoRotate && !reduceMotion) group.rotation.y += 0.012;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) (obj.material as THREE.Material).dispose();
      });
      el.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(resolved.map((r) => `${r.category}:${r.optionId}:${r.layerIndex}`)), autoRotate, pixelSize]);

  return containerRef;
}

/** The big, continuously-rotating assembled-character preview. */
export function PersonaViewport({ resolved, size = 180 }: { resolved: ResolvedLayer[]; size?: number }) {
  const ref = useThreeViewport(resolved, true, size);
  return <div ref={ref} style={{ width: size, height: size }} aria-label="Character preview, rotating" role="img" />;
}

/** A small static-angle (slow auto-rotate too, so it still reads as "real 3D" rather than a flat
 * icon) live render of one option's own geometry, for the picker grid. */
export function PartThumbnail({ resolved, size = 72 }: { resolved: ResolvedLayer[]; size?: number }) {
  const ref = useThreeViewport(resolved, true, size);
  return <div ref={ref} style={{ width: size, height: size }} aria-hidden />;
}
