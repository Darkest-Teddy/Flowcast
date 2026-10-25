// The panic clip appended to each character at load time (layers/gltf-panic.ts), and who plays it
// (layers/panic.ts): a fire's evacuees for their first while in the crowd outside, and bystanders
// standing near a meteor or an earthquake just after it happens.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { addPanicClip, PANIC_CLIP, PANIC_CYCLE_SECONDS } = await import('../src/layers/gltf-panic.ts');
const { panickingIds, PANIC_SECONDS } = await import('../src/layers/panic.ts');
const { waitingRiderLayers } = await import('../src/layers/waitingRiders.ts');

const BONES = ['root', 'leg-left', 'leg-right', 'torso', 'arm-left', 'arm-right', 'head'];
/** A stand-in for a parsed Kenney character: the same rig node names, one empty buffer. */
function character(names = BONES) {
  return {
    json: {
      buffers: [{ byteLength: 0 }],
      bufferViews: [],
      accessors: [],
      nodes: names.map((name) => ({ name })),
    },
    buffers: [{ arrayBuffer: new ArrayBuffer(0), byteOffset: 0, byteLength: 0 }],
  };
}
/** Reads a float accessor back out of the appended buffer, as loaders.gl would. */
function valuesOf(gltf, index) {
  const accessor = gltf.json.accessors[index];
  const view = gltf.json.bufferViews[accessor.bufferView];
  const buffer = gltf.buffers[view.buffer];
  const components = { SCALAR: 1, VEC3: 3, VEC4: 4 }[accessor.type];
  const floats = new Float32Array(buffer.arrayBuffer, (buffer.byteOffset ?? 0) + (view.byteOffset ?? 0), accessor.count * components);
  const out = [];
  for (let i = 0; i < floats.length; i += components) out.push([...floats.slice(i, i + components)]);
  return out;
}

test('the panic clip is appended as a well-formed glTF animation of the Kenney rig', () => {
  const gltf = addPanicClip(character());
  const clip = gltf.json.animations.find((animation) => animation.name === PANIC_CLIP);
  assert.ok(clip, 'the clip is appended under its name');
  // Every bone is driven, and the root both turns and hops.
  const driven = clip.channels.map((channel) => `${gltf.json.nodes[channel.target.node].name}:${channel.target.path}`);
  for (const bone of BONES) assert.ok(driven.includes(`${bone}:rotation`), `${bone} is animated`);
  assert.ok(driven.includes('root:translation'), 'the hop is on the root');
  assert.equal(new Set(driven).size, driven.length, 'no node and path is targeted twice');
  // Samplers point at real accessors, inside the one appended buffer.
  for (const sampler of clip.samplers) {
    for (const index of [sampler.input, sampler.output]) {
      const accessor = gltf.json.accessors[index];
      assert.ok(accessor, `accessor ${index} exists`);
      const view = gltf.json.bufferViews[accessor.bufferView];
      const buffer = gltf.buffers[view.buffer];
      assert.ok(buffer, 'the bufferView points at a loaded buffer');
      assert.ok((view.byteOffset ?? 0) + view.byteLength <= buffer.byteLength, 'the bufferView stays inside the buffer');
      assert.equal(view.target, undefined, 'keyframes are not vertex data');
    }
  }
  assert.equal(gltf.json.buffers.length, gltf.buffers.length, 'the json and binary buffer lists stay in step');
});

test('the clip loops seamlessly over one cycle, with the arms over the head', () => {
  const gltf = addPanicClip(character());
  const clip = gltf.json.animations.find((animation) => animation.name === PANIC_CLIP);
  const times = valuesOf(gltf, clip.samplers[0].input).map(([t]) => t);
  assert.equal(times[0], 0);
  assert.ok(Math.abs(times.at(-1) - PANIC_CYCLE_SECONDS) < 1e-6, `clip runs to ${times.at(-1)}`);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], 'keyframe times increase');
  // Every sampler shares the one input accessor, and declares the range the spec requires.
  const input = gltf.json.accessors[clip.samplers[0].input];
  assert.deepEqual([input.min, input.max], [[0], [times.at(-1)]]);
  assert.ok(clip.samplers.every((sampler) => sampler.input === clip.samplers[0].input));
  for (const [i, channel] of clip.channels.entries()) {
    const frames = valuesOf(gltf, clip.samplers[channel.sampler].output);
    const name = gltf.json.nodes[channel.target.node].name;
    assert.equal(frames.length, times.length, `${name} has a value per keyframe`);
    // First and last frame match, so the loop has no jump.
    for (const [k, value] of frames[0].entries()) {
      assert.ok(Math.abs(value - frames.at(-1)[k]) < 1e-6, `${name}.${channel.target.path} loops (${value} vs ${frames.at(-1)[k]})`);
    }
    if (channel.target.path === 'rotation') {
      for (const q of frames) assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-5, `${name} rotation ${i} is a unit quaternion`);
    }
    // The hop never sinks the character through the ground.
    if (channel.target.path === 'translation') {
      assert.ok(frames.every(([x, y, z]) => x === 0 && z === 0 && y >= 0), 'the hop is straight up');
      assert.ok(frames.some(([, y]) => y > 0.005), 'the hop actually leaves the ground');
    }
  }
  // Arms raised past horizontal the whole way through: a Z turn beyond 90 degrees, mirrored.
  for (const side of ['arm-left', 'arm-right']) {
    const node = gltf.json.nodes.findIndex((n) => n.name === side);
    const channel = clip.channels.find((c) => c.target.node === node && c.target.path === 'rotation');
    for (const [x, y, z, w] of valuesOf(gltf, clip.samplers[channel.sampler].output)) {
      const degrees = 2 * Math.atan2(z, w) * (180 / Math.PI);
      assert.ok(Math.abs(degrees) > 90, `${side} is over the head (${degrees} degrees)`);
      assert.equal(Math.sign(degrees), side === 'arm-left' ? 1 : -1, `${side} is raised, not lowered`);
      assert.ok(Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6, `${side} turns about Z only`);
    }
  }
});

test('appending is idempotent, and anything that is not the Kenney rig is left alone', () => {
  const gltf = addPanicClip(character());
  const once = JSON.stringify(gltf.json);
  addPanicClip(gltf);
  assert.equal(JSON.stringify(gltf.json), once, 'a second pass changes nothing');
  assert.equal(gltf.json.animations.filter((a) => a.name === PANIC_CLIP).length, 1);
  // A model without the rig (or without buffers at all) is returned untouched.
  const other = character(['Bone', 'Bone_001']);
  assert.equal(addPanicClip(other).json.animations, undefined);
  assert.deepEqual(addPanicClip({}), {});
});

const RUN = { incident: { kind: 'fire', start: 1000 }, location: { position: [-71, 42] }, participants: [], crowd: {} };
const at = (lng) => ({ id: `p${lng}`, position: [lng, 42, 0] });

test('a fire frightens its evacuees for a while after they reach the crowd, then they settle', () => {
  const run = { ...RUN, participants: [{ agentId: 'a', assemblyAt: 1200 }, { agentId: 'b', assemblyAt: 1500 }] };
  const standing = [{ id: 'a', position: [-71, 42, 0] }, { id: 'b', position: [-71, 42, 0] }];
  assert.deepEqual([...panickingIds(run, 1199, standing)], [], 'not before they get there');
  assert.deepEqual([...panickingIds(run, 1250, standing)], ['a'], 'a is out, b is still coming');
  assert.deepEqual([...panickingIds(run, 1550, standing)], ['b'], 'a has settled, b has just arrived');
  assert.deepEqual([...panickingIds(run, 1200 + PANIC_SECONDS, standing)], [], 'a settles on the dot');
  // Nobody is standing in a crowd unless the fire has one.
  assert.deepEqual([...panickingIds({ ...run, crowd: undefined }, 1250, standing)], []);
});

test('a meteor frightens bystanders standing near it, and only just after it lands', () => {
  const run = { incident: { kind: 'meteor', start: 1000 }, hazard: { radiusMetres: 100, responseStartsAt: 1000 },
    location: { position: [-71, 42] }, participants: [] };
  // 0.001 degrees of longitude at 42 N is about 83 m; 0.004 is about 331 m, well beyond the reach.
  const standing = [at(-71), at(-70.999), at(-70.996)];
  assert.deepEqual([...panickingIds(run, 1001, standing)], ['p-71', 'p-70.999'], 'those inside the reach');
  assert.deepEqual([...panickingIds(run, 999, standing)], [], 'nothing before the impact');
  assert.deepEqual([...panickingIds(run, 1000 + PANIC_SECONDS, standing)], [], 'and not for ever after');
  // A closure or a drill never frightens anyone, whatever is standing about.
  for (const kind of ['closure', 'fire-drill', 'fire-alarm']) {
    assert.deepEqual([...panickingIds({ ...run, incident: { kind, start: 1000 } }, 1001, standing)], [], kind);
  }
  assert.deepEqual([...panickingIds(null, 1001, standing)], []);
  assert.deepEqual([...panickingIds(run, 1001, [])], [], 'nobody standing, nobody to split');
});

test('frightened people are drawn in panic layers, the rest keep idling', () => {
  const people = ['scared', 'calm'].map((id) => ({ id, model: 0, position: [-71, 42, 0], bearing: 0, to: 'stop' }));
  const layers = waitingRiderLayers(people, [{}], 5, 17, new Set(['scared']));
  const visible = layers.filter((layer) => layer.props.data.length);
  const afraid = visible.find((layer) => layer.props.data.some((p) => p.id === 'scared'));
  const calm = visible.find((layer) => layer.props.data.some((p) => p.id === 'calm'));
  assert.equal(afraid.props._animations[PANIC_CLIP].playing, true);
  assert.equal(calm.props._animations.idle.playing, true);
  assert.notEqual(afraid.props.id, calm.props.id, 'one clip per layer, so they are drawn apart');
  assert.equal(visible.flatMap((layer) => layer.props.data).length, 2, 'everyone is drawn exactly once');
  // With nobody frightened the panic layers are never built at all.
  const quiet = waitingRiderLayers(people, [{}], 5, 17, new Set());
  assert.ok(quiet.every((layer) => layer.props._animations.idle.playing));
});
