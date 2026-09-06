/**
 * scrape-news.mjs
 *
 * Scrapes the investment-intelligence news/data sources listed in conf.json
 * (ported from the news-browse SKILL.md source list), one link at a time, and
 * writes one Markdown file per link to:
 *
 *   <outputDir>/<YYYY-MM-DD>/<outputSubDir>/<name>.md
 *
 * Each link entry in conf.json:
 *   {
 *     "name":     "01_yahoo_finance_news",   // output file stem
 *     "url":      "https://...",             // page to open
 *     "waitMs":   6000,                      // JS-render wait before extraction
 *     "proxy":    false,                     // optional: bypass conf proxy (CN sites)
 *     "blockedPattern": "Verification Required|...",  // optional regex: if the
 *                                              // extracted text matches, the page
 *                                              // is treated as blocked and each
 *                                              // "fallbacks" URL is tried in order
 *     "fallbacks": ["https://..."],           // optional alternative URLs
 *     "scrapeItems": true,                    // optional: extract individual news
 *                                              // item links from the listing page
 *                                              // and scrape each item into its own
 *                                              // md file under <name>/NNN_<slug>.md
 *     "itemLinkPattern": "/articles/",        // optional regex to select item URLs
 *                                              // (default: same-domain article-like
 *                                              // links with headline-length text)
 *     "maxItems":   10,                       // optional per-source item cap
 *     "itemWaitMs": 3000,                     // optional render wait for item pages
 *     "dateFallbackDays": 4                   // optional: if "url" contains
 *                                              // {YYMMDD}, try today then the
 *                                              // previous N days (Asia/Shanghai)
 *   }
 *
 * mode values:
 *   "browser"  (default) render in Chrome
 *   "fetch"    plain HTTP GET for static pages (charset auto-detected,
 *              e.g. Big5 for HKEX pages)
 *   "rss"      fetch an RSS/Atom feed; the listing md lists the items and,
 *              with "scrapeItems": true, each item's content (content:encoded
 *              or description) is written to <name>/NNN_<slug>.md directly
 *              from the feed — no per-item HTTP requests (useful for sources
 *              whose article pages are behind Cloudflare)
 *
 * Top-level conf.json keys:
 *   outputDir      base dir; files go to outputDir/<YYYY-MM-DD>/<outputSubDir>/
 *   outputSubDir   sub-folder name (default "news-raw")
 *   userDataDir    Chrome profile (optional, for cookies)
 *   headless       default true
 *   proxy          default proxy for the browser (overseas sites)
 *   defaultWaitMs  default render wait (default 6000)
 *   scrollTimes / scrollDelayMs   light scrolling to trigger lazy loading
 *   maxChars       per-page extraction budget (default 40000)
 *   maxItems       per-source news-item cap for scrapeItems (default 10)
 *   itemWaitMs     render wait for item pages (default 3000)
 *   links          array of link entries (see above)
 *
 * CLI flags (after the config path):
 *   --headed         run Chrome non-headless (use under Xvfb, DISPLAY=:99)
 *                    for sites with anti-bot challenges (never-headless rule)
 *   --only=a,b,c     scrape only the named link entries
 */

import { chromium, request as pwRequest } from 'playwright';
import { Defuddle } from 'defuddle/node';
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const configPath = path.resolve(process.cwd(), process.argv[2] || path.join(__dirname, 'conf.json'));
if (!fs.existsSync(configPath)) {
  console.error(`Config file not found: ${configPath}`);
  process.exit(1);
}
const conf = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// CLI flags: --headed (non-headless Chrome for anti-bot sites, run under Xvfb),
// --only=name1,name2 (scrape a subset of links)
const cliArgs = process.argv.slice(3);
const FORCE_HEADED = cliArgs.includes('--headed');
const ONLY = (cliArgs.find((a) => a.startsWith('--only=')) || '')
  .replace('--only=', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DATE = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date()).replace(/\//g, '-');

const OUTPUT_DIR = path.join(
  path.resolve(path.dirname(configPath), conf.outputDir || './output/news'),
  DATE,
  conf.outputSubDir || 'news-raw'
);
const USER_DATA_DIR = conf.userDataDir ? path.resolve(path.dirname(configPath), conf.userDataDir) : null;
const HEADLESS = FORCE_HEADED ? false : conf.headless !== false;
const PROXY = conf.proxy || null;
const DEFAULT_WAIT = conf.defaultWaitMs ?? 6000;
const SCROLL_TIMES = conf.scrollTimes ?? 2;
const SCROLL_DELAY = conf.scrollDelayMs ?? 2000;
const MAX_CHARS = conf.maxChars ?? 40000;
const MAX_ITEMS = conf.maxItems ?? 10;
const ITEM_WAIT = conf.itemWaitMs ?? 3000;
const LINKS = ONLY.length
  ? (conf.links || []).filter((l) => ONLY.includes(l.name))
  : conf.links || [];

if (!LINKS.length) {
  console.error('conf.json contains no links.');
  process.exit(1);
}
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fmtTime = (ms) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(ms));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Expand entry URLs: supports a {YYMMDD} date template (Asia/Shanghai).
 *  With dateFallbackDays, today is tried first, then previous days — for
 *  sources like HKEX whose daily files appear only after market close and
 *  are absent on weekends/holidays. */
function expandEntryUrls(entry) {
  const bases = [entry.url, ...(entry.fallbacks || [])];
  if (!bases.some((u) => u.includes('{YYMMDD}'))) return bases;
  const days = entry.dateFallbackDays ?? 4;
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: '2-digit', month: '2-digit', day: '2-digit',
  });
  const urls = [];
  for (let d = 0; d <= days; d++) {
    const ymd = fmt.format(new Date(Date.now() - d * 86400000)).replace(/\//g, '');
    for (const b of bases) urls.push(b.replace(/\{YYMMDD\}/g, ymd));
  }
  return urls;
}

/** Decode an HTTP body honouring a <meta charset> (e.g. Big5 for HKEX),
 *  since many legacy pages omit the charset in Content-Type. */
function decodeBody(buf) {
  const head = buf.subarray(0, 4096).toString('latin1');
  const m = head.match(/charset=["']?([\w-]+)/i);
  const charset = (m?.[1] || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** Extract readable markdown from HTML.
 *  Defuddle gives clean output for article-like pages, but drops headline
 *  lists/tables on dashboard-style pages — so pick whichever is longer. */
async function extractFromHtml(html, url, page) {
  let plain;
  if (page) {
    plain = {
      title: await page.title(),
      text: ((await page.evaluate(() => document.body?.innerText || '')) || '').trim()
    };
  } else {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;
    // Strip non-content nodes so script/style source doesn't pollute the text
    doc.querySelectorAll('script, style, noscript, svg').forEach((n) => n.remove());
    plain = {
      title: doc.title || '',
      text: (doc.body?.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim()
    };
  }
  try {
    const result = await Defuddle(new JSDOM(html, { url }), url, { markdown: true });
    const content = (result?.content || '').trim();
    if (content.length > 200 && content.length >= plain.text.length * 0.6) {
      return { title: result.title || plain.title, text: content };
    }
  } catch (e) {
    console.warn(`  [warn] defuddle extraction failed: ${e.message}`);
  }
  return plain;
}

// ---------------------------------------------------------------------------
// News-item link discovery
// ---------------------------------------------------------------------------
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'guccounter', 'guce_referrer', 'guce_referrer_sig', 'fbclid', 'gclid'
];

/** Heuristic: does this URL look like an article rather than a nav/tag page? */
function looksLikeArticle(u) {
  const p = u.pathname;
  if (/\.(jpg|jpeg|png|gif|svg|css|js|ico|pdf|xml|json)$/i.test(p)) return false;
  if (/\/(tag|tags|topic|topics|author|authors|category|categories|section|sections|video|videos|live|podcasts?|about|contact|subscribe|newsletters?|guides?|issues?)(\/|$)/i.test(p)) return false;
  const segs = p.split('/').filter(Boolean);
  if (segs.length < 2) return false;
  // Article URLs usually carry a numeric id/date or a long slug segment
  return /\d/.test(p) || segs.some((s) => s.length >= 12);
}

/** Collect candidate news-item links from a listing page (live DOM or static HTML). */
async function collectItemLinks(page, html, baseUrl, entry) {
  let anchors = [];
  try {
    if (page) {
      anchors = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]')).map((a) => ({
          href: a.href,
          text: ((a.innerText || a.textContent) || '').trim()
        }))
      );
    } else {
      const dom = new JSDOM(html, { url: baseUrl });
      anchors = Array.from(dom.window.document.querySelectorAll('a[href]')).map((a) => ({
        href: a.href, // JSDOM resolves relative hrefs against the document URL
        text: (a.textContent || '').trim()
      }));
    }
  } catch (e) {
    console.warn(`  [warn] item link collection failed: ${e.message}`);
    return [];
  }

  const pattern = entry.itemLinkPattern ? new RegExp(entry.itemLinkPattern) : null;
  const maxItems = entry.maxItems ?? MAX_ITEMS;
  const baseHost = new URL(baseUrl).hostname.replace(/^www\./, '');
  const seen = new Set();
  const items = [];
  for (const { href, text } of anchors) {
    let u;
    try { u = new URL(href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    // Canonicalize: drop hash and tracking params for dedupe
    u.hash = '';
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    const key = u.toString();
    if (seen.has(key)) continue;
    if (pattern) {
      if (!pattern.test(key)) continue;
    } else {
      const host = u.hostname.replace(/^www\./, '');
      const sameSite = host === baseHost || host.endsWith('.' + baseHost) || baseHost.endsWith('.' + host);
      if (!sameSite || !looksLikeArticle(u)) continue;
    }
    if ((text || '').length < 12) continue; // headline-length anchors only
    seen.add(key);
    items.push({ url: key, title: text.replace(/\s+/g, ' ').trim() });
    if (items.length >= maxItems) break;
  }
  return items;
}

// ---------------------------------------------------------------------------
// RSS mode
// ---------------------------------------------------------------------------
/** Strip HTML tags from an RSS description/content payload. */
function htmlToText(html) {
  const dom = new JSDOM(`<body>${html || ''}</body>`);
  return (dom.window.document.body.textContent || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

/** Fetch and parse an RSS/Atom feed. Items carry their full text from
 *  content:encoded/description, so no per-item page visits are needed. */
async function fetchRss(entry, url) {
  const useProxy = entry.proxy !== false && PROXY;
  const req = await pwRequest.newContext({
    ...(useProxy ? { proxy: { server: PROXY } } : {}),
    extraHTTPHeaders: {
      'User-Agent': entry.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
    }
  });
  try {
    const res = await req.get(url, { maxRedirects: 5, timeout: 60000 });
    const xml = decodeBody(await res.body());
    console.log(`  HTTP ${res.status()}, ${xml.length} bytes`);
    if (!res.ok()) return null;
    const dom = new JSDOM(xml, { contentType: 'text/xml' });
    const doc = dom.window.document;
    if (doc.querySelector('parsererror')) throw new Error('feed XML parse error');
    const channelTitle = doc.querySelector('channel > title')?.textContent?.trim()
      || doc.querySelector('feed > title')?.textContent?.trim() || '';
    const maxItems = entry.maxItems ?? MAX_ITEMS;
    const items = [];
    const nodes = doc.querySelectorAll('item').length
      ? Array.from(doc.querySelectorAll('item'))
      : Array.from(doc.querySelectorAll('entry')); // Atom
    for (const it of nodes) {
      const get = (sel) => it.querySelector(sel)?.textContent?.trim() || '';
      const contentNode = it.getElementsByTagName('content:encoded')[0];
      const descHtml = contentNode ? contentNode.textContent : get('description') || get('summary') || get('content');
      let link = get('link');
      if (!link) link = it.querySelector('link')?.getAttribute('href') || ''; // Atom
      items.push({
        title: get('title'),
        url: link,
        pubDate: get('pubDate') || get('published') || get('updated')
          || it.getElementsByTagName('dc:date')[0]?.textContent?.trim() || '',
        author: get('author') || it.getElementsByTagName('dc:creator')[0]?.textContent?.trim() || '',
        text: htmlToText(descHtml),
      });
      if (items.length >= maxItems) break;
    }
    return { channelTitle, items };
  } finally {
    await req.dispose();
  }
}

// ---------------------------------------------------------------------------
// Scrape one link entry (with fallbacks)
// ---------------------------------------------------------------------------
const MIN_CONTENT_CHARS = 200; // below this the page is treated as failed/blocked

async function tryUrl(contexts, entry, url) {
  const waitMs = entry.waitMs ?? DEFAULT_WAIT;
  const useProxy = entry.proxy !== false && PROXY;
  // In --headed mode, render even "fetch" entries in the real browser —
  // some sites (SEC) block non-browser User-Agents outright.
  const mode = FORCE_HEADED ? 'browser' : entry.mode || 'browser';

  // Plain HTTP fetch for static/tabular pages (e.g. SEC EDGAR, which requires
  // a declared User-Agent and serves no JS-rendered content).
  if (mode === 'fetch') {
    // SEC EDGAR requires a declared bot UA; other sites get a browser UA.
    const isSec = /(^|\.)sec\.gov/.test(new URL(url).hostname);
    const userAgent = entry.userAgent || (isSec
      ? conf.fetchUserAgent || 'stock-website-crawler research bot (contact: admin@example.com)'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    const req = await pwRequest.newContext({
      ...(useProxy ? { proxy: { server: PROXY } } : {}),
      extraHTTPHeaders: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    try {
      const res = await req.get(url, { maxRedirects: 5, timeout: 60000 });
      const html = decodeBody(await res.body());
      console.log(`  HTTP ${res.status()}, ${html.length} bytes`);
      if (!res.ok()) return null;
      const result = await extractFromHtml(html, url, null);
      const links = entry.scrapeItems ? await collectItemLinks(null, html, url, entry) : [];
      return { ...result, links };
    } finally {
      await req.dispose();
    }
  }

  const context = useProxy ? contexts.proxied : contexts.direct;
  const page = await context.newPage();
  try {
    // Optional: visit a lighter page on the same domain first to acquire
    // anti-bot clearance cookies (e.g. Cloudflare cf_clearance) before the
    // real target — some paths are challenged harder than others.
    if (entry.prefetch) {
      const pre = await context.newPage();
      try {
        await pre.goto(entry.prefetch, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await pre.waitForTimeout(Math.max(waitMs, 8000));
      } catch (e) {
        console.warn(`  [warn] prefetch ${entry.prefetch} failed: ${e.message}`);
      } finally {
        await pre.close().catch(() => {});
      }
    }
    await page.goto(url, {
      waitUntil: entry.waitUntil || 'domcontentloaded',
      timeout: 90000
    });
    await page.waitForTimeout(waitMs);

    // Light scrolling to trigger lazy-loaded content (item pages skip this
    // via scrollTimes: 0 — articles render fine without it)
    const scrollTimes = entry.scrollTimes ?? SCROLL_TIMES;
    for (let i = 0; i < scrollTimes; i++) {
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(SCROLL_DELAY);
    }

    let result = await extractFromHtml(await page.content(), url, page);

    // Headed mode: anti-bot interstitials (e.g. Cloudflare "Just a moment")
    // auto-resolve in a real browser — give the page a second chance.
    if (FORCE_HEADED) {
      const blockedRe = entry.blockedPattern ? new RegExp(entry.blockedPattern, 'i') : null;
      const bad = !result.text || result.text.length < MIN_CONTENT_CHARS ||
        (blockedRe && blockedRe.test(result.text.slice(0, 5000)));
      if (bad) {
        console.warn('  [headed] challenge not resolved yet, waiting 10s more...');
        await page.waitForTimeout(10000);
        await page.mouse.wheel(0, 2000);
        await page.waitForTimeout(2000);
        result = await extractFromHtml(await page.content(), url, page);
      }
    }
    const links = entry.scrapeItems ? await collectItemLinks(page, null, url, entry) : [];
    return { ...result, links };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeEntry(contexts, entry) {
  const name = entry.name || entry.url.replace(/\W+/g, '_').slice(-60);
  const urls = expandEntryUrls(entry);
  const blockedRe = entry.blockedPattern ? new RegExp(entry.blockedPattern, 'i') : null;
  const useProxy = entry.proxy !== false && PROXY;

  // RSS mode: parse the feed; items come straight from the feed payload.
  if (entry.mode === 'rss') {
    let lastError = null;
    for (const url of urls) {
      console.log(`\n>>> ${name}: ${url} (rss${useProxy ? ', proxy' : ', direct'})`);
      try {
        const feed = await fetchRss(entry, url);
        if (!feed || !feed.items.length) {
          lastError = 'RSS fetch failed or feed empty';
          continue;
        }
        console.log(`  parsed ${feed.items.length} RSS item(s)`);
        const text = feed.items
          .map((it, i) => `${i + 1}. [${it.title}](${it.url})` +
            (it.pubDate ? ` — ${it.pubDate}` : '') +
            (it.author ? ` (${it.author})` : '') +
            (it.text ? `\n\n${it.text.slice(0, 500)}` : ''))
          .join('\n\n');
        return {
          name, url, title: feed.channelTitle, text: text.slice(0, MAX_CHARS),
          rssItems: entry.scrapeItems ? feed.items : [],
        };
      } catch (e) {
        console.error(`  [error] ${url}: ${e.message}`);
        lastError = e.message;
      }
    }
    return { name, url: entry.url, title: '', text: '', error: lastError || 'all RSS URLs failed' };
  }

  let lastError = null;
  for (const url of urls) {
    console.log(`\n>>> ${name}: ${url} (${FORCE_HEADED || entry.mode !== 'fetch' ? 'browser' : 'fetch'}${entry.mode === 'fetch' && !FORCE_HEADED ? '' : useProxy ? ', proxy' : ', direct'})`);
    try {
      const got = await tryUrl(contexts, entry, url);
      if (!got) {
        lastError = 'HTTP request failed';
        continue;
      }
      const { title, text } = got;
      if (blockedRe && blockedRe.test(text.slice(0, 5000))) {
        console.warn('  [blocked] anti-bot challenge detected, trying next fallback...');
        lastError = 'blocked by anti-bot challenge';
        continue;
      }
      if (!text || text.length < MIN_CONTENT_CHARS) {
        console.warn(`  [warn] content too short (${text?.length || 0} chars), trying next fallback...`);
        lastError = `content too short (${text?.length || 0} chars)`;
        continue;
      }
      console.log(`  extracted ${text.length} chars`);
      const items = entry.scrapeItems ? (got.links || []) : [];
      if (entry.scrapeItems) console.log(`  found ${items.length} news item link(s)`);
      return { name, url, title, text: text.slice(0, MAX_CHARS), items };
    } catch (e) {
      console.error(`  [error] ${url}: ${e.message}`);
      lastError = e.message;
    }
  }
  return { name, url: entry.url, title: '', text: '', error: lastError || 'all URLs failed or blocked' };
}

// ---------------------------------------------------------------------------
// Markdown output
// ---------------------------------------------------------------------------
function writeMarkdown(result) {
  const lines = [];
  lines.push(`# ${result.title || result.name}`);
  lines.push('');
  lines.push(`- 来源: ${result.url}`);
  lines.push(`- 抓取时间: ${fmtTime(Date.now())} (Asia/Shanghai)`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(result.error ? `_抓取失败: ${result.error}_` : result.text || '_(无内容)_');

  const file = path.join(OUTPUT_DIR, `${result.name}.md`);
  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  console.log(`  wrote ${file}`);
  return file;
}

/** Filename-safe slug; keeps CJK characters. */
function slugify(text, fallback) {
  const s = (text || '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/g, '');
  return s || fallback;
}

function writeItemMarkdown(listing, item, result, index, dir) {
  const lines = [];
  lines.push(`# ${result.title || item.title}`);
  lines.push('');
  lines.push(`- 来源: ${item.url}`);
  lines.push(`- 列表页: ${listing.url}`);
  lines.push(`- 抓取时间: ${fmtTime(Date.now())} (Asia/Shanghai)`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(result.text || '_(无内容)_');

  const file = path.join(dir, `${String(index).padStart(3, '0')}_${slugify(result.title || item.title, `item-${index}`)}.md`);
  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  console.log(`    wrote ${file}`);
  return file;
}

/** Write RSS feed items directly (no HTTP — content comes from the feed). */
function writeRssItems(listing) {
  const dir = path.join(OUTPUT_DIR, listing.name);
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  listing.rssItems.forEach((it, i) => {
    const lines = [];
    lines.push(`# ${it.title}`);
    lines.push('');
    lines.push(`- 来源: ${it.url}`);
    lines.push(`- 列表页: ${listing.url}`);
    if (it.pubDate) lines.push(`- 发布时间: ${it.pubDate}`);
    if (it.author) lines.push(`- 作者: ${it.author}`);
    lines.push(`- 抓取时间: ${fmtTime(Date.now())} (Asia/Shanghai)`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(it.text || '_(无内容)_');
    const file = path.join(dir, `${String(i + 1).padStart(3, '0')}_${slugify(it.title, `item-${i + 1}`)}.md`);
    fs.writeFileSync(file, lines.join('\n'), 'utf-8');
    console.log(`    wrote ${file}`);
    written.push(file);
  });
  console.log(`  rss items done: ${written.length} written`);
  return written;
}

/** Scrape each news item link found on a listing page into its own md file. */
async function scrapeItems(contexts, entry, listing) {
  const dir = path.join(OUTPUT_DIR, listing.name);
  fs.mkdirSync(dir, { recursive: true });
  const blockedRe = entry.blockedPattern ? new RegExp(entry.blockedPattern, 'i') : null;
  // Item pages: shorter render wait, no prefetch, no scrolling
  const itemEntry = { ...entry, waitMs: entry.itemWaitMs ?? ITEM_WAIT, prefetch: null, scrollTimes: 0, scrapeItems: false };

  const written = [];
  let skipped = 0;
  for (let i = 0; i < listing.items.length; i++) {
    const item = listing.items[i];
    console.log(`  [item ${i + 1}/${listing.items.length}] ${item.url}`);
    try {
      const got = await tryUrl(contexts, itemEntry, item.url);
      if (!got) {
        console.warn('    [skip] HTTP request failed');
        skipped++;
        continue;
      }
      const { title, text } = got;
      if (blockedRe && blockedRe.test((text || '').slice(0, 5000))) {
        console.warn('    [skip] blocked by anti-bot challenge');
        skipped++;
        continue;
      }
      if (!text || text.length < MIN_CONTENT_CHARS) {
        console.warn(`    [skip] content too short (${text?.length || 0} chars)`);
        skipped++;
        continue;
      }
      console.log(`    extracted ${text.length} chars`);
      written.push(writeItemMarkdown(listing, item, { title, text: text.slice(0, MAX_CHARS) }, i + 1, dir));
    } catch (e) {
      console.warn(`    [skip] ${e.message}`);
      skipped++;
    }
    await sleep(1500); // be polite between items
  }
  console.log(`  items done: ${written.length} written, ${skipped} skipped`);
  return written;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
async function main() {
  const baseOptions = {
    headless: HEADLESS,
    channel: 'chrome',
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  };

  // Two contexts: one routed through the proxy (overseas sites), one direct
  // (CN sites like eastmoney, whose WAF dislikes overseas IPs).
  async function launchContext(proxy, profileSuffix) {
    const opts = proxy ? { ...baseOptions, proxy: { server: proxy } } : baseOptions;
    const profileDir = USER_DATA_DIR && fs.existsSync(USER_DATA_DIR)
      ? USER_DATA_DIR + profileSuffix
      : null;
    if (profileDir) return chromium.launchPersistentContext(profileDir, opts);
    const browser = await chromium.launch(opts);
    return browser.newContext({ viewport: baseOptions.viewport, locale: 'zh-CN' });
  }

  const contexts = {};
  const needsProxy = PROXY && LINKS.some((l) => l.proxy !== false);
  const needsDirect = LINKS.some((l) => l.proxy === false) || !PROXY;

  if (needsProxy) {
    console.log(`Using proxy: ${PROXY}`);
    contexts.proxied = await launchContext(PROXY, '-news-proxy');
  }
  if (needsDirect) {
    contexts.direct = await launchContext(null, '-news-direct');
  }
  if (!contexts.proxied) contexts.proxied = contexts.direct;
  if (!contexts.direct) contexts.direct = contexts.proxied;

  // Anti-detection: hide webdriver traces (helps Cloudflare/WSJ challenges).
  const stealth = () => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  };
  await contexts.proxied.addInitScript(stealth);
  if (contexts.direct !== contexts.proxied) await contexts.direct.addInitScript(stealth);

  const written = [];
  const failed = [];
  for (const entry of LINKS) {
    try {
      const result = await scrapeEntry(contexts, entry);
      if (result.error) failed.push(result.name);
      written.push(writeMarkdown(result));
      if (result.rssItems?.length) {
        try {
          writeRssItems(result);
        } catch (e) {
          console.error(`  [error] rss item writing for ${entry.name}: ${e.message}`);
        }
      } else if (result.items?.length) {
        try {
          await scrapeItems(contexts, entry, result);
        } catch (e) {
          console.error(`  [error] item scraping for ${entry.name}: ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`  [error] ${entry.name || entry.url}: ${e.message}`);
      failed.push(entry.name || entry.url);
    }
    await sleep(1500); // be polite between sources
  }

  await contexts.proxied.close().catch(() => {});
  if (contexts.direct !== contexts.proxied) await contexts.direct.close().catch(() => {});

  console.log(`\nDone. ${written.length} markdown file(s) written to ${OUTPUT_DIR}`);
  if (failed.length) console.log(`Failed/blocked: ${failed.join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
