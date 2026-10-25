// First: caps window.devicePixelRatio for the map (Performance setting) before anything reads it.
import './perf/quality';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { cacheUniformBlockBindings, preferHighPerformanceGpu } from './gpu';
import { installMapboxVaoCache } from './map/vaoCache';
import { syncTheme } from './theme';
import './styles.css';

syncTheme();
preferHighPerformanceGpu();
cacheUniformBlockBindings();
installMapboxVaoCache();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
