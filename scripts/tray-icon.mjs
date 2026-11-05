// Menu-bar artwork has its own complete silhouette, optimized for a small template image.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = mkdtempSync(join(tmpdir(), 'shoho-tray-'));
try {
  const cli = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js');
  const result = spawnSync(process.execPath, [cli, 'icon', join(root, 'assets/tray.svg'), '--output', output, '--png', '36'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exitCode = result.status || 1;
  else copyFileSync(join(output, '36x36.png'), join(root, 'assets/trayTemplate.png'));
} finally { rmSync(output, { recursive: true, force: true }); }
