import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import type { ShaderModule } from '@luma.gl/shadertools';

/** Fail loudly if an upstream shader changes rather than silently changing material appearance. */
export function materialAttributeFragmentShader(fs: string): string {
  const metallic = 'pbrMaterial.metallicRoughnessValues';
  const emissive = 'pbrMaterial.emissiveFactor';
  if (!fs.includes(metallic) || !fs.includes(emissive)) throw new Error('Unsupported PBR shader for material batching');
  return `in vec2 flowMetallicRoughness;\nin vec3 flowEmissive;\n${fs.replaceAll(metallic, 'flowMetallicRoughness').replaceAll(emissive, 'flowEmissive')}`;
}

/** ScenegraphLayer's WebGL shader omits glTF vertex colors; apply them before PBR lighting. */
export class MaterialScenegraphLayer<DataT = unknown, ExtraPropsT extends object = object> extends ScenegraphLayer<DataT, ExtraPropsT> {
  static layerName = 'MaterialScenegraphLayer';

  getShaders() {
    const shaders = super.getShaders();
    const physical = this.props.scenegraph?.flowMaterialAttributes === true;
    if (physical && this.context.device?.type === 'webgpu') throw new Error('Material attribute batching requires WebGL');
    return {
      ...shaders,
      modules: physical ? shaders.modules?.map((module: ShaderModule) => module.name === 'pbrMaterial' && module.fs
        ? { ...module, fs: materialAttributeFragmentShader(module.fs) }
        : module) : shaders.modules,
      inject: {
        ...shaders.inject,
        'vs:#decl': '#ifdef HAS_COLORS\nin vec4 colors;\n#endif' + (physical ? '\nin vec2 _FLOW_METALLIC_ROUGHNESS;\nin vec3 _FLOW_EMISSIVE;\nout vec2 flowMetallicRoughness;\nout vec3 flowEmissive;' : ''),
        'vs:main-end': '#ifdef HAS_COLORS\nvColor *= colors;\n#endif' + (physical ? '\nflowMetallicRoughness = _FLOW_METALLIC_ROUGHNESS;\nflowEmissive = _FLOW_EMISSIVE;' : ''),
      },
    };
  }
}
