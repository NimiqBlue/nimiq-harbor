import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Only browser-visible VITE_* configuration is loaded. Never read host key files.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const key = env.VITE_MTPELERIN_KEY?.trim();
  if (key && (/^(undefined|null)$/i.test(key) || /\s/.test(key))) throw new Error('Invalid Mt Pelerin activation key');
  const apiPort = process.env.PORT || '18787';
  if (!/^\d+$/.test(apiPort) || Number(apiPort) < 1024 || Number(apiPort) > 65535) throw new Error('Invalid API PORT');
  return {
    plugins: [react()],
    define: { 'process.env.NODE_DEBUG': 'undefined', 'process.stderr': 'undefined' },
    server: { host: '127.0.0.1', port: 14173, strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiPort}` } },
    build: { sourcemap: false },
  };
});
