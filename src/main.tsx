// src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initEventListeners } from './lib/events';
import './index.css';

// Wire Tauri event listeners exactly once, outside React's lifecycle.
// This avoids React 18 Strict Mode double-invoke creating duplicate listeners.
initEventListeners();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
