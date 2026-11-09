import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

const rootDir = import.meta.dirname ?? path.resolve('.');

export default defineConfig(({ mode, command }) => {
  if (command === 'build') {
    const env = loadEnv(mode, rootDir, '');
    if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
      throw new Error('Desktop build requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
    }
  }
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(rootDir, '.'),
      },
    },
  };
});
