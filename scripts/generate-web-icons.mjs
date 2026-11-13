import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIconPng, wrapInIco } from './icon-render.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(scriptDirectory, '..', 'landing', 'public');

fs.mkdirSync(outputDirectory, { recursive: true });
const ico = wrapInIco(renderIconPng(48), 48);
fs.writeFileSync(path.join(outputDirectory, 'favicon.ico'), ico);
console.log(`Wrote landing/public/favicon.ico (48x48 PNG entry, ${Math.round(ico.length / 1024)} KB)`);