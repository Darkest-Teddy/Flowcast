// A tiny shader extension that fades a layer's colour smoothly across its geometry, so the crowd
// glow can be soft light instead of flat translucent boxes. No offscreen pass, so it works in
// deck.gl's interleaved mode (unlike HeatmapLayer).
//  - 'height' (SolidPolygonLayer, flat): the fade amount is carried in each vertex's z, between
//    HALO_Z and HALO_Z + HALO_Z_RANGE metres, i.e. a centimetre-thin, invisible change of height.
//    The ground halo puts 1 on its inner ring and 0 on its outer ring.
//  - 'line' (LineLayer): fades from transparent at the source to full colour at the target.
import { LayerExtension } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';

export const HALO_Z = 0.3;
export const HALO_Z_RANGE = 0.02;

export class GlowFadeExtension extends LayerExtension<{ mode: 'height' | 'line'; power: number }> {
  static extensionName = 'GlowFadeExtension';

  getShaders(this: Layer, extension: GlowFadeExtension) {
    const { mode, power } = extension.opts;
    // LineLayer's `positions.x` runs 0 -> 1 from source to target; it's only declared in the
    // layer's own shader, so read it at the end of main() rather than in a filter hook.
    const write =
      mode === 'line'
        ? { 'vs:#main-end': 'vGlowFade = positions.x;' }
        : {
            'vs:DECKGL_FILTER_COLOR': `vGlowFade = clamp((geometry.worldPosition.z - ${HALO_Z.toFixed(3)}) / ${HALO_Z_RANGE.toFixed(3)}, 0.0, 1.0);`,
          };
    return {
      inject: {
        'vs:#decl': 'out float vGlowFade;',
        ...write,
        'fs:#decl': 'in float vGlowFade;',
        // A power curve reads as light falling off, rather than a linear ramp.
        'fs:DECKGL_FILTER_COLOR': `color.a *= pow(vGlowFade, ${power.toFixed(2)});`,
      },
    };
  }
}
