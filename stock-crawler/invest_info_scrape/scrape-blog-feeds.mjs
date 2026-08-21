/**
 * scrape-blog-feeds.mjs
 *
 * Scrapes the most recent N hours (default 24) of posts from each blog/feed
 * link listed in conf.json and writes one Markdown file per link.
 *
 * Supported sites:
 *   - xueqiu.com user pages   (https://www.xueqiu.com/u/<user_id>)
 *   - weibo.com user feeds    (https://weibo.com/u/<uid>?tabtype=feed)
 *   - xcancel.com user pages  (https://xcancel.com/<username>, Nitter-style HTML)
 *
 * Config: conf.json (next to package.json by default, or pass a path as argv[2])
 *   {
 *     "outputDir":   "./output/blog-feeds",   // base dir; .md files go to outputDir/<YYYY-MM-DD>/
 *     "userDataDir": "./chrome_user_data",    // Chrome profile with login cookies
 *     "hours":       24,                       // time window
 *     "headless":    true,
 *     "scrollTimes": 6,                        // xcancel: max timeline pages to fetch
 *     "scrollDelayMs": 2500,
 *     "proxy":       "http://127.0.0.1:4080",  // optional proxy for xcancel RSS requests
 *     "browserProxy": null,                    // optional proxy for the browser (xueqiu/weibo).
 *                                              // NOTE: do NOT route xueqiu through an overseas
 *                                              // proxy — its WAF serves a JS challenge instead
 *                                              // of JSON and scraping silently returns nothing.
 *     "links":       [ "https://...", ... ]
 *   }
 *
 * NOTE: xueqiu/weibo require a logged-in Chrome profile. Run once with
 * "headless": false and log in manually if the profile has no valid cookies.
 * xcancel.com is scraped via its RSS feed (no login, no browser); the HTML
 * pages sit behind an anti-bot challenge that headless Chrome cannot pass.
 */

import { chromium, request as pwRequest } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const configPath = path.resolve(process.cwd(), process.argv[2] || path.join(ROOT, 'conf.json'));
if (!fs.existsSync(configPath)) {
  console.error(`Config file not found: ${configPath}`);
  process.exit(1);
}
const conf = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const DATE = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai' }).format(new Date()).replace(/\//g, '-');
const OUTPUT_DIR = path.join(
  path.resolve(path.dirname(configPath), conf.outputDir || './output/blog-feeds'),
  DATE
);
const USER_DATA_DIR = conf.userDataDir ? path.resolve(path.dirname(configPath), conf.userDataDir) : null;
const HOURS = conf.hours || 24;
const HEADLESS = conf.headless !== false;
const SCROLL_TIMES = conf.scrollTimes ?? 6;
const SCROLL_DELAY = conf.scrollDelayMs ?? 2500;
const LINKS = conf.links || [];
const PROXY = conf.proxy || null;               // used for xcancel RSS requests
const BROWSER_PROXY = conf.browserProxy || null; // used for the browser (xueqiu/weibo)

if (!LINKS.length) {
  console.error('conf.json contains no links.');
  process.exit(1);
}
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const SINCE = Date.now() - HOURS * 3600 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fmtTime = (ms) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(ms));

const stripHtml = (html = '') =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function classifyLink(url) {
  if (/xueqiu\.com/.test(url)) return 'xueqiu';
  if (/weibo\.com/.test(url)) return 'weibo';
  if (/xcancel\.com/.test(url)) return 'xcancel';
  return null;
}

function siteId(url) {
  const m = url.match(/\/u\/(\d+)/) || url.match(/weibo\.com\/(\d+)/) || url.match(/xueqiu\.com\/(\d+)/)
    || url.match(/xcancel\.com\/([A-Za-z0-9_]+)/);
  return m ? m[1] : url.replace(/\W+/g, '_').slice(-40);
}

// ---------------------------------------------------------------------------
// Xueqiu
// ---------------------------------------------------------------------------
function parseXueqiuStatuses(json) {
  // Handle both response shapes:
  //   { statuses: [ {created_at, text, ...} ] }
  //   { list: [ { data: "<json string>" | {...} } ] }
  let items = [];
  if (Array.isArray(json?.statuses)) {
    items = json.statuses;
  } else if (Array.isArray(json?.list)) {
    items = json.list
      .map((it) => {
        let d = it?.data ?? it;
        if (typeof d === 'string') {
          try { d = JSON.parse(d); } catch { return null; }
        }
        return d;
      })
      .filter(Boolean);
  }
  return items
    .filter((s) => s && s.created_at)
    .map((s) => ({
      ts: Number(s.created_at),
      author: s.user?.screen_name || '',
      title: s.title || '',
      text: stripHtml(s.text || s.description || ''),
      url: `https://xueqiu.com/${s.user_id || s.user?.id || ''}/${s.id}`
    }));
}

// ---------------------------------------------------------------------------
// Weibo
// ---------------------------------------------------------------------------
function parseWeiboStatuses(json) {
  const list = json?.data?.list || [];
  return list
    .filter((s) => s && s.created_at)
    .map((s) => {
      const ts = new Date(s.created_at).getTime();
      let text = stripHtml(s.text_raw || s.text || '');
      if (s.retweeted_status) {
        const rt = s.retweeted_status;
        const rtAuthor = rt.user?.screen_name || '原微博';
        text += `\n\n> 转发 @${rtAuthor}: ${stripHtml(rt.text_raw || rt.text || '')}`;
      }
      return {
        ts,
        author: s.user?.screen_name || '',
        title: '',
        text,
        url: `https://weibo.com/${s.user?.id || ''}/${s.bid || s.id}`,
        needLongText: !!s.isLongText,
        longTextId: s.id
      };
    });
}

async function fetchWeiboLongText(page, id) {
  try {
    return await page.evaluate(async (mid) => {
      const r = await fetch(`https://weibo.com/ajax/statuses/longtext?id=${mid}`, {
        credentials: 'include'
      });
      const j = await r.json();
      return j?.data?.longTextContent || null;
    }, id);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Xcancel (Nitter-style). The HTML pages sit behind an anti-bot challenge that
// headless Chrome cannot pass, so we use the RSS feed instead:
//   https://xcancel.com/<user>/rss  ->  https://rss.xcancel.com/<user>/rss
// The RSS host only serves whitelisted RSS-reader User-Agents.
// ---------------------------------------------------------------------------
const RSS_UA = 'FreshRSS/1.24 (Linux; https://freshrss.org)';

function decodeEntities(s = '') {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function pickTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return '';
  return m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
}

async function scrapeXcancelRss(link, posts) {
  const username = link.match(/xcancel\.com\/([A-Za-z0-9_]+)/)?.[1];
  if (!username) {
    console.warn(`  [skip] cannot parse xcancel username from ${link}`);
    return;
  }
  const req = await pwRequest.newContext({
    ...(PROXY ? { proxy: { server: PROXY } } : {}),
    extraHTTPHeaders: { 'User-Agent': RSS_UA }
  });
  let xml;
  try {
    const res = await req.get(`https://xcancel.com/${username}/rss`, {
      maxRedirects: 5,
      timeout: 60000
    });
    if (!res.ok()) {
      console.error(`  [error] RSS fetch failed: HTTP ${res.status()}`);
      return;
    }
    xml = await res.text();
  } catch (e) {
    console.error(`  [error] RSS fetch failed: ${e.message}`);
    return;
  } finally {
    await req.dispose();
  }

  if (/not yet whitelisted/i.test(xml)) {
    console.error('  [error] RSS reader UA rejected by rss.xcancel.com');
    return;
  }

  const channelTitle = decodeEntities(pickTag(xml.split('<item>')[0], 'title'));
  const feedAuthor = channelTitle.split('/')[0].trim() || `@${username}`;

  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const ts = Date.parse(pickTag(block, 'pubDate'));
    if (Number.isNaN(ts)) continue;
    const rawLink = pickTag(block, 'link').trim();
    const url = rawLink
      .replace(/^https?:\/\/rss\.xcancel\.com/, 'https://xcancel.com')
      .replace(/#.*$/, '');
    if (!url || posts.has(url)) continue;
    const titleText = decodeEntities(pickTag(block, 'title'));
    const isRetweet = titleText.startsWith('RT by @');
    const body = stripHtml(pickTag(block, 'description')) || titleText;
    posts.set(url, {
      ts,
      author: feedAuthor,
      title: '',
      text: isRetweet ? `🔁 Retweeted by @${username}:\n\n${body}` : body,
      url
    });
  }
}

// ---------------------------------------------------------------------------
// Main scrape for one link
// ---------------------------------------------------------------------------
function looksLikeLoginWall(text) {
  return /登录后查看|请登录后使用|立即登录|passport\.weibo|登录\/注册/.test(text);
}

async function scrapeLink(context, link) {
  const site = classifyLink(link);
  if (!site) {
    console.warn(`  [skip] unsupported site: ${link}`);
    return null;
  }

  const page = site === 'xcancel' ? null : await context.newPage();
  const posts = new Map(); // url -> post (dedupe)

  console.log(`\n>>> ${site}: ${link}`);

  // xcancel needs no browser — fetch the RSS feed directly.
  if (site === 'xcancel') {
    await scrapeXcancelRss(link, posts);
    const all = [...posts.values()].filter((p) => p.ts >= SINCE);
    all.sort((a, b) => b.ts - a.ts);
    console.log(`  collected ${posts.size} posts total, ${all.length} within last ${HOURS}h`);
    return { site, link, posts: all };
  }

  // Intercept the JSON APIs the page itself calls.
  page.on('response', async (res) => {
    const u = res.url();
    try {
      if (site === 'xueqiu' && /statuses\/(origin\/)?timeline|user_timeline/.test(u) && res.request().resourceType() !== 'document') {
        const json = await res.json().catch(() => null);
        for (const p of parseXueqiuStatuses(json || {})) {
          if (!posts.has(p.url)) posts.set(p.url, p);
        }
      } else if (site === 'weibo' && /ajax\/statuses\/mymblog/.test(u)) {
        const json = await res.json().catch(() => null);
        for (const p of parseWeiboStatuses(json || {})) {
          if (!posts.has(p.url)) posts.set(p.url, p);
        }
      }
    } catch { /* ignore individual response errors */ }
  });

  try {
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    // Check for login wall
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
    if (looksLikeLoginWall(bodyText)) {
      console.warn('  [warn] page requires login — log in via the chrome_user_data profile,');
      console.warn('         or add a "cookies" entry for this site in conf.json (see README note).');
    }

    // Scroll to trigger loading of older posts
    for (let i = 0; i < SCROLL_TIMES; i++) {
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(SCROLL_DELAY);
      // Stop early if the oldest post we have is already outside the window
      const oldest = Math.min(...[...posts.values()].map((p) => p.ts), Infinity);
      if (posts.size > 0 && oldest < SINCE) break;
    }
  } catch (e) {
    console.error(`  [error] navigation failed: ${e.message}`);
  }

  // Expand weibo long texts (must be done while page is alive, for cookies)
  const all = [...posts.values()].filter((p) => p.ts >= SINCE);
  if (site === 'weibo') {
    for (const p of all) {
      if (p.needLongText) {
        const long = await fetchWeiboLongText(page, p.longTextId);
        if (long) p.text = stripHtml(long) + (p.text.includes('转发 @') ? p.text.slice(p.text.indexOf('\n\n> 转发')) : '');
      }
    }
  }

  await page.close();
  if (posts.size === 0 && site === 'xueqiu') {
    console.warn('  [warn] no xueqiu data captured. If "browserProxy" is set, xueqiu\'s WAF');
    console.warn('         is likely serving a JS challenge instead of JSON — remove the proxy.');
  }
  all.sort((a, b) => b.ts - a.ts);
  console.log(`  collected ${posts.size} posts total, ${all.length} within last ${HOURS}h`);
  return { site, link, posts: all };
}

// ---------------------------------------------------------------------------
// Markdown output
// ---------------------------------------------------------------------------
function writeMarkdown(result) {
  const { site, link, posts } = result;
  const id = siteId(link);
  const author = posts[0]?.author || id;

  const lines = [];
  lines.push(`# ${author} — ${site} 最近${HOURS}小时动态`);
  lines.push('');
  lines.push(`- 来源: ${link}`);
  lines.push(`- 抓取时间: ${fmtTime(Date.now())} (Asia/Shanghai)`);
  lines.push(`- 时间窗口: ${fmtTime(SINCE)} 起, 共 ${posts.length} 条`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (!posts.length) {
    lines.push('_最近时间窗口内没有新消息。_');
  }
  for (const p of posts) {
    lines.push(`## ${fmtTime(p.ts)}${p.title ? ` — ${p.title}` : ''}`);
    lines.push('');
    lines.push(p.text || '_(无文本内容)_');
    lines.push('');
    lines.push(`[原文链接](${p.url})`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  const file = path.join(OUTPUT_DIR, `${site}_${id}.md`);
  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  console.log(`  wrote ${file}`);
  return file;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
async function main() {
  const launchOptions = {
    headless: HEADLESS,
    channel: 'chrome',
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    ...(BROWSER_PROXY ? { proxy: { server: BROWSER_PROXY } } : {}),
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  };
  if (PROXY) console.log(`Using proxy (RSS): ${PROXY}`);
  if (BROWSER_PROXY) console.log(`Using proxy (browser): ${BROWSER_PROXY}`);

  // Only launch Chrome if some link actually needs it (xueqiu/weibo).
  const needsBrowser = LINKS.some((l) => ['xueqiu', 'weibo'].includes(classifyLink(l)));
  let context = null;
  if (needsBrowser && USER_DATA_DIR && fs.existsSync(USER_DATA_DIR)) {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
  } else if (needsBrowser) {
    console.warn('[warn] userDataDir not found — launching without login cookies.');
    const browser = await chromium.launch(launchOptions);
    context = await browser.newContext({ viewport: launchOptions.viewport, locale: 'zh-CN' });
  }

  // Optional: inject raw cookie strings from conf.json, e.g.
  //   "cookies": { "weibo.com": "SUB=xxx; SUBP=yyy", "xueqiu.com": "xq_a_token=zzz" }
  // Useful when the chrome_user_data profile is not logged in.
  for (const [domain, cookieStr] of Object.entries(conf.cookies || {})) {
    if (!context) break;
    const cookies = String(cookieStr)
      .split(';')
      .map((kv) => kv.trim())
      .filter(Boolean)
      .map((kv) => {
        const i = kv.indexOf('=');
        return {
          name: kv.slice(0, i).trim(),
          value: kv.slice(i + 1).trim(),
          domain: domain.startsWith('.') ? domain : '.' + domain,
          path: '/'
        };
      })
      .filter((c) => c.name && c.value);
    if (cookies.length) {
      await context.addCookies(cookies);
      console.log(`Injected ${cookies.length} cookie(s) for ${domain}`);
    }
  }

  const written = [];
  for (const link of LINKS) {
    try {
      const result = await scrapeLink(context, link);
      if (result) written.push(writeMarkdown(result));
    } catch (e) {
      console.error(`  [error] ${link}: ${e.message}`);
    }
  }

  if (context) await context.close();
  console.log(`\nDone. ${written.length} markdown file(s) written to ${OUTPUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
