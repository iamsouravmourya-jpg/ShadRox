import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIconPng, wrapInIco } from './icon-render.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(scriptDirectory, '..', 'assets', 'icon.png');

const png = renderIconPng(1024, { fullBleed: true });
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, png);
console.log(`Wrote ${outputPath} (1024x1024, ${Math.round(png.length / 1024)} KB)`);

const ico = wrapInIco(renderIconPng(256, { fullBleed: true }), 256);
const icoPath = path.join(scriptDirectory, '..', 'assets', 'icon.ico');
fs.writeFileSync(icoPath, ico);
console.log(`Wrote ${icoPath} (256x256 PNG entry, ${Math.round(ico.length / 1024)} KB)`);
