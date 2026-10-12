import { defineConfig } from 'vite';
import type { Connect, Plugin } from 'vite';
import path from 'path';

/** 🕹 The arcade's emulator frame is an opaque origin (src/arcadeEmulator.ts:
 *  sandboxed, never allow-same-origin), so its fetches of the station's
 *  engine files carry `Origin: null` and need the files served with
 *  Access-Control-Allow-Origin — these files and no others: the engine and
 *  its cores under /emulatorjs/ are public. For the dev and preview servers
 *  here; a deployment serves /emulatorjs/ the same way. */
function emulatorCors(): Plugin {
  const header: Connect.NextHandleFunction = (req, res, next) => {
    if ((req.url ?? '').startsWith('/emulatorjs/')) res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  };
  return {
    name: 'ssf-emulator-cors',
    configureServer(server) { server.middlewares.use(header); },
    configurePreviewServer(server) { server.middlewares.use(header); },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [emulatorCors()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    host: true,
    open: true,
  },
});
