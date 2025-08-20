import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Avoid referencing `document` when this bundle is evaluated in
// non-browser environments such as Web Workers.
if (typeof document !== 'undefined') {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
