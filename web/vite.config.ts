import { defineConfig } from 'vite'
import { spawn } from 'node:child_process'

// The Go server owns the API and runs Claude; Vite only serves the UI in dev.
const api = { target: 'http://127.0.0.1:8765', changeOrigin: true }

export default defineConfig({
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 }, // big chunks are Mermaid's, loaded only when a diagram appears
  server: { port: 5173, strictPort: true, proxy: { '/api': api, '/ask': api } },
  plugins: [{
    name: 'go-server',
    apply: 'serve',
    // `npm run dev` also starts the Go server (it rebuilds and restarts itself when a .go file changes).
    // Project folder: CLAUDE_UI_ROOT, default the repo.
    configureServer() {
      const go = spawn('go', ['run', '.', process.env.CLAUDE_UI_ROOT ?? '..'], { cwd: '..', stdio: 'inherit' })
      process.on('exit', () => go.kill())
    },
  }],
})
