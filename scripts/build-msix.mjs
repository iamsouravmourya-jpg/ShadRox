import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const projectDir = path.resolve(process.cwd());
const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
const unpackedDir = path.join(projectDir, 'dist_desktop', 'win-unpacked');
const msixStaging = path.join(projectDir, 'dist_desktop', 'msix-staging');
const manifestSource = path.join(projectDir, 'scripts', 'msix', 'AppxManifest.xml');
const outputMsix = path.join(projectDir, 'dist_desktop', `ShadRox-v${pkg.version}.msix`);
const makeappx = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\makeappx.exe';

// Clean staging
fs.rmSync(msixStaging, { recursive: true, force: true });
fs.mkdirSync(msixStaging, { recursive: true });

// Copy unpacked app files
for (const entry of fs.readdirSync(unpackedDir)) {
  const src = path.join(unpackedDir, entry);
  const dest = path.join(msixStaging, entry);
  if (fs.statSync(src).isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.cpSync(src, dest);
  }
}

// Copy manifest
fs.cpSync(manifestSource, path.join(msixStaging, 'AppxManifest.xml'));

// Copy icon to staging root (referenced by manifest)
const iconSource = path.join(projectDir, 'assets', 'icon.png');
if (fs.existsSync(iconSource)) {
  fs.cpSync(iconSource, path.join(msixStaging, 'icon.png'));
}

// Remove existing output if present
fs.rmSync(outputMsix, { force: true });

// Pack MSIX
console.log('Packing MSIX...');
execSync(`"${makeappx}" pack /o /d "${msixStaging}" /p "${outputMsix}"`, { stdio: 'inherit' });

console.log(`MSIX created: ${outputMsix}`);
