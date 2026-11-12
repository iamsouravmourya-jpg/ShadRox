import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { ConfirmHost } from './components/ConfirmHost';
import { hydrateSecureStore } from './lib/secureStore';
import { purgeLegacyEntitlements } from './lib/storage';
import './index.css';

const platform = window.shadroxDesktop?.platform;
if (platform) document.documentElement.dataset.platform = platform;

async function boot() {
  // A build before this one could save a paid plan and a shared-key preference.
  // ShadRox has exactly one entitlement state now, so drop them before anything
  // reads storage rather than letting a stale value decide how the app behaves.
  purgeLegacyEntitlements();
  // Restore encrypted settings (API keys, recents) before the app reads them.
  await Promise.race([
    hydrateSecureStore(),
    new Promise((resolve) => setTimeout(resolve, 1500))
  ]);
  createRoot(document.getElementById('root')!).render(
    <>
      <App />
      <ConfirmHost />
    </>
  );
}

void boot();
