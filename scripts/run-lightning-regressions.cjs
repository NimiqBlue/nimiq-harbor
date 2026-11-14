// Fresh fixture-key build + actual unconfigured server, no public API writes.
const { spawn, spawnSync } = require('node:child_process');
const { createServer } = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const work = path.join(root, 'artifacts/lightning-server');
const dist = path.join(work, 'dist');
function run(script, args = [], env = {}) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root, env: { ...process.env, ...env }, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, script);
}
(async () => {
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(root, 'artifacts/lightning'), { recursive: true });
  run('node_modules/vite/bin/vite.js', ['build', '--outDir', dist], { VITE_MTPELERIN_KEY: 'synthetic-test-key' });
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'src/server/start.ts')], {
    cwd: work, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PORT: String(port), HOST: '127.0.0.1', APP_ORIGIN: origin, FUSION_EXECUTION_ENABLED: 'false' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', x => { stderr += x; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw Error(stderr);
      try { const response = await fetch(origin + '/api/health'); if (response.ok) { assert.equal((await response.json()).configured, false); ready = true; break; } } catch { /* wait for owned child */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'actual local API starts');
    const response = await fetch(origin);
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /connect-src[^;]*https:\/\/api\.go\.fastspot\.io/);
    assert.match(csp, /frame-src https:\/\/widget\.mtpelerin\.com/);
    for (const script of ['scripts/browser-lightning.cjs', 'scripts/browser-lightning-cancellation.cjs']) run(script, [], { LIGHTNING_TEST_ORIGIN: origin });
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
