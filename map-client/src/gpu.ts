// GPU selection and reporting. Whether the GPU is used at all is the browser's call (Chrome:
// Settings > System > "Use graphics acceleration when available"; check chrome://gpu). What
// the page can do is ask for the high-performance GPU on machines with two, which Mapbox
// doesn't expose as an option, and report which renderer it actually got.

type GetContext = HTMLCanvasElement['getContext'];

/** Make every WebGL context ask for the high-performance GPU unless it asked for something else. */
export function preferHighPerformanceGpu() {
  const original = HTMLCanvasElement.prototype.getContext as GetContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, attributes?: unknown) {
    if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
      const attrs = (attributes ?? {}) as WebGLContextAttributes;
      const powerPreference = attrs.powerPreference && attrs.powerPreference !== 'default' ? attrs.powerPreference : 'high-performance';
      return (original as (type: string, attributes?: unknown) => RenderingContext | null).call(this, type, { ...attrs, powerPreference });
    }
    return (original as (type: string, attributes?: unknown) => RenderingContext | null).call(this, type, attributes);
  } as GetContext;
}

/**
 * Skip redundant uniform-block calls. Mapbox and luma.gl (deck.gl) both look up and re-assign
 * every uniform block's binding before every draw: ~2,000 getUniformBlockIndex and as many
 * uniformBlockBinding calls a frame here, each a trip through WebGL validation and Chrome's GPU
 * command buffer. Both results only change when a program is (re)linked, so they're cached per
 * program and dropped on linkProgram. Rendering is unchanged.
 */
export function cacheUniformBlockBindings() {
  if (typeof WebGL2RenderingContext === 'undefined') return;
  const proto = WebGL2RenderingContext.prototype;
  const { getUniformBlockIndex, uniformBlockBinding, linkProgram } = proto;
  const indices = new WeakMap<WebGLProgram, Map<string, number>>();
  const bindings = new WeakMap<WebGLProgram, Map<number, number>>();
  proto.getUniformBlockIndex = function (this: WebGL2RenderingContext, program: WebGLProgram, name: string) {
    let names = indices.get(program);
    if (!names) indices.set(program, (names = new Map()));
    let index = names.get(name);
    if (index === undefined) names.set(name, (index = getUniformBlockIndex.call(this, program, name)));
    return index;
  };
  proto.uniformBlockBinding = function (this: WebGL2RenderingContext, program: WebGLProgram, index: number, binding: number) {
    let set = bindings.get(program);
    if (!set) bindings.set(program, (set = new Map()));
    if (set.get(index) === binding) return;
    set.set(index, binding);
    uniformBlockBinding.call(this, program, index, binding);
  };
  proto.linkProgram = function (this: WebGL2RenderingContext, program: WebGLProgram) {
    indices.delete(program);
    bindings.delete(program);
    linkProgram.call(this, program);
  };
}

export interface GpuInfo {
  renderer: string;
  software: boolean; // rendering on the CPU: hardware acceleration is off or unavailable
}

/** The renderer behind the map's canvas, e.g. "Apple M3 Pro" or "SwiftShader" (software). */
export function mapGpuInfo(): GpuInfo | null {
  const canvas = document.querySelector<HTMLCanvasElement>('.mapboxgl-canvas, .maplibregl-canvas');
  // Asking for the type the map already created returns its existing context.
  const gl = (canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')) as WebGLRenderingContext | null;
  if (!gl) return null;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const raw = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  // Chrome wraps it: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)".
  const renderer = raw.match(/Renderer: ([^,]+)/)?.[1] ?? raw.replace(/^ANGLE \(|\)$/g, '');
  return { renderer, software: /swiftshader|llvmpipe|software|basic render/i.test(raw) };
}
