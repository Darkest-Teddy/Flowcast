// A panic clip for the Kenney characters, built at load time.
//
// Kenney's rig ships walk, sprint, idle, crouch and the rest, but nothing that reads as frightened,
// and a character on the map is about 20 px tall: fear has to be legible from a long way out. So
// this appends one more glTF animation, `panic`, to each character — arms thrown over the head and
// waving, the body turning as they look about them, a frantic little hop — built the same way
// gltf-merge.ts merges the meshes: a new buffer, bufferViews and accessors appended to the parsed
// glTF before it reaches the GPU. ScenegraphLayer then plays it by name like one of Kenney's own.
//
// The rig is seven nodes (root, torso, head, two arms, two legs) with rest rotations of identity:
// arms out level with the shoulders, legs straight down. So every pose below is one or two axis
// rotations off the rest pose, in degrees:
//   arm-left Z   +90 straight up, 0 straight out, -90 straight down (Kenney's idle sits at -45)
//   arm-right Z  mirrored: -90 is up
//   torso/head X positive leans forward (Kenney's crouch sits at +11)
//   head Y       turns the head, root Y turns the whole body on the spot
//   leg X        positive swings the leg forward

interface Accessor {
  bufferView: number;
  byteOffset: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}
interface Sampler { input: number; output: number; interpolation: string }
interface Channel { sampler: number; target: { node: number; path: 'rotation' | 'translation' } }
interface GltfJson {
  buffers: { byteLength: number }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; target?: number }[];
  accessors: unknown[];
  nodes: { name?: string }[];
  animations?: { name?: string; samplers: Sampler[]; channels: Channel[] }[];
}
interface LoadedGltf {
  json: GltfJson;
  buffers: { arrayBuffer: ArrayBuffer; byteOffset?: number; byteLength: number }[];
}

const FLOAT = 5126;

/** Name of the appended clip, as `_animations` and layers/agents.ts refer to it. */
export const PANIC_CLIP = 'panic';
/** Length of one loop of the clip (seconds); two waves of the arms and one look around. */
export const PANIC_CYCLE_SECONDS = 0.6;
/** Keyframe spacing; the clip is all smooth sine motion, so 20 fps is plenty at this size. */
const FRAME_SECONDS = 0.05;

type Quaternion = [number, number, number, number];

function turn(axis: 0 | 1 | 2, degrees: number): Quaternion {
  const half = (degrees * Math.PI) / 360;
  const q: Quaternion = [0, 0, 0, Math.cos(half)];
  q[axis] = Math.sin(half);
  return q;
}

function compose(a: Quaternion, b: Quaternion): Quaternion {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

const X = 0, Y = 1, Z = 2;
// Two waves of the arms per look around, so the cycle never settles into a single beat.
const wave = (f: number, offset = 0) => Math.sin(4 * Math.PI * f + offset);
const look = (f: number, offset = 0) => Math.sin(2 * Math.PI * f + offset);

/** The pose of each bone a fraction `f` through the cycle. Periodic in f, so the loop is seamless. */
const POSE: Record<string, (f: number) => Quaternion> = {
  // Turning on the spot: the clearest sign of alarm from above, where the arms foreshorten.
  root: (f) => turn(Y, 17 * look(f)),
  torso: (f) => turn(X, 9 + 5 * wave(f)),
  head: (f) => compose(turn(Y, 15 * look(f, 1.1)), turn(X, -13 + 6 * wave(f))),
  // Over the head and past vertical, the two arms a little out of step with each other.
  'arm-left': (f) => turn(Z, 118 + 22 * wave(f)),
  'arm-right': (f) => turn(Z, -(118 + 22 * wave(f, 1.9))),
  'leg-left': (f) => turn(X, 11 * wave(f)),
  'leg-right': (f) => turn(X, -11 * wave(f)),
};
/** Hopping on the spot, twice a cycle, in model units (a character is ~0.78 units tall). */
const hopAt = (f: number) => Math.max(0, wave(f)) * 0.016;

/**
 * Appends the `panic` clip to a parsed character glTF, in place. Anything that isn't the Kenney
 * rig (every bone below, by name) is returned untouched, as is a model that already has the clip.
 */
export function addPanicClip<T>(loaded: T): T {
  const gltf = loaded as unknown as LoadedGltf;
  const json = gltf?.json;
  if (!json?.nodes || !json.accessors || !json.bufferViews || !json.buffers || !gltf.buffers) return loaded;
  if (json.animations?.some((animation) => animation.name === PANIC_CLIP)) return loaded;
  if (gltf.buffers.length !== json.buffers.length) return loaded;
  const bones = Object.keys(POSE).map((name) => ({ name, node: json.nodes.findIndex((node) => node.name === name) }));
  if (bones.some((bone) => bone.node < 0)) return loaded;

  const frames = Math.round(PANIC_CYCLE_SECONDS / FRAME_SECONDS);
  const times = new Float32Array(frames + 1);
  for (let k = 0; k <= frames; k++) times[k] = k * FRAME_SECONDS;
  const tracks: { node: number; path: 'rotation' | 'translation'; values: Float32Array }[] = [];
  for (const bone of bones) {
    const values = new Float32Array((frames + 1) * 4);
    for (let k = 0; k <= frames; k++) values.set(POSE[bone.name](k / frames), k * 4);
    tracks.push({ node: bone.node, path: 'rotation', values });
  }
  const hop = new Float32Array((frames + 1) * 3);
  for (let k = 0; k <= frames; k++) hop[k * 3 + 1] = hopAt(k / frames);
  tracks.push({ node: bones.find((bone) => bone.name === 'root')!.node, path: 'translation', values: hop });

  // One new binary buffer holding the keyframe times and every track, back to back. Float arrays
  // are already 4-byte aligned, so no padding is needed between them.
  const chunks = [times, ...tracks.map((track) => track.values)];
  const offsets: number[] = [];
  let size = 0;
  for (const chunk of chunks) {
    offsets.push(size);
    size += chunk.byteLength;
  }
  const data = new Uint8Array(size);
  chunks.forEach((chunk, i) => data.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offsets[i]));
  const buffer = gltf.buffers.length;
  gltf.buffers.push({ arrayBuffer: data.buffer, byteOffset: 0, byteLength: size });
  json.buffers.push({ byteLength: size });
  const view = (i: number) => json.bufferViews.push({ buffer, byteOffset: offsets[i], byteLength: chunks[i].byteLength }) - 1;
  const accessor = (a: Accessor) => json.accessors.push(a) - 1;
  // One input accessor for the keyframe times, shared by every sampler.
  const input = accessor({ bufferView: view(0), byteOffset: 0, componentType: FLOAT, count: times.length, type: 'SCALAR',
    min: [times[0]], max: [times[times.length - 1]] });
  const samplers = tracks.map((track, i) => ({
    input,
    output: accessor({ bufferView: view(i + 1), byteOffset: 0, componentType: FLOAT, count: times.length,
      type: track.path === 'rotation' ? 'VEC4' : 'VEC3' }),
    interpolation: 'LINEAR',
  }));
  (json.animations ??= []).push({
    name: PANIC_CLIP,
    samplers,
    channels: tracks.map((track, i) => ({ sampler: i, target: { node: track.node, path: track.path } })),
  });
  return loaded;
}
