// Run after npm run build. Only local files and intercepted requests are used.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function run(script, env = {}, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root, env: { ...process.env, REFRESH: '0', GATES: '0', UI_DIST: '', ...env }, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run('scripts/browser-defi-swap.cjs');
run('scripts/browser-defi-swap.cjs', { REFRESH: '1' });
run('scripts/browser-defi-swap.cjs', { GATES: '1' });
run('scripts/browser-approval-clarity.cjs');
// A separate build tests referral rendering with an inert activation marker.
// Never use a production key or replace the ordinary unconfigured dist build.
const widgetDist = path.join(root, 'artifacts/widget-dist');
run('node_modules/vite/bin/vite.js', { VITE_MTPELERIN_KEY: 'synthetic-test-key' }, ['build', '--outDir', widgetDist]);
run('scripts/browser-defi-swap.cjs', { GATES: '1', UI_DIST: widgetDist });
