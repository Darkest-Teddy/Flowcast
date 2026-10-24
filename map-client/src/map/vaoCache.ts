// Give Mapbox GL's vertex array objects one cached binding per shader program.
//
// Mapbox keeps a single VAO per drawable segment and rebuilds it whenever the segment is drawn
// with a different program than last time. With Standard's shadows on, every building and tree
// segment is drawn by two or three programs each frame (shadow depth, colour, ground effect),
// so the cache never hits: ~170 VAOs created and ~130 deleted per frame, each with a full round
// of bindBuffer / enableVertexAttribArray / vertexAttribPointer / vertexAttribDivisor calls
// (~7,000 GL calls a frame), all of it queued through Chrome's GPU process, which is this app's
// bottleneck. Keeping a VAO per program (a handful at most) turns those into one
// bindVertexArray each. Rendering is unchanged: a binding is only reused when the program,
// buffers and offset all still match, exactly as Mapbox's own check requires.
//
// The class isn't exported, so its prototype is caught the first time Mapbox constructs one:
// its constructor assigns `this.boundLayoutVertexBuffer = null`, and an Object.prototype
// setter for that (Mapbox-only) name sees the instance, patches its class once and removes
// itself. If Mapbox ever changes shape, the patch checks what it needs and stands aside.

const FIELD = 'boundLayoutVertexBuffer';
const STATE = ['vao', 'boundProgram', 'boundLayoutVertexBuffer', 'boundPaintVertexBuffers', 'boundIndexBuffer', 'boundVertexOffset', 'boundDynamicVertexBuffers'] as const;
const MAX_PROGRAMS = 6;

interface Vao {
  vao: WebGLVertexArrayObject | null;
  boundProgram: unknown;
  context?: { gl: WebGL2RenderingContext };
  [key: string]: unknown;
}
type Saved = Record<(typeof STATE)[number], unknown>;
const others = new WeakMap<Vao, Map<unknown, Saved>>();

function patch(proto: { bind: (...a: unknown[]) => unknown; freshBind: (...a: unknown[]) => unknown; destroy: () => void }) {
  if (typeof proto.bind !== 'function' || typeof proto.freshBind !== 'function' || typeof proto.destroy !== 'function') return;
  const { bind, freshBind, destroy } = proto;
  proto.bind = function (this: Vao, context: unknown, program: unknown, ...rest: unknown[]) {
    if (this.vao && this.boundProgram !== program) {
      let saved = others.get(this);
      if (!saved) others.set(this, (saved = new Map()));
      // Park the current program's binding and bring back this program's, if there is one;
      // Mapbox's own check then decides whether it still matches.
      const current = {} as Saved;
      for (const key of STATE) current[key] = this[key];
      const restore = saved.get(program);
      saved.delete(program);
      saved.set(this.boundProgram, current);
      if (saved.size > MAX_PROGRAMS) {
        const [oldest, old] = saved.entries().next().value as [unknown, Saved];
        saved.delete(oldest);
        (context as { gl: WebGL2RenderingContext }).gl.deleteVertexArray(old.vao as WebGLVertexArrayObject);
      }
      if (restore) for (const key of STATE) (this as Record<string, unknown>)[key] = restore[key];
      else this.vao = null; // parked, not destroyed
    }
    return bind.call(this, context, program, ...rest);
  };
  proto.freshBind = function (this: Vao, ...args: unknown[]) {
    // Replace only the current binding (Mapbox's freshBind calls destroy(), which would also
    // drop the parked ones).
    if (this.vao && this.context) {
      this.context.gl.deleteVertexArray(this.vao);
      this.vao = null;
    }
    return freshBind.apply(this, args);
  };
  proto.destroy = function (this: Vao) {
    const saved = others.get(this);
    if (saved && this.context) for (const s of saved.values()) this.context.gl.deleteVertexArray(s.vao as WebGLVertexArrayObject);
    others.delete(this);
    destroy.call(this);
  };
}

export function installMapboxVaoCache() {
  if (Object.prototype.hasOwnProperty.call(Object.prototype, FIELD)) return;
  Object.defineProperty(Object.prototype, FIELD, {
    configurable: true,
    set(this: object, value: unknown) {
      delete (Object.prototype as Record<string, unknown>)[FIELD];
      const proto = Object.getPrototypeOf(this);
      if (proto && 'freshBind' in proto) patch(proto);
      Object.defineProperty(this, FIELD, { value, writable: true, enumerable: true, configurable: true });
    },
  });
}
