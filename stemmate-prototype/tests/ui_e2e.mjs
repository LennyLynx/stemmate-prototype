// Browser end-to-end test (Chromium via Playwright). Run: node tests/ui_e2e.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + extra)); };

const srv = spawn('python', [path.join(here, 'serve_for_tests.py')], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((r) => srv.stdout.once('data', (d) => r(String(d).trim().split(' ')[1])));
const base = 'http://127.0.0.1:' + port;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(base);
  check('U01 sign-in screen shown first', await page.locator('h1', { hasText: 'Sign in' }).count() === 1);
  await page.fill('#code', 'FAC-01'); await page.fill('#pin', '0000'); await page.click('button[type=submit]');
  await page.waitForSelector('#signin-msg:not([hidden])');
  check('U02 wrong PIN gives neutral message', (await page.textContent('#signin-msg')).includes('not correct'));
  await page.fill('#code', 'FAC-01'); await page.fill('#pin', '4821'); await page.click('button[type=submit]');
  await page.waitForSelector('text=Browse activities');
  check('U03 signed in, home shown', true);
  check('U04 banner says Online (real health check)', (await page.textContent('#banner')).includes('Online'));
  await page.click('nav >> text=Activities');
  await page.waitForSelector('text=Paper Bridge Challenge');
  check('U05 activities load from the backend', await page.locator('.card h2').count() === 12);
  await page.click('.card:has-text("Paper Bridge") >> text=Use in a new plan');
  check('U06 activity pre-fills plan title', (await page.inputValue('#f-title')) === 'Paper bridge challenge');
  // invalid save: field-level errors, focus, values kept
  await page.fill('#f-title', ''); await page.fill('#f-durationMin', '3'); await page.fill('#f-learnerCount', '20');
  await page.fill('#f-materials', 'call 081 123 4567'); await page.selectOption('#f-subject', 'Physical Science');
  await page.click('button:has-text("Save plan")');
  await page.waitForSelector('#summary');
  const errs = await page.locator('.err').allTextContents();
  check('U07 errors shown next to fields', errs.some(e => e.includes('Enter a lesson title')) && errs.some(e => e.includes('5 to 240')) && errs.some(e => e.includes('contact or ID')));
  check('U08 phone number is not echoed in any message', !errs.join(' ').includes('4567'));
  check('U09 other answers are kept', (await page.inputValue('#f-learnerCount')) === '20');
  check('U10 first invalid field has aria-invalid', (await page.getAttribute('#f-title', 'aria-invalid')) === 'true');
  // go offline (demo switch), save valid plan
  await page.click('#demoOffline');
  await page.waitForSelector('#banner.offline');
  await page.fill('#f-title', 'Bridge test'); await page.fill('#f-durationMin', '30'); await page.fill('#f-materials', 'Paper, coins');
  await page.fill('#f-safety', 'Blunt scissors'); await page.fill('#f-inclusion', 'Large print'); await page.fill('#f-steps', 'Fold and test');
  await page.click('button:has-text("Save plan")');
  await page.waitForSelector('.badge.waiting');
  check('U11 offline save shows "Saved on this device — waiting to sync"', (await page.textContent('.badge.waiting')).includes('waiting to sync'));
  check('U12 nothing is labelled Synced while offline', await page.locator('.badge.synced').count() === 0);
  await page.reload();                                           // restart the page while offline-demo
  await page.waitForSelector('text=Browse activities');
  await page.click('nav >> text=Plans');
  check('U13 plan survives reload with all fields', (await page.textContent('#app')).includes('Paper, coins') && (await page.textContent('#app')).includes('Large print'));
  // back online -> real sync
  await page.click('button:has-text("Sync now")');
  await page.waitForSelector('.badge.synced', { timeout: 8000 });
  check('U14 after sync the badge says Synced', (await page.textContent('.badge.synced')).includes('Synced'));
  const tok = await page.evaluate(() => JSON.parse(sessionStorage.getItem('stemmate:session')).t);
  const lessons = await (await fetch(base + '/api/lessons', { headers: { Authorization: 'Bearer ' + tok } })).json();
  check('U15 the lesson is really on the server with all fields', lessons.lessons.length === 1 && lessons.lessons[0].materials === 'Paper, coins' && lessons.lessons[0].inclusion === 'Large print');
  // keyboard: tab reaches buttons, focus ring visible
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle + ' ' + getComputedStyle(document.activeElement).outlineWidth);
  check('U16 keyboard focus is visible', outline.includes('solid') && outline.includes('3px'), outline);
  // real conflict: change the lesson on the server from "another device", then edit locally
  await page.click('button[aria-label="Edit Bridge test"]');
  await fetch(base + '/api/lessons/' + lessons.lessons[0].lessonId, { method: 'PUT', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...lessons.lessons[0], title: 'Changed elsewhere', baseVersion: 1 }) });
  await page.click('#demoOffline');                               // offline again so the edit stays local
  await page.fill('#f-title', 'Edited on phone'); await page.click('button:has-text("Save plan")');
  await page.click('#demoOffline');                               // back online
  await page.click('button:has-text("Sync now")');
  await page.waitForSelector('.badge.conflict', { timeout: 8000 });
  check('U17 stale edit shows a real conflict with both versions', (await page.textContent('#app')).includes('Changed elsewhere') && (await page.textContent('#app')).includes('Edited on phone'));
  await page.click('button:has-text("Keep my phone version")');
  await page.waitForSelector('.badge.synced', { timeout: 8000 });
  const after = await (await fetch(base + '/api/lessons', { headers: { Authorization: 'Bearer ' + tok } })).json();
  check('U18 keep-phone resolves on the server (version 3)', after.lessons[0].title === 'Edited on phone' && after.lessons[0].version === 3);
  // sign out -> protected access denied
  await page.click('nav >> text=Account'); await page.click('button:has-text("Sign out")', { strict: false });
  await page.waitForSelector('h1:has-text("Sign in")');
  const denied = await fetch(base + '/api/lessons', { headers: { Authorization: 'Bearer ' + tok } });
  check('U19 after sign-out the old token gets 401 and the sign-in screen shows', denied.status === 401);
  check('U20 no script errors in the page', errors.length === 0, errors.join(' | '));
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!r; });
  check('U21 service worker registered', sw);
} catch (e) { console.log('ERROR', e.message); results.push(['crash', false]); }
await browser.close(); srv.kill();
const failed = results.filter(r => !r[1]).length;
console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
