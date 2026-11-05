// Platform export only: retain the selected artwork and give system icons a consistent optical size.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'shoho-icon-'));
try {
  // 912/1024 scale puts the visible rounded tile at about 81% of the macOS icon canvas.
  const png = readFileSync(join(root, 'assets/icon.png')).toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024"><image x="56" y="56" width="912" height="912" xlink:href="data:image/png;base64,${png}"/></svg>`;
  const input = join(temp, 'app-icon.svg'); writeFileSync(input, svg);
  const cli = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js');
  const result = spawnSync(process.execPath, [cli, 'icon', input, '--output', join(root, 'src-tauri/icons')], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exitCode = result.status || 1;
  else copyFileSync(join(root, 'src-tauri/icons/icon.ico'), join(root, 'assets/icon.ico'));
} finally { rmSync(temp, { recursive: true, force: true }); }
