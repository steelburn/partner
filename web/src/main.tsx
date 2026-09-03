import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { applyMode, getInitialMode } from './theme/apply.js';
import './app.css';

// Apply tokens before the first paint so no raw default colors flash.
applyMode(getInitialMode());

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root element — web/index.html is malformed.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
