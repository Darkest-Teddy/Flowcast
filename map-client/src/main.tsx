// First: caps window.devicePixelRatio for the map (Performance setting) before anything reads it.
import './perf/quality';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { cacheUniformBlockBindings, preferHighPerformanceGpu } from './gpu';
import { installMapboxVaoCache } from './map/vaoCache';
import { syncTheme } from './theme';
import './styles.css';
// After styles.css: the chrome layer positions itself over everything that file lays out.
import './hud.css';
// After hud.css: the join slot takes the bottom-left corner and hud.css stacks the perf readout above it.
import './persona/persona.css';

syncTheme();
preferHighPerformanceGpu();
cacheUniformBlockBindings();
installMapboxVaoCache();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
