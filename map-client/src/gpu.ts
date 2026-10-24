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
