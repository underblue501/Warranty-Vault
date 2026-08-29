import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const APP_URL =
  'file://' + path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');

/* The app is a single dependency-free HTML file with no build step, so its
   functions are only reachable inside a real page. Tests drive it through a
   browser rather than importing it, which also exercises the browser's own
   Date and Intl behaviour — the source of most of what these tests cover. */
export async function withPage(opts, fn){
  const { init, goto, ...contextOptions } = opts;
  const browser = await chromium.launch();
  const context = await browser.newContext({ locale: 'en-US', ...contextOptions });
  const page = await context.newPage();
  /* Errors thrown by the app itself. The browser also logs failed network
     requests to the console, which several tests provoke deliberately, so
     resource-loading noise is excluded — it is not an app defect. */
  const errors = [];
  const isNetworkNoise = t => /Failed to load resource|net::ERR_/.test(t);
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if(m.type() === 'error' && !isNetworkNoise(m.text())) errors.push('console: ' + m.text());
  });
  page.uncaughtErrors = errors;
  if(init) await page.addInitScript(init);
  if(goto !== false) await page.goto(APP_URL);
  try { return await fn(page); }
  finally { await browser.close(); }
}
