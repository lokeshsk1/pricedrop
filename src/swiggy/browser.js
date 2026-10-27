import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PROFILE_DIR = path.join(ROOT, 'data', 'browser-profile');

export const INSTAMART_URL = 'https://www.swiggy.com/instamart';

// Playwright's bundled Chromium advertises "HeadlessChrome" in its default UA,
// which is an obvious bot tell. Override with a stock desktop Chrome UA.
//
// NOTE: we deliberately use bundled Chromium rather than system Chrome. The
// Chrome installed here (152) is not launchable by Playwright 1.63 -- it dies
// with SIGKILL during the CDP handshake. Bundled Chromium loads Instamart
// fine and is not bot-blocked, so it is the working choice.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

let context = null;
let launching = null;

// Every browser operation funnels through this promise chain. A Chrome
// user-data-dir cannot be opened by two processes at once, and the scheduler
// can fire while a UI search is mid-flight, so all access must serialise.
let queue = Promise.resolve();

function launchOptions(headless) {
  return {
    headless,
    channel: 'chromium',
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    // Swiggy resolves the store from the saved address cookie, but it also
    // asks for geolocation; granting it avoids a permission prompt stalling
    // the headed login flow.
    permissions: ['geolocation'],
    args: ['--disable-blink-features=AutomationControlled'],
  };
}

/**
 * Launch (or reuse) the persistent context. The profile directory holds the
 * cookies established by `npm run login`, which is what makes headless
 * requests work at all.
 */
export async function getContext({ headless = true } = {}) {
  if (context) return context;
  if (launching) return launching;

  launching = chromium
    .launchPersistentContext(PROFILE_DIR, launchOptions(headless))
    .then((ctx) => {
      context = ctx;
      launching = null;
      // If Chrome dies or the user closes the window, drop our handle so the
      // next call relaunches instead of using a dead context.
      ctx.on('close', () => {
        if (context === ctx) context = null;
      });
      return ctx;
    })
    .catch((err) => {
      launching = null;
      throw err;
    });

  return launching;
}

/**
 * Run `fn(page)` against a warm page on swiggy.com, serialised against all
 * other browser use. The page is reused between calls so the bot-check
 * clearance and cookies stay warm.
 */
export function withPage(fn, opts = {}) {
  const run = async () => {
    const ctx = await getContext(opts);
    const page = ctx.pages()[0] || (await ctx.newPage());

    // Land on swiggy.com if we're not already there. Everything downstream
    // relies on being same-origin so in-page fetch() inherits cookies.
    if (!page.url().includes('swiggy.com')) {
      await page.goto(INSTAMART_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await page.waitForTimeout(1500);
    }

    return fn(page);
  };

  // Chain onto the queue, but don't let one failure poison the chain.
  const result = queue.then(run, run);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function getCookies() {
  const ctx = await getContext();
  return ctx.cookies('https://www.swiggy.com');
}

export async function closeBrowser() {
  const ctx = context;
  context = null;
  if (ctx) await ctx.close().catch(() => {});
}

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    await closeBrowser();
    process.exit(0);
  });
}
