/*
 * The render packages this app owns, re-exported for apps that mount its renderer.
 *
 * web/ has no deck.gl or loaders.gl of its own: they are installed here, and Node
 * resolution walks up from the importing file, so a file in web/src can never reach
 * map-client/node_modules. A Vite alias is not a fix -- these packages use `exports`
 * subpaths (`@luma.gl/webgl/constants`), and aliasing the scope to a directory makes
 * the bundler treat those as file paths and fail to resolve them.
 *
 * Re-exporting from here works because this file lives inside map-client, so the
 * imports below resolve normally and the package export maps are honoured. The
 * landing page's hero imports `@map/renderDeps`.
 */

export { MapboxOverlay } from '@deck.gl/mapbox';
export { load } from '@loaders.gl/core';
export { GLTFLoader } from '@loaders.gl/gltf';
