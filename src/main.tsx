import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { hydrateSecureStore } from './lib/secureStore';
import './index.css';
import { inject } from '@vercel/analytics';

const platform = window.shadroxDesktop?.platform;
if (platform) document.documentElement.dataset.platform = platform;

async function boot() {
  // Restore encrypted settings (API keys, recents) before the app reads them.
  await Promise.race([
    hydrateSecureStore(),
    new Promise((resolve) => setTimeout(resolve, 1500))
  ]);
  createRoot(document.getElementById('root')!).render(<App />);
  inject();
}

void boot();
