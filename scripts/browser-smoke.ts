import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

// Real built frontend + real unconfigured backend. Wallet/RPC are synthetic;
// every external request is intercepted, all signatures/sends throw.
const probe = createServer();
await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = (probe.address() as { port: number }).port;
await new Promise<void>(resolve => probe.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PORT: String(port), HOST: '127.0.0.1', APP_ORIGIN: origin, FUSION_EXECUTION_ENABLED: 'false' };
const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/start.ts'], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Local server exited: ${stderr}`);
    try { const h = await fetch(`${origin}/api/health`); if (h.ok) { assert.equal((await h.json()).configured, false); ready = true; break; } } catch { /* await owned child startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'local API startup');
  const html = await fetch(origin);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy') || '', /frame-src https:\/\/widget\.mtpelerin\.com/);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  for (const width of [360, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin === origin && req.method() === 'GET') return route.continue();
      // Synthetic read-only fallback RPC; no outbound request is forwarded.
      if (req.method() === 'POST' && url.origin !== origin) {
        let data: unknown;
        try { data = req.postDataJSON(); } catch { return route.abort(); }
        const answer = (x: { id: unknown; method: string }) => {
          const read: Record<string, string> = { eth_blockNumber: '0x123456', eth_chainId: '0x89', eth_getBalance: '0xde0b6b3a7640000', eth_estimateGas: '0x5208', eth_gasPrice: '0x3b9aca00', eth_call: `0x${(100000000n).toString(16).padStart(64, '0')}` };
          assert.ok(read[x.method], `forbidden external method ${x.method}`);
          return { jsonrpc: '2.0', id: x.id, result: read[x.method] };
        };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(data) ? data.map(answer) : answer(data as { id: unknown; method: string })) });
      }
      return route.abort();
    });
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      const w = window as unknown as { ethereum: unknown; forbiddenCalls: string[] };
      w.forbiddenCalls = [];
      w.ethereum = { isMetaMask: true, on() {}, removeListener() {}, async request({ method }: { method: string }) {
        if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return ['0x1111111111111111111111111111111111111111'];
        if (method === 'eth_chainId') return '0x89';
        if (method === 'eth_gasPrice') return '0x3b9aca00';
        if (method === 'eth_estimateGas') return '0x5208';
        w.forbiddenCalls.push(method); throw new Error(`Forbidden wallet method ${method}`);
      } };
    });
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Swap tokens' }).waitFor();
    assert.equal(await page.locator('img[src*="/brands/"], img[src*="/icons/"], img[src*="/harbor"]').count(), 0);
    await page.getByRole('button', { name: 'Bank', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'activation key is not configured' }).waitFor();
    assert.equal(await page.locator('iframe').count(), 0);
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Swap', exact: true }).click();
    await page.getByRole('button', { name: '0.5%', exact: true }).click();
    await page.locator('#pay-amount').fill('999999999');
    const hint = page.locator('#swap-balance-hint');
    await hint.waitFor();
    const swapMetrics = await page.evaluate(() => {
      const hint = getComputedStyle(document.querySelector('#swap-balance-hint')!);
      const settings = document.querySelector('#swap-slippage')!;
      const style = getComputedStyle(settings);
      return { font: hint.fontSize, lineHeight: hint.lineHeight, margin: style.marginTop, padding: style.paddingTop,
        deadlineControls: settings.querySelectorAll('[id*="deadline"], [name*="deadline"], .swap-deadline').length };
    });
    assert.equal(swapMetrics.font, '16px');
    assert.equal(swapMetrics.lineHeight, '24px');
    assert.equal(swapMetrics.margin, '10px');
    assert.equal(swapMetrics.padding, '0px');
    assert.equal(swapMetrics.deadlineControls, 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    console.log(`PASS ${width}px Swap: 16px warning / 24px line-height, compact 10px settings margin, no deadline controls`);
    await page.getByRole('button', { name: 'Bank', exact: true }).click();
    await page.getByRole('button', { name: '0x1111…1111', exact: true }).click();
    await page.getByRole('button', { name: 'Pay with wallet', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Send Polygon tokens' });
    await dialog.waitFor();
    await dialog.getByLabel('Recipient address').fill('0x2222222222222222222222222222222222222222');
    for (const token of ['USDT0', 'USDC', 'POL', 'WBTC']) {
      const button = dialog.getByRole('button', { name: token, exact: true });
      await button.click(); assert.equal(await button.getAttribute('aria-pressed'), 'true');
    }
    await dialog.getByRole('button', { name: 'POL', exact: true }).click();
    await dialog.getByRole('button', { name: /Max/ }).click();
    await page.waitForFunction(() => (document.querySelector('input[inputmode="decimal"]') as HTMLInputElement)?.value !== '');
    await dialog.getByRole('button', { name: 'Review transfer', exact: true }).click();
    await dialog.getByText(/Estimated network fee/).waitFor();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { forbiddenCalls: string[] }).forbiddenCalls), []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: built app + actual API, Bank fail-closed, wallet/Pay tokens, POL Max and fee review, zero sends/signatures`);
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
}
