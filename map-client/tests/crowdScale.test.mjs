// The crowd scale has one definition, theme/crowd.ts. These tests keep everything that repeats it
// in step (tokens.css, which can't import TypeScript; the map's default tag level in styles.css;
// tokens.ts and the map's crowdLevels.ts, which derive from it) and enforce the contrast figures
// the colours promise, plus the glass tokens' text contrast.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { CROWD_LEVELS, crowdLevel } = await import('../../theme/crowd.ts');
const { crowdScale, crowdFor } = await import('../../theme/tokens.ts');
const mapLevels = await import('../src/layers/crowdLevels.ts');

const tokensCss = readFileSync(new URL('../../theme/tokens.css', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

/** The custom properties declared in the first rule whose selector is exactly `selector`. */
function declarations(css, selector, after = 0) {
  const at = css.indexOf(`${selector} {`, after);
  assert.ok(at >= 0, `no "${selector} {" rule`);
  const body = css.slice(at + selector.length + 2, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const light = declarations(tokensCss, ':root');
const darkMedia = declarations(tokensCss, ':root:not([data-theme="light"])', tokensCss.indexOf('@media (prefers-color-scheme: dark)'));
const darkForced = declarations(tokensCss, ':root[data-theme="dark"]');
const dark = { ...light, ...darkForced };

// WCAG 2 contrast.
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgba = (v) => {
  if (v.startsWith('#')) return [...hex(v), 1];
  const m = v.match(/^rgba?\(([^)]+)\)$/);
  assert.ok(m, `not a colour: ${v}`);
  const [r, g, b, a = 1] = m[1].split(',').map(Number);
  return [r, g, b, a];
};
const over = (fg, bg) => { const [r, g, b, a] = rgba(fg); const base = rgba(bg); return [r, g, b].map((c, i) => c * a + base[i] * (1 - a)); };
const channel = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const solid = (v) => (Array.isArray(v) ? v : over(v, '#ffffff'));
const stops = (gradient) => gradient.match(/#[0-9a-f]{6}/gi);

// The surfaces each kind of colour has to hold on.
const surfaces = (theme) => {
  const out = {
    surface: theme['--color-surface'],
    canvas: theme['--color-canvas'],
    sunken: theme['--color-surface-sunken'],
  };
  for (const stop of stops(theme['--canvas-gradient'])) {
    out[`glass over ${stop}`] = over(theme['--glass-fill'], stop);
    out[`strong glass over ${stop}`] = over(theme['--glass-fill-strong'], stop);
  }
  return out;
};
const lightSurfaces = surfaces(light);
const darkSurfaces = surfaces(dark);
// The map's glass (styles.css: tag card top, pill, panel), at its worst over a white map.
const mapGlass = {
  'tag card over white': over('rgba(28, 33, 45, 0.84)', '#ffffff'),
  'tag pill over white': over('rgba(13, 16, 23, 0.84)', '#ffffff'),
  'panel over white': over('rgba(17, 20, 28, 0.92)', '#ffffff'),
};

function assertContrast(color, on, min, what) {
  for (const [name, bg] of Object.entries(on)) {
    const ratio = contrast(solid(color), solid(bg));
    assert.ok(ratio >= min, `${what} ${color} on ${name}: ${ratio.toFixed(2)}:1 < ${min}:1`);
  }
}

test('thresholds: Moderate from 40%, Busy from 65%, Packed from 85%', () => {
  assert.deepEqual(CROWD_LEVELS.map((l) => [l.key, l.label, l.min]), [
    ['quiet', 'Quiet', 0], ['moderate', 'Moderate', 0.4], ['busy', 'Busy', 0.65], ['packed', 'Packed', 0.85],
  ]);
  const at = (share) => crowdLevel(share).key;
  assert.equal(at(0), 'quiet');
  assert.equal(at(0.3999), 'quiet');
  assert.equal(at(0.4), 'moderate'); // boundaries go to the upper level
  assert.equal(at(0.6499), 'moderate');
  assert.equal(at(0.65), 'busy');
  assert.equal(at(0.8499), 'busy');
  assert.equal(at(0.85), 'packed');
  assert.equal(at(1.4), 'packed');
});

test('an unknown share is Quiet, never Packed', () => {
  for (const share of [NaN, undefined, null, -0.2]) assert.equal(crowdLevel(share).key, 'quiet', String(share));
  assert.equal(crowdFor(NaN).level, 'quiet');
  assert.equal(mapLevels.crowdLevel(NaN).key, 'quiet');
});

test('tokens.ts and the map agree with crowd.ts', () => {
  assert.deepEqual(crowdScale.map((s) => [s.level, s.label, s.upTo]), [
    ['quiet', 'Quiet', 0.4], ['moderate', 'Moderate', 0.65], ['busy', 'Busy', 0.85], ['packed', 'Packed', Infinity],
  ]);
  for (const s of crowdScale) {
    assert.equal(s.color, `var(--crowd-${s.level})`);
    assert.equal(s.text, `var(--crowd-${s.level}-text)`);
  }
  assert.deepEqual(mapLevels.LEVELS.map((l) => l.key), ['packed', 'busy', 'moderate', 'quiet']);
  for (const l of mapLevels.LEVELS) assert.equal(l, CROWD_LEVELS.find((c) => c.key === l.key));
  for (let share = -0.05; share <= 1.3; share += 0.005) {
    const key = crowdLevel(share).key;
    assert.equal(crowdFor(share).level, key, `crowdFor(${share})`);
    assert.equal(mapLevels.crowdLevel(share).key, key, `map crowdLevel(${share})`);
  }
});

test('tokens.css repeats crowd.ts exactly, in light and in both dark blocks', () => {
  for (const l of CROWD_LEVELS) {
    assert.equal(light[`--crowd-${l.key}`], l.fillLight, `light --crowd-${l.key}`);
    assert.equal(light[`--crowd-${l.key}-text`], l.textOnLight, `light --crowd-${l.key}-text`);
    for (const [name, block] of [['prefers-color-scheme dark', darkMedia], ['data-theme="dark"', darkForced]]) {
      assert.equal(block[`--crowd-${l.key}`], l.fillDark, `${name} --crowd-${l.key}`);
      assert.equal(block[`--crowd-${l.key}-text`], l.text, `${name} --crowd-${l.key}-text`);
    }
    assert.equal(l.fillDark, `#${l.glow.slice(0, 3).map((c) => c.toString(16).padStart(2, '0')).join('')}`, `${l.key} fillDark is its glow`);
  }
  const crowdVars = (block) => Object.keys(block).filter((k) => k.startsWith('--crowd-')).sort();
  const expected = CROWD_LEVELS.flatMap((l) => [`--crowd-${l.key}`, `--crowd-${l.key}-text`]).sort();
  assert.deepEqual(crowdVars(light), expected);
  assert.deepEqual(crowdVars(darkMedia), expected);
  assert.deepEqual(crowdVars(darkForced), expected);
});

test('the two dark blocks in tokens.css are identical', () => {
  assert.deepEqual(darkMedia, darkForced);
});

test("the map tag's default level is Quiet from crowd.ts", () => {
  const rule = stylesCss.slice(stylesCss.indexOf('.btag {'), stylesCss.indexOf('}', stylesCss.indexOf('.btag {')));
  const quiet = CROWD_LEVELS[0];
  assert.match(rule, new RegExp(`--lv: ${quiet.glow.slice(0, 3).join(', ')};`));
  assert.match(rule, new RegExp(`--lv-text: ${quiet.text};`));
});

test('crowd text keeps 4.5:1 and fills 3:1 on every surface they sit on', () => {
  for (const l of CROWD_LEVELS) {
    assertContrast(l.textOnLight, lightSurfaces, 4.5, `${l.key} textOnLight`);
    assertContrast(l.text, darkSurfaces, 4.5, `${l.key} text`);
    assertContrast(l.text, mapGlass, 4.5, `${l.key} text`);
    assertContrast(l.fillLight, lightSurfaces, 3, `${l.key} fillLight`);
    assertContrast(l.fillDark, darkSurfaces, 3, `${l.key} fillDark`);
  }
});

test('ink keeps 4.5:1 on glass and on the bare canvas gradient, at every stop', () => {
  for (const [name, theme, on] of [['light', light, lightSurfaces], ['dark', dark, darkSurfaces]]) {
    const glassOnly = Object.fromEntries(Object.entries(on).filter(([k]) => k.includes('glass')));
    // Page descriptions, empty states and status lines sit straight on the gradient.
    for (const stop of stops(theme['--canvas-gradient'])) glassOnly[`canvas ${stop}`] = stop;
    assertContrast(theme['--color-ink'], glassOnly, 4.5, `${name} ink`);
    assertContrast(theme['--color-ink-secondary'], glassOnly, 4.5, `${name} ink-secondary`);
    assertContrast(theme['--glass-ink-tertiary'], glassOnly, 4.5, `${name} glass-ink-tertiary`);
  }
  // Why --glass-ink-tertiary exists: light --color-ink-tertiary doesn't make it on glass.
  assert.ok(contrast(hex(light['--color-ink-tertiary']), over(light['--glass-fill'], stops(light['--canvas-gradient'])[0])) < 4.5);
});

test('reduced transparency makes glass solid and wins over both dark blocks', () => {
  const lastDark = tokensCss.lastIndexOf(':root[data-theme="dark"] {');
  const media = tokensCss.indexOf('@media (prefers-reduced-transparency: reduce)');
  assert.ok(media > lastDark, 'the reduced-transparency rules come after the dark blocks');
  const solidGlass = {
    '--glass-fill': 'var(--color-surface)',
    '--glass-fill-strong': 'var(--color-surface)',
    '--glass-blur': '0px',
    '--glass-saturate': '100%',
    '--canvas-gradient': 'linear-gradient(var(--color-canvas), var(--color-canvas))',
  };
  // Both selectors are (0,2,0), the same as :root[data-theme="dark"] and
  // :root:not([data-theme="light"]), so coming later is what makes them win.
  assert.deepEqual(declarations(tokensCss, ':root:not([data-transparency="full"])', media), solidGlass);
  assert.deepEqual(declarations(tokensCss, ':root[data-transparency="reduced"]', media), solidGlass);
  for (const name of Object.keys(solidGlass)) {
    assert.ok(light[name], `light defines ${name}`);
  }
  for (const name of ['--glass-fill', '--glass-fill-strong', '--canvas-gradient']) {
    assert.ok(darkForced[name] && darkMedia[name], `dark defines ${name}`);
  }
});
