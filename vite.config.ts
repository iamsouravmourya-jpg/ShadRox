import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import obfuscatorPlugin from 'vite-plugin-javascript-obfuscator';
import { createRequire } from 'module';
import path from 'path';
import {defineConfig, loadEnv, type Plugin} from 'vite';
import {encodeWebhook} from './src/lib/webhook-codec';

const rootDir = import.meta.dirname ?? path.resolve('.');
const nodeRequire = createRequire(import.meta.url);
const electronDir = path.resolve(rootDir, 'electron');

/**
 * Vite pre-bundles CJS deps inside node_modules, but serves repo-local `.cjs`
 * files as raw ESM in `vite serve`, causing `does not provide an export named ...`.
 * In dev mode, wrap shared `electron/*.cjs` modules with generated ESM named exports.
 */
function localElectronCjsPlugin(): Plugin {
  return {
    name: 'shadrox-local-electron-cjs',
    apply: 'serve',
    transform(code, id) {
      const cleanId = id.split('?')[0];
      if (!cleanId.endsWith('.cjs') || !cleanId.startsWith(electronDir)) return null;
      const loaded = nodeRequire(cleanId) as Record<string, unknown>;
      const exportKeys = loaded && typeof loaded === 'object'
        ? Object.keys(loaded).filter((k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) && k !== 'default')
        : [];
      const body = code.replace(/^\s*['"]use strict['"];?\s*/, '');
      const namedExports = exportKeys
        .map((key) => `export const ${key} = __cjsExports.${key};`)
        .join('\n');
      return {
        code: [
          'const __cjsModule = { exports: {} };',
          '(function(module, exports, require) {',
          body,
          '})(__cjsModule, __cjsModule.exports, () => null);',
          'const __cjsExports = __cjsModule.exports;',
          'export default __cjsExports;',
          namedExports,
        ].join('\n'),
        map: null,
      };
    },
  };
}

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
    build: {
      chunkSizeWarningLimit: 700,
      rolldownOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.replace(/\\/g, '/');
            if (!normalized.includes('/node_modules/')) return undefined;
            if (normalized.includes('/node_modules/react-dom/') || normalized.includes('/node_modules/react/') || normalized.includes('/node_modules/scheduler/')) {
              return 'react-vendor';
            }
            if (normalized.includes('/node_modules/@xterm/')) {
              return 'xterm-vendor';
            }
            if (normalized.includes('/node_modules/lucide-react/')) {
              return 'icons-vendor';
            }
            if (normalized.includes('/node_modules/esbuild-wasm/')) {
              return 'esbuild-vendor';
            }
            if (
              normalized.includes('/node_modules/@uiw/react-codemirror/') ||
              normalized.includes('/node_modules/@lezer/') ||
              (normalized.includes('/node_modules/@codemirror/') && !normalized.includes('/node_modules/@codemirror/lang-'))
            ) {
              return 'codemirror-core';
            }
            return undefined;
          }
        }
      }
    },
    // Only the encoded form reaches the bundle; the plain URL never does.
    define: {
      __FEEDBACK_WEBHOOK_ENC__: JSON.stringify(
        env.SHADROX_FEEDBACK_WEBHOOK ? encodeWebhook(env.SHADROX_FEEDBACK_WEBHOOK.trim()) : ''
      )
    },
    plugins: [
      localElectronCjsPlugin(),
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
