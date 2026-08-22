/**
 * xueqiu-login.mjs
 *
 * One-off helper: logs xueqiu.com into the shared Chrome profile
 * (../chrome_user_data) via QR-code login, so that scrape-blog-feeds.mjs
 * can later scrape xueqiu headlessly with the saved session.
 *
 * Usage (headless server — requires Xvfb):
 *   xvfb-run -a node invest_info_scrape/xueqiu-login.mjs
 *
 * The xueqiu login QR code is rendered as ASCII in the terminal.
 * Scan it with the 雪球 App (我的 -> 扫一扫) and confirm login on the phone.
 * The script detects the login, prints the resulting cookies, and exits.
 */

import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import qrcodeTerminal from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../chrome_user_data');
const TIMEOUT_MS = 5 * 60 * 1000;

if (!process.env.DISPLAY) {
  console.error('No DISPLAY set. Run under Xvfb, e.g.:');
  console.error('  xvfb-run -a node invest_info_scrape/xueqiu-login.mjs');
  process.exit(1);
}
fs.mkdirSync(PROFILE, { recursive: true });

function decodeQrFromPng(buffer) {
  try {
    const png = PNG.sync.read(buffer);
    const res = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    return res?.data || null;
  } catch {
    return null;
  }
}

async function extractQrPayload(page) {
  // The login QR is rendered as a ~230px <canvas>; fall back to QR-ish <img>s.
  const candidates = [
    ...(await page.$$('canvas')),
    ...(await page.$$('img'))
  ];
  for (const el of candidates) {
    try {
      const meta = await el.evaluate((e) => ({
        src: e.src || '', alt: e.alt || '', cls: String(e.className || ''),
        w: e.clientWidth, h: e.clientHeight, visible: e.offsetParent !== null
      }));
      if (!meta.visible || meta.w < 80 || meta.h < 80) continue;
      const isCanvas = await el.evaluate((e) => e.tagName === 'CANVAS');
      const looksQr = isCanvas
        || /qr|qrcode|scan/i.test(meta.src + meta.alt + meta.cls)
        || Math.abs(meta.w - meta.h) < 20;
      if (!looksQr) continue;
      const shot = await el.screenshot({ timeout: 3000 });
      const payload = decodeQrFromPng(shot);
      if (payload) return payload;
    } catch { /* element detached etc. */ }
  }
  return null;
}

async function isLoggedIn(context) {
  const cookies = await context.cookies('https://www.xueqiu.com');
  const get = (n) => cookies.find((c) => c.name === n)?.value;
  const u = get('u');
  const cookiesu = get('cookiesu');
  // Guest sessions have u == cookiesu; a real login gives u = numeric user id.
  return !!(get('xq_a_token') && u && cookiesu && u !== cookiesu);
}

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
  });
  const page = context.pages()[0] || await context.newPage();

  console.log('Opening xueqiu homepage (login panel is embedded on the right)...');
  try {
    await page.goto('https://xueqiu.com/', {
      waitUntil: 'domcontentloaded', timeout: 45000
    });
  } catch (e) {
    console.warn(`[warn] initial navigation: ${e.message} — continuing anyway.`);
  }
  console.log('Page loaded, waiting for login panel...');
  await page.waitForTimeout(4000);
  // Switch the embedded login panel to the QR-code tab.
  try {
    await page.locator('text=二维码登录').first().click({ timeout: 8000 });
  } catch {
    console.warn('[warn] could not click 二维码登录 tab — will still look for a QR image.');
  }

  const deadline = Date.now() + TIMEOUT_MS;
  let lastPayload = null;

  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);

    if (await isLoggedIn(context)) {
      console.log('\n✅ Login detected!');
      const cookies = await context.cookies('https://www.xueqiu.com');
      const wanted = ['xq_a_token', 'xq_r_token', 'xqat', 'xq_id_token', 'u', 'device_id'];
      const cookieStr = cookies
        .filter((c) => wanted.includes(c.name))
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
      console.log('\nCookies (also usable as a "cookies" entry in conf.json):');
      console.log(`  "xueqiu.com": "${cookieStr}"`);
      await context.close();
      console.log(`\nSession saved to profile: ${PROFILE}`);
      console.log('You can now run scrape-blog-feeds.mjs headlessly.');
      return;
    }

    const payload = await extractQrPayload(page);
    if (payload && payload !== lastPayload) {
      lastPayload = payload;
      console.log('\n===== Scan this QR code with the 雪球 App (我的 → 扫一扫) =====\n');
      qrcodeTerminal.generate(payload, { small: true });
      console.log('\n(QR refreshes periodically — it will be re-printed if it changes.)\n');
    }
  }

  console.error('\nTimed out waiting for login.');
  await context.close();
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
