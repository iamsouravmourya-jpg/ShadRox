import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import obfuscatorPlugin from 'vite-plugin-javascript-obfuscator';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';
import {encodeWebhook} from './src/lib/webhook-codec';

const rootDir = import.meta.dirname ?? path.resolve('.');

export default defineConfig(({ mode, command }) => {
  const obfuscationEnabled = process.env.SHADROX_OBFUSCATE !== '0';
  const env = loadEnv(mode, rootDir, '');
  if (command === 'build') {
    if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
      throw new Error('Desktop build requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
    }
  }
  return {
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
