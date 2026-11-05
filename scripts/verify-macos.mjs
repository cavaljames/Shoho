// Verify the actual distributed app, not just the linker-signed Mach-O executable.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('macOS package verification must run on macOS.');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const app = resolve(process.argv[2] || join(root, 'src-tauri/target/release/bundle/macos/Shoho.app'));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${basename(command)} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function verifyBundle(bundle) {
  if (!existsSync(join(bundle, 'Contents/_CodeSignature/CodeResources'))) throw new Error(`Missing complete app-bundle signature: ${bundle}`);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
  const plist = join(bundle, 'Contents/Info.plist');
  const actual = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
  if (actual !== version) throw new Error(`Version mismatch: expected ${version}, found ${actual}`);
  const identifier = run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]);
  if (identifier !== 'app.shoho.desktop') throw new Error(`Unexpected bundle identifier: ${identifier}`);
}
verifyBundle(app);
console.log(`App bundle signature verified: ${basename(app)} ${version}`);
console.log(run('/usr/bin/file', ['-b', join(app, 'Contents/MacOS/shoho')]));
const dmgDir = join(dirname(dirname(app)), 'dmg');
const images = readdirSync(dmgDir).filter(file => file.endsWith('.dmg') && file.includes(`_${version}_`));
if (!images.length) throw new Error(`No DMG found for ${version}`);
for (const name of images) {
  const dmg = join(dmgDir, name);
  run('/usr/bin/hdiutil', ['verify', dmg]);
  const mount = mkdtempSync(join(tmpdir(), 'shoho-package-check-'));
  let attached = false;
  try {
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg]);
    attached = true;
    const packagedApp = join(mount, 'Shoho.app'); verifyBundle(packagedApp);
    const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
    if (digest(join(packagedApp, 'Contents/MacOS/shoho')) !== digest(join(app, 'Contents/MacOS/shoho'))) throw new Error('DMG contains a different executable from the verified app.');
    const sha = digest(dmg); writeFileSync(`${dmg}.sha256`, `${sha}  ${name}\n`);
    console.log(`DMG checksum and contained app signature verified: ${name}`);
    console.log(`SHA-256: ${sha}`);
  } finally {
    if (attached) run('/usr/bin/hdiutil', ['detach', mount]);
    rmSync(mount, { recursive: true, force: true });
  }
}
console.log('Integrity checks passed. Ad-hoc signing does not provide Apple Developer ID trust or notarization.');
