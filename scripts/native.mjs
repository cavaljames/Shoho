import { existsSync } from 'node:fs';
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = { ...process.env };
const local = join(root, '.toolchain');
const cargoName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const globalCargo = spawnSync(cargoName, ['--version'], { env, stdio: 'ignore' });
if (globalCargo.error || globalCargo.status !== 0) {
  const candidate = join(local, 'cargo', 'bin', cargoName);
  if (existsSync(candidate)) {
    env.CARGO_HOME = join(local, 'cargo'); env.RUSTUP_HOME = join(local, 'rustup');
    env.PATH = `${join(local, 'cargo', 'bin')}${delimiter}${env.PATH || ''}`;
  } else {
    console.error('需要 Rust 工具链。请按 README 安装 Rust 后重试。'); process.exit(1);
  }
}
const [kind, ...args] = process.argv.slice(2);
const command = kind === 'cargo' ? cargoName : process.execPath;
const parameters = kind === 'cargo' ? args : [createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js'), ...args];
const child = spawn(command, parameters, { cwd: root, env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
