// map-client modules the server imports (sim/sourceDay → transit/*) read Vite env vars through
// import.meta.env. Vite types them loosely in the browser build; under Node they are undefined.
interface ImportMetaEnv {
  readonly [key: string]: any;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
