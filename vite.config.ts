import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import obfuscatorPlugin from 'vite-plugin-javascript-obfuscator';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';
import {encodeWebhook} from './src/lib/webhook-codec';

const rootDir = import.meta.dirname ?? path.resolve('.');

export default defineConfig(({ mode, command }) => {
  const obfuscationEnabled = process.env.SHADROX_OBFUSCATE === '1';
  const env = loadEnv(mode, rootDir, '');
  if (command === 'build' && (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY)) {
    console.warn('[shadrox] Building without VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY; auth gate will be bypassed in browser mode.');
  }
  return {
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true
    },
    // Only the encoded form reaches the bundle; the plain URL never does.
    define: {
      __FEEDBACK_WEBHOOK_ENC__: JSON.stringify(
        env.SHADROX_FEEDBACK_WEBHOOK ? encodeWebhook(env.SHADROX_FEEDBACK_WEBHOOK.trim()) : ''
      )
    },
    plugins: [
      react(),
      tailwindcss(),
      ...(command === 'build' && mode === 'production' && obfuscationEnabled
        ? [
            obfuscatorPlugin({
              apply: 'build',
              options: {
                controlFlowFlattening: true,
                controlFlowFlatteningThreshold: 0.8,
                deadCodeInjection: true,
                deadCodeInjectionThreshold: 0.4,
                identifierNamesGenerator: 'hexadecimal',
                selfDefending: false,
                stringArray: true,
                stringArrayEncoding: ['rc4'],
                stringArrayThreshold: 1
              }
            })
          ]
        : [])
    ],
    resolve: {
      alias: {
        '@': path.resolve(rootDir, '.'),
      },
    },
  };
});
