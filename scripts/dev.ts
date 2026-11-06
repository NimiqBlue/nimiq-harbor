import { spawn } from 'node:child_process';
import { createServer } from 'vite';

// One loopback browser origin: Vite proxies the real local backend, not fixtures.
const port = process.env.PORT || '18787';
process.env.PORT = port;
process.env.APP_ORIGIN ||= 'http://localhost:14173';
const api = spawn(process.execPath, ['--import', 'tsx', 'src/server/start.ts'], { env: process.env, stdio: 'inherit' });
const web = await createServer();
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  api.kill('SIGTERM');
  await web.close();
  process.exitCode = code;
}
api.once('error', () => { void close(1); });
api.once('exit', code => { if (!closing) void close(code || 1); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close(); });
try { await web.listen(); web.printUrls(); } catch (error) { await close(1); throw error; }
