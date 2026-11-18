// Run with Node 24+: node tests/bank-widget.browser.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { build, preview } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const widgetOrigin = 'https://widget.mtpelerin.com';
const fixtureKey = 'synthetic-bank-browser-fixture';

async function withBuild(key, test) {
  const outDir = await mkdtemp(join(tmpdir(), 'harbor-bank-browser-'));
  let server;
  try {
    process.env.VITE_MTPELERIN_KEY = key;
    await build({ root, logLevel: 'error', build: { outDir } });
    server = await preview({ root, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    await test(`http://127.0.0.1:${server.httpServer.address().port}`);
  } finally {
    if (server) await new Promise(resolve => server.httpServer.close(resolve));
    await rm(outDir, { recursive: true, force: true });
  }
}

async function openBank(browser, origin, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname.startsWith('/api/')) return route.abort();
    if (url.origin === origin && request.method() === 'GET') return route.continue();
    if (url.origin === widgetOrigin && request.isNavigationRequest()) {
      return route.fulfill({ contentType: 'text/html', body: '<title>Bank fixture</title><input aria-label="Local draft">' });
    }
    return route.abort();
  });
  try {
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByRole('button', { name: 'Bank', exact: true }).click();
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function checkMode(page, mode) {
  const frame = page.locator('.external-bank .external-bank-widget:not([hidden]) iframe');
  await expect(frame).toHaveCount(1);
  await expect(frame).toBeVisible();
  await expect(page.locator('#bank-panel-' + mode).locator('iframe')).toBeVisible();
  const url = new URL(await frame.getAttribute('src'));
  const buy = mode === 'buy';
  const lightningAssets = buy ? 'USDT,USDC,BTC,POL,XAUt,PAXG,ETH,EURC' : 'USDT,USDC,BTC,POL,sat,XAUt,PAXG,ETH,EURC';
  const networks = buy ? 'matic_mainnet,mainnet,bitcoin_mainnet' : 'matic_mainnet,lightning_mainnet,mainnet,bitcoin_mainnet';
  assert.equal(url.origin, widgetOrigin);
  assert.equal(url.searchParams.get('_ctkn') === fixtureKey, true, 'test fixture configuration only');
  const addresses = url.searchParams.getAll('addr');
  assert.equal(buy ? addresses.length === 0 : addresses.length === 1 && addresses[0] === 'ln@invoice.pay', true);
  assert.equal(url.search.includes('addr=ln%40invoice.pay'), !buy);
  url.searchParams.delete('_ctkn');
  url.searchParams.delete('addr');
  assert.deepEqual([...url.searchParams].sort(), Object.entries({
    rfr: 'yZkss3Rs', tab: mode, tabs: mode,
    bsc: 'EUR', bdc: 'USDT', ssc: 'sat', sdc: 'EUR', wsc: 'sat', wdc: 'USDT',
    crys: lightningAssets, nets: networks, net: 'matic_mainnet', dnet: 'matic_mainnet',
    snet: buy ? 'matic_mainnet' : 'lightning_mainnet',
    [{ buy: 'bsa', sell: 'sda', swap: 'wda' }[mode]]: '100',
  }).sort());
}

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
try {
  await withBuild(fixtureKey, async origin => {
    for (const width of [320, 390, 1280]) {
      const { context, page } = await openBank(browser, origin, width);
      try {
        const tab = mode => page.getByRole('tab', { name: mode.toUpperCase(), exact: true });
        const frames = page.locator('.external-bank iframe');
        const sellDraft = page.frameLocator('#bank-panel-sell iframe').getByRole('textbox', { name: 'Local draft' });
        await expect(frames).toHaveCount(1);
        await expect(tab('sell')).toHaveAttribute('aria-selected', 'true');
        await checkMode(page, 'sell');
        const layout = await page.locator('.bank-mode-selector').evaluate(selector => {
          const sizes = [...selector.querySelectorAll('button')].map(button => button.getBoundingClientRect().width);
          return {
            fits: document.documentElement.scrollWidth <= innerWidth,
            equalPills: Math.max(...sizes) - Math.min(...sizes) < 1,
            pillColor: getComputedStyle(selector.querySelector('[aria-selected=true]')).backgroundColor,
            fillsCard: selector.getBoundingClientRect().width === selector.parentElement.clientWidth
              - parseFloat(getComputedStyle(selector.parentElement).paddingLeft)
              - parseFloat(getComputedStyle(selector.parentElement).paddingRight),
          };
        });
        assert.deepEqual(layout, { fits: true, equalPills: true, pillColor: 'rgb(5, 130, 202)', fillsCard: true });
        await sellDraft.fill('retained sell draft');
        await tab('sell').focus();
        await tab('sell').press('ArrowLeft');
        await expect(tab('buy')).toBeFocused();
        await expect(frames).toHaveCount(2);
        await checkMode(page, 'buy');
        await expect(page.locator('#bank-panel-sell')).toBeHidden();
        await tab('buy').press('End');
        await expect(tab('swap')).toBeFocused();
        await expect(frames).toHaveCount(3);
        await checkMode(page, 'swap');
        await tab('sell').click();
        await expect(sellDraft).toHaveValue('retained sell draft');

        const reload = page.getByRole('button', { name: 'Reload Mt Pelerin' });
        const retained = await frames.elementHandles();
        page.once('dialog', dialog => dialog.dismiss());
        await reload.click();
        assert.deepEqual(await Promise.all(retained.map(frame => frame.evaluate(element => element.isConnected))), [true, true, true]);
        await expect(sellDraft).toHaveValue('retained sell draft');
        page.once('dialog', dialog => dialog.accept());
        await reload.click();
        assert.deepEqual(await Promise.all(retained.map(frame => frame.evaluate(element => element.isConnected))), [false, false, false]);
        await expect(frames).toHaveCount(3);
        await checkMode(page, 'sell');
        await expect(sellDraft).toHaveValue('');
        for (const frame of retained) await frame.dispose();
        console.log(`PASS ${width}px: URL matrix, layout, lazy mount, retention, keyboard and reload`);
      } finally {
        await context.close();
      }
    }
  });
  await withBuild('', async origin => {
    const { context, page } = await openBank(browser, origin, 390);
    try {
      await expect(page.getByRole('alert').filter({ hasText: 'activation key is not configured' })).toBeVisible();
      await expect(page.locator('.external-bank iframe, .external-bank [role="tablist"]')).toHaveCount(0);
      console.log('PASS unconfigured build: no selector or provider request');
    } finally {
      await context.close();
    }
  });
} finally {
  await browser.close();
}
