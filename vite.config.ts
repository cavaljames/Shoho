import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: 'src', publicDir: '../assets', clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  build: {
    outDir: '../dist', emptyOutDir: true, target: ['es2022', 'safari15'],
    rollupOptions: { input: { main: fileURLToPath(new URL('./src/index.html', import.meta.url)), reminder: fileURLToPath(new URL('./src/reminder.html', import.meta.url)) } }
  }
});
