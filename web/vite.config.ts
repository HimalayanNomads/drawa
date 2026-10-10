import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The Go server owns the API and runs the agents; Vite only serves the UI in dev. DRAWA_PORT moves both (a second
// checkout next to a running drawa).
const api = { target: `http://127.0.0.1:${process.env.DRAWA_PORT || 8765}`, changeOrigin: true };

export default defineConfig({
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 }, // big chunks are Mermaid's, loaded only when a diagram appears
  server: { port: 5173, strictPort: true, proxy: { '/api': api, '/ask': api } },
  plugins: [
    {
      name: 'go-server',
      apply: 'serve',
      // `pnpm run dev` also starts the Go server (it rebuilds and restarts itself when a .go file changes).
      // Project folder: DRAWA_ROOT, default the repo; resolved here because the server runs from the repo.
      // Built and run directly rather than `go run`, which leaves its child server holding the port when killed.
      configureServer() {
        const bin = resolve('../.bin/drawa-server');
        if (spawnSync('go', ['build', '-o', bin, '.'], { cwd: '..', stdio: 'inherit' }).status)
          throw new Error('go build failed');
        // DRAWA_DEV makes the server trust this dev server's origin, which it refuses otherwise
        const go = spawn(bin, [resolve(process.env.DRAWA_ROOT ?? '..')], {
          cwd: '..',
          stdio: 'inherit',
          env: { ...process.env, DRAWA_DEV: '1' },
        });
        process.on('exit', () => go.kill());
      },
    },
  ],
});
