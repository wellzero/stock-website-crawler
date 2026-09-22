/**
 * weibo-login.mjs
 *
 * One-off helper: logs weibo.com into the shared Chrome profile
 * (../chrome_user_data) via QR-code login, so that scrape-blog-feeds.mjs
 * can later scrape weibo headlessly with the saved session.
 *
 * Usage (headless server — requires Xvfb):
 *   xvfb-run -a node invest_info_scrape/weibo-login.mjs
 *
 * The weibo login QR code is rendered as ASCII in the terminal.
 * Scan it with the 微博 App (我 -> 扫一扫) and confirm login on the phone.
 * The script detects the login, prints the resulting cookies (paste them
 * into the "cookies" section of conf.json as a backup), and exits.
 *
 * NOTE: weibo's anonymous "visitor" cookies no longer work (the feed API
 * returns 403 for visitor sessions), so a real account login is required.
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
  console.error('  xvfb-run -a node invest_info_scrape/weibo-login.mjs');
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
  // The weibo passport QR is an <img> whose src contains "qrcode/image";
  // fall back to any QR-ish canvas/img (same heuristic as xueqiu-login.mjs).
  const candidates = [
    ...(await page.$$('img')),
    ...(await page.$$('canvas'))
  ];
  for (const el of candidates) {
    try {
      const meta = await el.evaluate((e) => ({
        src: e.src || '', alt: e.alt || '', cls: String(e.className || ''),
        w: e.clientWidth, h: e.clientHeight, visible: e.offsetParent !== null
      }));
      if (!meta.visible || meta.w < 80 || meta.h < 80) continue;
      const isQrImg = /qrcode|qr\/image|\/qr\?/i.test(meta.src);
      const isCanvas = await el.evaluate((e) => e.tagName === 'CANVAS');
      const looksQr = isQrImg
        || /qr|qrcode|scan/i.test(meta.alt + meta.cls)
        || (isCanvas && Math.abs(meta.w - meta.h) < 20);
      if (!looksQr) continue;
      const shot = await el.screenshot({ timeout: 3000 });
      const payload = decodeQrFromPng(shot);
      if (payload) return payload;
    } catch { /* element detached etc. */ }
  }
  return null;
}

async function isLoggedIn(context) {
  // Guest/visitor sessions get SUB/SUBP too, but only a real SSO login
  // sets SSOLoginState / ALF.
  const cookies = await context.cookies('https://weibo.com');
  const names = new Set(cookies.map((c) => c.name));
  return names.has('SSOLoginState') || names.has('ALF');
}

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
  });
  const page = context.pages()[0] || await context.newPage();

  if (await isLoggedIn(context)) {
    console.log('✅ Profile is already logged in to weibo.');
    await printCookies(context);
    await context.close();
    return;
  }

  console.log('Opening weibo passport login page...');
  try {
    await page.goto('https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog', {
      waitUntil: 'domcontentloaded', timeout: 45000
    });
  } catch (e) {
    console.warn(`[warn] initial navigation: ${e.message} — continuing anyway.`);
  }
  await page.waitForTimeout(3000);
  // Make sure the QR-code tab (扫码登录) is selected.
  for (const label of ['扫码登录', '二维码登录']) {
    try {
      await page.locator(`text=${label}`).first().click({ timeout: 4000 });
      break;
    } catch { /* tab not found or already active */ }
  }

  const deadline = Date.now() + TIMEOUT_MS;
  let lastPayload = null;

  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);

    if (await isLoggedIn(context)) {
      console.log('\n✅ Login detected!');
      await printCookies(context);
      await context.close();
      console.log(`\nSession saved to profile: ${PROFILE}`);
      console.log('You can now run scrape-blog-feeds.mjs headlessly.');
      return;
    }

    const payload = await extractQrPayload(page);
    if (payload && payload !== lastPayload) {
      lastPayload = payload;
      console.log('\n===== Scan this QR code with the 微博 App (我 → 扫一扫) =====\n');
      qrcodeTerminal.generate(payload, { small: true });
      console.log('\n(QR refreshes periodically — it will be re-printed if it changes.)\n');
    }
  }

  console.error('\nTimed out waiting for login.');
  await context.close();
  process.exit(1);
}

async function printCookies(context) {
  const cookies = await context.cookies('https://weibo.com');
  const wanted = ['SUB', 'SUBP', 'ALF', 'SSOLoginState', 'WBPSESS'];
  const cookieStr = cookies
    .filter((c) => wanted.includes(c.name))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  console.log('\nCookies (also usable as a "cookies" entry in conf.json):');
  console.log(`  "weibo.com": "${cookieStr}"`);
}

main().catch((e) => { console.error(e); process.exit(1); });
