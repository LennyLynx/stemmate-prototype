// T06 retest: load online once, switch the BROWSER network off, reload. Run: node tests/ui_offline_reload.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const srv = spawn('python3', [path.join(here, 'serve_for_tests.py')], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((r) => srv.stdout.once('data', (d) => r(String(d).trim().split(' ')[1])));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
const page = await ctx.newPage();
let ok = false, why = '';
try {
  await page.goto('http://127.0.0.1:' + port);
  await page.fill('#code', 'FAC-01'); await page.fill('#pin', '4821'); await page.click('button[type=submit]');
  await page.waitForSelector('text=Browse activities');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('text=Browse activities', { timeout: 8000 });
  const banner = await page.textContent('#banner');
  ok = banner.includes('Offline'); why = banner;
} catch (e) { why = e.message; }
console.log((ok ? 'PASS' : 'FAIL') + ' T06-retest app reloads with the browser network off; banner: ' + why);
await browser.close(); srv.kill(); process.exit(ok ? 0 : 1);
