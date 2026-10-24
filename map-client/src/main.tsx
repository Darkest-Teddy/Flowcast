// First: caps window.devicePixelRatio for the map (Performance setting) before anything reads it.
import './perf/quality';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { cacheUniformBlockBindings, preferHighPerformanceGpu } from './gpu';
import './styles.css';

preferHighPerformanceGpu();
cacheUniformBlockBindings();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
