import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIconPng, wrapInIco } from './icon-render.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(scriptDirectory, '..', 'landing', 'public');

const outputs = [
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-192.png', size: 192 },
  { file: 'apple-touch-icon.png', size: 180, fullBleed: true },
  { file: 'favicon.png', size: 48 },
];

fs.mkdirSync(outputDirectory, { recursive: true });
for (const { file, size, fullBleed } of outputs) {
  const png = renderIconPng(size, { fullBleed: Boolean(fullBleed) });
  fs.writeFileSync(path.join(outputDirectory, file), png);
  console.log(`Wrote landing/public/${file} (${size}x${size}, ${Math.round(png.length / 1024)} KB)`);
}

const ico = wrapInIco(renderIconPng(48), 48);
fs.writeFileSync(path.join(outputDirectory, 'favicon.ico'), ico);
console.log(`Wrote landing/public/favicon.ico (48x48 PNG entry, ${Math.round(ico.length / 1024)} KB)`);
