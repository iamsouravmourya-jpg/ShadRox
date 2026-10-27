import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { hydrateSecureStore } from './lib/secureStore';
import { injectSpeedInsights } from '@vercel/speed-insights';
import './index.css';

// Initialize Vercel Speed Insights
injectSpeedInsights();

const platform = window.shadroxDesktop?.platform;
if (platform) document.documentElement.dataset.platform = platform;

async function boot() {
  // Restore encrypted settings (API keys, recents) before the app reads them.
  await Promise.race([
    hydrateSecureStore(),
    new Promise((resolve) => setTimeout(resolve, 1500))
  ]);
  createRoot(document.getElementById('root')!).render(<App />);
}

void boot();
