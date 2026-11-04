import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIconPng } from './icon-render.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(scriptDirectory, '..', 'assets', 'icon.png');

const png = renderIconPng(1024);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, png);
console.log(`Wrote ${outputPath} (1024x1024, ${Math.round(png.length / 1024)} KB)`);
