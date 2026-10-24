import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { preferHighPerformanceGpu } from './gpu';
import './styles.css';

preferHighPerformanceGpu();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
