/*
 * Renderer for the Kenney-based persona builder.
 *
 * Ported from the design handoff's `kenneyRender.js` with types added. The one structural rule worth
 * restating, because breaking it breaks the page: **there is a single WebGL context**. The big
 * preview and every option thumbnail are "views"; each frame the shared renderer draws a view into a
 * scissored corner of one canvas and copies that rectangle into the view's own 2D canvas. A context
 * per thumbnail would hit the browser's hard limit (~8-16) the moment a category has ten options.
 *
 * Views that are scrolled out of sight are skipped (IntersectionObserver), so a long option row
 * costs nothing until it is on screen.
 *
 * The models are the map's own: /models/character-*.glb, served by this app because its Vite config
 * points publicDir at map-client/public.
 */

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js';
import { appearanceKey, BASE_MODEL, resolve, type Appearance, type CameraId, type Part, type Sw } from '@map/persona/parts';

/* ---------------------------------------------------------------------------
 * Head rounding
 *
 * Kenney heads are cubes (skin box centred here, half-size ~0.16). We tessellate each head once,
 * then map every vertex radially from the cube onto a superellipsoid of exponent n: n = 2 is a
 * sphere, larger n is boxier. The factor depends only on direction, so hair, ears and face details
 * keep their layering over the skin.
 * ------------------------------------------------------------------------- */
const HEAD_C = [0, 0.502, -0.002] as const;
const HEAD_HALF = 0.16;

function roundedPositions(src: ArrayLike<number>, n: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i] - HEAD_C[0];
    const y = src[i + 1] - HEAD_C[1];
    const z = src[i + 2] - HEAD_C[2];
    const ax = Math.abs(x) / HEAD_HALF;
    const ay = Math.abs(y) / HEAD_HALF;
    const az = Math.abs(z) / HEAD_HALF;
    const linf = Math.max(ax, ay, az);
    const ln = Math.pow(ax ** n + ay ** n + az ** n, 1 / n);
    const s = ln > 1e-6 ? linf / ln : 1;
    out[i] = HEAD_C[0] + x * s;
    out[i + 1] = HEAD_C[1] + y * s;
    out[i + 2] = HEAD_C[2] + z * s;
  }
  return out;
}

const DEG = Math.PI / 180;

export interface CameraSpec {
  t: [number, number, number];
  az: number;
  el: number;
  half: number;
}

/** Per-category framing: hair close-up, face straight-on, bag from behind, and so on. */
export const CAMERAS: Record<CameraId, CameraSpec> = {
  full: { t: [0, 0.37, 0], az: 0, el: 8, half: 0.43 },
  stage: { t: [0, 0.43, 0], az: 0, el: 8, half: 0.78 },
  person: { t: [0, 0.37, 0], az: 18, el: 8, half: 0.43 },
  hair: { t: [0, 0.53, 0], az: 30, el: 10, half: 0.22 },
  hat: { t: [0, 0.57, 0], az: 30, el: 12, half: 0.25 },
  face: { t: [0, 0.5, 0], az: 22, el: 4, half: 0.2 },
  expression: { t: [0, 0.47, 0], az: 0, el: 2, half: 0.15 },
  top: { t: [0, 0.29, 0], az: 28, el: 8, half: 0.24 },
  bottom: { t: [0, 0.14, 0], az: 28, el: 10, half: 0.18 },
  shoes: { t: [0, 0.07, 0.01], az: 14, el: 14, half: 0.14 },
  bag: { t: [0, 0.32, 0], az: 150, el: 12, half: 0.27 },
  hand: { t: [-0.08, 0.24, 0.04], az: 40, el: 10, half: 0.27 },
};

/** What one canvas should show. `app: null` parks the view: nothing is built or drawn. */
export interface ViewSpec {
  app?: Appearance | null;
  cam?: CameraId;
  /** Auto-rotate, with drag inertia. */
  auto?: boolean;
  /** Bind pointer dragging to turn the character. */
  drag?: boolean;
  /** Draw the ground disc and shadow blob. */
  ground?: boolean;
  /** 'pose' is a single settled frame (thumbnails); 'walk' walks; anything else plays the idle loop. */
  anim?: 'loop' | 'walk' | 'pose';
}

export interface ThemeColors {
  ground: string;
  shadow: string;
  outline?: string;
}

interface PersonSource {
  gltf: GLTF;
  material: THREE.Material;
  meshes: Record<string, THREE.SkinnedMesh>;
}

interface Instance {
  obj: THREE.Object3D;
  owned: THREE.BufferGeometry[];
  mixer: THREE.AnimationMixer;
  clips: Record<string, THREE.AnimationClip>;
  base: 'idle' | 'holding-right';
  action: THREE.AnimationAction | null;
  emoteUntil: number;
}

interface View {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  spec: ViewSpec;
  angle: number;
  vel: number;
  dirty: boolean;
  visible: boolean;
  dragging: boolean;
  resumeAt: number;
  key: string | null;
  inst: Instance | null;
  token: number;
  unbind?: () => void;
}

interface RegionIndex {
  region: (string | null)[];
  bone: Int16Array;
  row: Int8Array;
  col: Int8Array;
}

export interface PersonaRenderer {
  attach(canvas: HTMLCanvasElement, spec: ViewSpec): void;
  detach(canvas: HTMLCanvasElement): void;
  emote(canvas: HTMLCanvasElement, name?: string): void;
  preload(ids: readonly string[]): Promise<unknown>;
  /** Superellipsoid exponent for heads (2 = round, ~3 = soft, 0 = original cube). Rebuilds every view. */
  setHeadShape(n: number): void;
  setOutline(width: number): void;
  setTheme(colors: ThemeColors): void;
  setAutoRotate(on: boolean): void;
  /**
   * Reduced motion: no spinning, no animation clocks, no emotes. Every view settles into a single
   * pose and only a deliberate drag turns it.
   */
  setReducedMotion(on: boolean): void;
  dispose(): void;
}

export async function createPersonaRenderer(modelsBase = '/models/'): Promise<PersonaRenderer> {
  const loader = new GLTFLoader();
  const people = new Map<string, Promise<PersonSource>>();

  async function person(id: string): Promise<PersonSource> {
    let p = people.get(id);
    if (!p) {
      p = loader.loadAsync(`${modelsBase}character-${id}.glb`).then((g) => {
        g.scene.updateMatrixWorld(true);
        let material: THREE.Material | null = null;
        const meshes: Record<string, THREE.SkinnedMesh> = {};
        g.scene.traverse((o) => {
          const mesh = o as THREE.SkinnedMesh;
          if (mesh.isSkinnedMesh) {
            material = mesh.material as THREE.Material;
            meshes[mesh.name] = mesh;
          }
        });
        const head = meshes['head-mesh'];
        if (head) {
          // Every head vertex is bound to the single head bone; rebuild that binding after
          // tessellation, which does not carry skinning attributes across.
          const bone = head.geometry.attributes.skinIndex.getX(0);
          const t = new TessellateModifier(0.03, 8).modify(head.geometry);
          const n = t.attributes.position.count;
          const si = new Uint16Array(n * 4);
          const sw = new Float32Array(n * 4);
          for (let i = 0; i < n; i++) {
            si[i * 4] = bone;
            sw[i * 4] = 1;
          }
          t.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
          t.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
          head.geometry = t;
          head.userData.rounded = new Map<number, Float32Array>();
        }
        return { gltf: g, material: material as unknown as THREE.Material, meshes };
      });
      people.set(id, p);
    }
    return p;
  }

  /* ------------------------------------------------------------------------
   * The one context.
   * ---------------------------------------------------------------------- */
  const glCanvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  let glW = 0;
  let glH = 0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.02, 20);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b8c8, 1.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  scene.add(key, key.target);

  /*
   * Inverted-hull outline in screen space (constant pixel width). Works on skinned meshes: three's
   * skinning chunks transform the smoothed normal before we push it out.
   */
  const outlineUniforms = { uWidth: { value: 3 }, uRes: { value: new THREE.Vector2(1, 1) } };
  const outlineMat = new THREE.MeshBasicMaterial({ color: 0x1d1d1f, side: THREE.BackSide });
  outlineMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, outlineUniforms);
    shader.vertexShader =
      'uniform float uWidth;\nuniform vec2 uRes;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
      vec3 oN = vec3(normal);
      #ifdef USE_SKINNING
        oN = (skinMatrix * vec4(oN, 0.0)).xyz;
      #endif
      vec2 oDir = normalize(normalMatrix * oN).xy;
      float oLen = length(oDir);
      if (oLen > 1e-4) gl_Position.xy += oDir / oLen * uWidth * 2.0 / uRes * gl_Position.w;
      gl_Position.z += 0.0015 * gl_Position.w;`,
      );
  };
  outlineMat.customProgramCacheKey = () => 'kenney-outline';
  let outlineWidth = 3;
  let headN = 3;
  let reducedMotion = false;

  /** Normals averaged across faces that share a corner, so the hull doesn't split at box edges. */
  function smoothNormals(geo: THREE.BufferGeometry): THREE.BufferAttribute {
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const n = pos.count;
    const acc = new Map<string, [number, number, number]>();
    const keys: string[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const k = `${Math.round(pos.getX(i) * 4000)},${Math.round(pos.getY(i) * 4000)},${Math.round(pos.getZ(i) * 4000)}`;
      keys[i] = k;
      let a = acc.get(k);
      if (!a) acc.set(k, (a = [0, 0, 0]));
      a[0] += nor.getX(i);
      a[1] += nor.getY(i);
      a[2] += nor.getZ(i);
    }
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = acc.get(keys[i])!;
      const l = Math.hypot(a[0], a[1], a[2]) || 1;
      out[i * 3] = a[0] / l;
      out[i * 3 + 1] = a[1] / l;
      out[i * 3 + 2] = a[2] / l;
    }
    return new THREE.BufferAttribute(out, 3);
  }

  function hullGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
    const h = new THREE.BufferGeometry();
    for (const name in geo.attributes) if (name !== 'normal') h.setAttribute(name, geo.attributes[name]);
    h.setAttribute('normal', smoothNormals(geo));
    if (geo.index) h.setIndex(geo.index);
    return h;
  }

  const holder = new THREE.Group();
  scene.add(holder);
  const ground = new THREE.Group();
  const groundMat = new THREE.MeshBasicMaterial({ color: 0xe8e8ed });
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0xc9c9cf });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.34, 48), groundMat);
  const blob = new THREE.Mesh(new THREE.CircleGeometry(0.19, 40), shadowMat);
  disc.rotation.x = -Math.PI / 2;
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.001;
  blob.scale.set(1, 0.75, 1);
  ground.add(disc, blob);
  scene.add(ground);

  const groupOf = (name: string) =>
    name === 'head' ? 'head' : name === 'torso' ? 'torso' : name.startsWith('arm') ? 'arm' : name.startsWith('leg') ? 'leg' : 'root';

  const regionCache = new Map<string, RegionIndex>();

  /** Per-vertex region for one source mesh under one piece definition (cached). */
  function regionsFor(mesh: THREE.SkinnedMesh, piece: { model: string; mesh: string; regions: Record<string, string>; head?: boolean }): RegionIndex {
    const ck = `${piece.model}:${piece.mesh}:${JSON.stringify(piece.regions)}`;
    const hit = regionCache.get(ck);
    if (hit) return hit;
    const g = mesh.geometry;
    const uv = g.attributes.uv;
    const J = g.attributes.skinIndex;
    const Wt = g.attributes.skinWeight;
    const P0 = g.attributes.position;
    const r: RegionIndex = {
      region: new Array(uv.count),
      bone: new Int16Array(uv.count),
      row: new Int8Array(uv.count),
      col: new Int8Array(uv.count),
    };
    for (let i = 0; i < uv.count; i++) {
      let bj = 0;
      let bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = Wt.getComponent(i, k);
        if (w > bw) {
          bw = w;
          bj = J.getComponent(i, k);
        }
      }
      const row = Math.floor(uv.getY(i) * 4);
      const col = Math.floor(uv.getX(i) * 16);
      const sw = `${row}.${col}`;
      const grp = groupOf(mesh.skeleton.bones[bj].name);
      r.region[i] = piece.regions[`${grp}:${sw}`] || piece.regions[`*:${sw}`] || null;
      // Eyes + mouth: flat pieces on the face plane, in the same place on every Kenney head.
      if (piece.head && (sw === '3.1' || sw === '2.15')) {
        const x = P0.getX(i);
        const y = P0.getY(i);
        const z = P0.getZ(i);
        if (Math.abs(z - 0.16) < 0.003 && y > 0.39 && y < 0.52 && Math.abs(x) < 0.125) r.region[i] = 'face';
      }
      r.bone[i] = bj;
      r.row[i] = row;
      r.col[i] = col;
    }
    regionCache.set(ck, r);
    return r;
  }

  function setSwatchUV(g: THREE.BufferGeometry, sw: Sw, grad: boolean, h = 1): void {
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    const [row, col] = sw;
    for (let i = 0; i < pos.count; i++) {
      const t = grad ? (pos.getY(i) + h / 2) / h : 0.5;
      uv.setXY(i, (col + 0.5) / 16, (row + 0.08 + 0.84 * (1 - t)) / 4);
    }
  }

  /*
   * Parts are authored in bind-pose model space; M maps that space into the bone's local frame
   * (boneInverse · bindMatrix), exactly as skinning does, so parts ride the bone like skinned verts.
   */
  function partsGeometry(parts: Part[], M: THREE.Matrix4): THREE.BufferGeometry {
    const geos = parts.map((p) => {
      let g: THREE.BufferGeometry;
      if (p.kind === 'ball' || p.kind === 'cone' || p.kind === 'cyl') {
        g =
          p.kind === 'ball'
            ? new THREE.IcosahedronGeometry(p.r, 1)
            : p.kind === 'cone'
              ? new THREE.ConeGeometry(p.r, p.h, p.seg)
              : new THREE.CylinderGeometry(p.rTop, p.r, p.h, p.seg);
        if (g.index) g = g.toNonIndexed();
        setSwatchUV(g, p.sw, false);
        const s = p.kind === 'ball' ? (p.scale3 ?? [1, 1, 1]) : p.scale3;
        g.scale(s[0], s[1], s[2]);
        if (p.rotX) g.rotateX(p.rotX);
      } else if (p.kind === 'ring') {
        g = new THREE.TorusGeometry(p.r, p.tube, 6, 22).toNonIndexed();
        setSwatchUV(g, p.sw, false);
        g.scale(p.scale[0], p.scale[1], 1);
      } else if (p.kind === 'disc') {
        g = new THREE.CylinderGeometry(p.r, p.r, p.depth, 22).toNonIndexed();
        setSwatchUV(g, p.sw, false);
        g.rotateX(Math.PI / 2);
        g.scale(p.scale[0], p.scale[1], 1);
      } else {
        g = new THREE.BoxGeometry(p.s[0], p.s[1], p.s[2]).toNonIndexed();
        setSwatchUV(g, p.sw, true, p.s[1]);
        if (p.rotX) g.rotateX(p.rotX);
      }
      if (p.rotZ) g.rotateZ(p.rotZ);
      if (p.rotY) g.rotateY(p.rotY);
      g.translate(p.c[0], p.c[1], p.c[2]);
      g.applyMatrix4(M);
      return g;
    });
    let n = 0;
    for (const g of geos) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const uvs = new Float32Array(n * 2);
    let o = 0;
    for (const g of geos) {
      pos.set(g.attributes.position.array as Float32Array, o * 3);
      nor.set(g.attributes.normal.array as Float32Array, o * 3);
      uvs.set(g.attributes.uv.array as Float32Array, o * 2);
      o += g.attributes.position.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    return out;
  }

  /** Assemble a persona: the base rig, then each piece's mesh (body, chosen head, extras) re-bound to it. */
  async function build(app: Appearance): Promise<Instance> {
    const R = resolve(app);
    const base = await person(BASE_MODEL);
    const srcs = await Promise.all(R.pieces.map((pc) => person(pc.model)));
    const obj = SkeletonUtils.clone(base.gltf.scene);
    obj.updateMatrixWorld(true);
    const owned: THREE.BufferGeometry[] = [];
    const bones: Record<string, THREE.Bone> = {};
    obj.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones[o.name] = o as THREE.Bone;
    });
    const pivots: Record<string, THREE.Vector3> = {};
    for (const n in bones) pivots[n] = new THREE.Vector3().setFromMatrixPosition(bones[n].matrixWorld);
    const rigged: THREE.SkinnedMesh[] = [];
    obj.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) rigged.push(o as THREE.SkinnedMesh);
    });
    const tpl = rigged[0];
    const parent = tpl.parent!;
    const skeleton = tpl.skeleton;
    const bindMatrix = tpl.bindMatrix;
    rigged.forEach((o) => o.parent?.remove(o));

    R.pieces.forEach((piece, pi) => {
      const src = srcs[pi].meshes[piece.mesh];
      const reg = regionsFor(src, piece as never);
      const g = src.geometry.clone();
      owned.push(g);
      if (piece.head && headN) {
        const cache = src.userData.rounded as Map<number, Float32Array>;
        let rp = cache.get(headN);
        if (!rp) {
          rp = roundedPositions(src.geometry.attributes.position.array as Float32Array, headN);
          cache.set(headN, rp);
        }
        g.setAttribute('position', new THREE.BufferAttribute(rp.slice(), 3));
      }
      const uv = g.attributes.uv;
      const pos = g.attributes.position;
      for (let i = 0; i < uv.count; i++) {
        const r = reg.region[i];
        // Hidden vertices collapse onto their bone's pivot, which costs nothing and leaves no hole.
        if (r === 'gone' || (piece.only && r !== piece.only) || (r && R.hide.includes(r as never))) {
          const pv = pivots[skeleton.bones[reg.bone[i]].name];
          pos.setXYZ(i, pv.x, pv.y, pv.z);
          continue;
        }
        if (!r) continue;
        const to = R.recolor[r as never] as Sw | undefined;
        if (to) {
          // Keep the vertex's offset within its 32px cell, so gradient columns keep their shading.
          const du = uv.getX(i) * 16 - reg.col[i];
          const dv = uv.getY(i) * 4 - reg.row[i];
          const col = to[1] % 2 === 1 && reg.col[i] % 2 === 0 ? to[1] - 1 : to[1];
          uv.setXY(i, (col + du) / 16, (to[0] + dv) / 4);
        }
        if (piece.head && r === 'hair' && R.clamp && pos.getY(i) > R.clamp) pos.setY(i, R.clamp);
      }
      if (piece.head && headN) g.setAttribute('normal', smoothNormals(g));
      const m = new THREE.SkinnedMesh(g, base.material);
      m.bind(skeleton, bindMatrix);
      m.frustumCulled = false;
      parent.add(m);
      const hg = hullGeometry(g);
      owned.push(hg);
      const hull = new THREE.SkinnedMesh(hg, outlineMat);
      hull.bind(skeleton, bindMatrix);
      hull.frustumCulled = false;
      parent.add(hull);
    });

    const byBone: Record<string, Part[]> = {};
    for (const p of R.parts) (byBone[p.bone] ||= []).push(p);
    for (const b in byBone) {
      if (!bones[b]) continue;
      const bi = skeleton.bones.findIndex((x) => x.name === b);
      const M = new THREE.Matrix4().multiplyMatrices(skeleton.boneInverses[bi], bindMatrix);
      const g = partsGeometry(byBone[b], M);
      owned.push(g);
      const m = new THREE.Mesh(g, base.material);
      m.frustumCulled = false;
      bones[b].add(m);
      const hg = hullGeometry(g);
      owned.push(hg);
      const hull = new THREE.Mesh(hg, outlineMat);
      hull.frustumCulled = false;
      bones[b].add(hull);
    }

    const mixer = new THREE.AnimationMixer(obj);
    const clips = Object.fromEntries(base.gltf.animations.map((c) => [c.name, c]));
    return { obj, owned, mixer, clips, base: R.anim, action: null, emoteUntil: 0 };
  }

  function playLoop(inst: Instance, name: string, fade = 0.25): void {
    const clip = inst.clips[name] || inst.clips.idle;
    if (!clip) return;
    const a = inst.mixer.clipAction(clip);
    if (inst.action === a) return;
    a.reset();
    a.setLoop(THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = false;
    if (inst.action) a.crossFadeFrom(inst.action, fade, false);
    a.play();
    inst.action = a;
  }

  const views = new Map<HTMLCanvasElement, View>();
  let autoRotate = true;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      const v = views.get(e.target as HTMLCanvasElement);
      if (v) {
        v.visible = e.isIntersecting;
        if (v.visible) v.dirty = true;
      }
    }
  });

  /** A view is a still frame when it asks for one, or whenever motion is reduced. */
  const isPose = (v: View) => v.spec.anim === 'pose' || reducedMotion;
  const baseAnim = (v: View) => (v.spec.anim === 'walk' ? 'walk' : v.inst!.base);

  async function ensure(v: View): Promise<void> {
    const app = v.spec.app;
    if (!app) return;
    const k = appearanceKey(app);
    if (v.key === k) return;
    v.key = k;
    const token = (v.token = v.token + 1);
    const inst = await build(app);
    // The look changed again while this was building, or the view was detached: throw it away.
    if (token !== v.token || !views.has(v.canvas)) {
      inst.owned.forEach((g) => g.dispose());
      return;
    }
    if (v.inst) v.inst.owned.forEach((g) => g.dispose());
    v.inst = inst;
    playLoop(inst, baseAnim(v), 0);
    // A thumbnail settles into its pose; a live view starts at the top of its loop.
    inst.mixer.update(isPose(v) ? 0.35 : 0.001);
    v.dirty = true;
    drawNow(v);
  }

  function bindDrag(v: View): void {
    const c = v.canvas;
    let lx = 0;
    let lt = 0;
    const down = (e: PointerEvent) => {
      v.dragging = true;
      lx = e.clientX;
      lt = performance.now();
      v.vel = 0;
      c.setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!v.dragging) return;
      const now = performance.now();
      const dx = e.clientX - lx;
      v.angle += dx * 0.012;
      v.vel = ((dx * 0.012) / Math.max(1, now - lt)) * 16;
      lx = e.clientX;
      lt = now;
      v.dirty = true;
    };
    const up = () => {
      if (!v.dragging) return;
      v.dragging = false;
      v.resumeAt = performance.now() + 1400;
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.style.touchAction = 'pan-y';
    c.style.cursor = 'grab';
    v.unbind = () => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
    };
  }

  const tmp = new THREE.Vector3();

  function draw(v: View): boolean {
    const c = v.canvas;
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    if (!cw || !ch || !v.inst) return false;
    const w = Math.round(cw * dpr);
    const h = Math.round(ch * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    // The shared buffer only ever grows, to the largest view seen.
    if (w > glW || h > glH) {
      glW = Math.max(glW, w);
      glH = Math.max(glH, h);
      renderer.setSize(glW, glH, false);
    }
    const cam = CAMERAS[v.spec.cam ?? 'full'];
    const t = cam.t;
    const aspect = w / h;
    const half = Math.max(cam.half, (cam.half * 0.82) / aspect);
    const dist = half / Math.tan(13 * DEG);
    camera.aspect = aspect;
    camera.position.set(t[0], t[1] + Math.sin(cam.el * DEG) * dist, t[2] + Math.cos(cam.el * DEG) * dist);
    camera.updateProjectionMatrix();
    camera.lookAt(t[0], t[1], t[2]);
    camera.updateMatrixWorld();
    key.position.copy(camera.localToWorld(tmp.set(-1.2, 1.8, 0.6)));
    key.target.position.set(t[0], t[1], t[2]);
    holder.clear();
    holder.add(v.inst.obj);
    v.inst.obj.rotation.y = v.angle;
    ground.visible = !!v.spec.ground;
    outlineUniforms.uRes.value.set(w, h);
    outlineUniforms.uWidth.value = outlineWidth * dpr * (cw < 160 ? 0.75 : 1);
    renderer.setViewport(0, 0, w, h);
    renderer.setScissor(0, 0, w, h);
    renderer.setScissorTest(true);
    renderer.clear();
    renderer.render(scene, camera);
    // Copy this view's corner of the shared buffer into its own 2D canvas.
    v.ctx.clearRect(0, 0, w, h);
    v.ctx.drawImage(glCanvas, 0, glH - h, w, h, 0, 0, w, h);
    return true;
  }

  function drawNow(v: View): void {
    try {
      if (draw(v)) v.dirty = false;
    } catch (e) {
      console.error('[persona] draw', e);
    }
  }

  function attach(canvas: HTMLCanvasElement, spec: ViewSpec): void {
    let v = views.get(canvas);
    if (!v) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      v = {
        canvas,
        ctx,
        spec,
        angle: CAMERAS[spec.cam ?? 'full'].az * DEG,
        vel: 0,
        dirty: true,
        visible: true,
        dragging: false,
        resumeAt: 0,
        key: null,
        inst: null,
        token: 0,
      };
      views.set(canvas, v);
      io.observe(canvas);
    }
    const prev = v.spec;
    if (prev.cam !== spec.cam && !spec.auto) v.angle = CAMERAS[spec.cam ?? 'full'].az * DEG;
    v.spec = spec;
    if (spec.drag && !v.unbind) bindDrag(v);
    if (v.inst && prev.anim !== spec.anim) playLoop(v.inst, baseAnim(v));
    if (prev.ground !== spec.ground || prev.cam !== spec.cam) v.dirty = true;
    void ensure(v);
    if (v.dirty && v.inst) drawNow(v);
  }

  function detach(canvas: HTMLCanvasElement): void {
    const v = views.get(canvas);
    if (!v) return;
    v.unbind?.();
    io.unobserve(canvas);
    views.delete(canvas);
    if (v.inst) v.inst.owned.forEach((g) => g.dispose());
  }

  /** Play a one-shot clip (e.g. 'emote-yes') on a view, then settle back into its loop. */
  function emote(canvas: HTMLCanvasElement, name = 'emote-yes'): void {
    if (reducedMotion) return;
    const v = views.get(canvas);
    if (!v || !v.inst || !v.inst.clips[name]) return;
    const inst = v.inst;
    const a = inst.mixer.clipAction(inst.clips[name]);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = false;
    if (inst.action && inst.action !== a) a.crossFadeFrom(inst.action, 0.12, false);
    a.play();
    inst.action = a;
    inst.emoteUntil = performance.now() + inst.clips[name].duration * 1000 - 150;
  }

  let last = performance.now();
  let running = true;

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const v of views.values()) {
      if (!v.visible || !v.canvas.isConnected || !v.inst) continue;
      let need = v.dirty;
      if (!isPose(v)) {
        if (v.inst.emoteUntil && now > v.inst.emoteUntil) {
          v.inst.emoteUntil = 0;
          playLoop(v.inst, baseAnim(v), 0.2);
        }
        v.inst.mixer.update(dt);
        need = true;
      }
      if (v.spec.auto && !v.dragging) {
        // Drag inertia first; the idle spin only resumes 1.4s after a release.
        if (Math.abs(v.vel) > 0.0005) {
          v.angle += v.vel;
          v.vel *= 0.92;
          need = true;
        } else if (autoRotate && !reducedMotion && now > v.resumeAt) {
          v.angle += dt * 0.5;
          need = true;
        }
      }
      if (need) drawNow(v);
    }
    schedule();
  }

  function schedule(): void {
    if (!running) return;
    let done = false;
    const run = () => {
      if (!done) {
        done = true;
        frame(performance.now());
      }
    };
    // rAF plus a timeout: a backgrounded tab stops the former, and a stalled view must still settle.
    requestAnimationFrame(run);
    window.setTimeout(run, 60);
  }
  schedule();

  return {
    attach,
    detach,
    emote,
    preload: (ids) => Promise.all(ids.map((id) => person(id))),
    setHeadShape(n) {
      if (n === headN) return;
      headN = n;
      for (const v of views.values()) {
        v.key = null;
        void ensure(v);
      }
    },
    setOutline(width) {
      outlineWidth = width;
      for (const v of views.values()) {
        v.dirty = true;
        if (v.visible) drawNow(v);
      }
    },
    setTheme({ ground: gc, shadow, outline }) {
      groundMat.color.set(gc);
      shadowMat.color.set(shadow);
      if (outline) outlineMat.color.set(outline);
      for (const v of views.values()) {
        v.dirty = true;
        if (v.visible) drawNow(v);
      }
    },
    setAutoRotate(on) {
      autoRotate = on;
    },
    setReducedMotion(on) {
      if (reducedMotion === on) return;
      reducedMotion = on;
      for (const v of views.values()) {
        v.dirty = true;
        if (v.visible) drawNow(v);
      }
    },
    dispose() {
      running = false;
      for (const canvas of [...views.keys()]) detach(canvas);
      io.disconnect();
      renderer.dispose();
    },
  };
}
