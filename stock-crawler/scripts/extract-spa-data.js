import { chromium } from 'playwright';
import fs from 'fs';

function pageDataToMarkdown(url, pageData) {
  let md = `---\nurl: "${url}"\nextracted_at: "${new Date().toISOString()}"\n---\n\n`;
  md += `# Data Extracted from ${url}\n\n`;

  if (!pageData) {
    md += '> No pageData found on this page.\n';
    return md;
  }

  // 1. Stock basic info
  if (pageData.stock) {
    const s = pageData.stock;
    md += '## Stock Info\n\n';
    md += '| Field | Value |\n|-------|-------|\n';
    for (const [k, v] of Object.entries(s)) {
      md += `| ${k} | ${v} |\n`;
    }
    md += '\n';
  }

  // 2. Price metrics chart data
  if (pageData.priceMetricsChartInfo?.priceMetricsList?.length) {
    const list = pageData.priceMetricsChartInfo.priceMetricsList;
    md += `## Price & Valuation Metrics (${list.length} records)\n\n`;
    md += '| Date | Stock Price | PE-TTM | 80% Quantile | 50% Quantile | 20% Quantile | Percentile |\n';
    md += '|------|-------------|--------|--------------|--------------|--------------|------------|\n';
    for (const d of list.slice(0, 50)) {
      const date = d.date ? new Date(d.date).toISOString().split('T')[0] : '';
      const stats = d.statistics?.pe_ttm || {};
      md += `| ${date} | ${d.sp || ''} | ${d.pe_ttm || ''} | ${stats.q8v || ''} | ${stats.q5v || ''} | ${stats.q2v || ''} | ${stats.cvpos !== undefined ? (stats.cvpos * 100).toFixed(2) + '%' : ''} |\n`;
    }
    if (list.length > 50) {
      md += `\n> ... ${list.length - 50} more rows omitted\n`;
    }
    md += '\n';
  }

  // 3. Y-axis metrics names
  if (pageData.yAxisLeftMetricsName || pageData.yAxisRightMetricsName) {
    md += '## Chart Axes\n\n';
    md += `| Left Axis | Right Axis |\n|-----------|------------|\n`;
    md += `| ${pageData.yAxisLeftMetricsName || ''} | ${pageData.yAxisRightMetricsName || ''} |\n\n`;
  }

  // 4. Any other top-level data
  const otherKeys = Object.keys(pageData).filter(k => k !== 'stock' && k !== 'priceMetricsChartInfo' && k !== 'yAxisLeftMetricsName' && k !== 'yAxisRightMetricsName');
  for (const key of otherKeys) {
    const val = pageData[key];
    if (val && typeof val === 'object') {
      const str = JSON.stringify(val, null, 2);
      if (str.length > 2000) {
        md += `## ${key}\n\n\`\`\`json\n${str.substring(0, 2000)}\n... (${str.length - 2000} more chars)\n\`\`\`\n\n`;
      } else {
        md += `## ${key}\n\n\`\`\`json\n${str}\n\`\`\`\n\n`;
      }
    } else {
      md += `## ${key}\n\n${val}\n\n`;
    }
  }

  return md;
}

async function main() {
  const outputDir = './output/lixinger-600519';
  const dataDir = `${outputDir}/spa-data`;
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Read fetched URLs
  const linksText = fs.readFileSync(`${outputDir}/links.txt`, 'utf-8');
  const urls = linksText.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch (e) { return null; }
  }).filter(l => l && l.status === 'fetched').map(l => l.url);

  console.log(`Found ${urls.length} fetched URLs to re-extract`);

  const browser = await chromium.launchPersistentContext('./chrome_user_data', {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  // Login
  await page.goto('https://www.lixinger.com/open/api/my-apis', { timeout: 60000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const userInput = page.locator('input[placeholder="账号或手机号"]');
  const passInput = page.locator('input[placeholder="密码"]');
  if (await userInput.count() > 0 && await passInput.count() > 0) {
    await userInput.fill('13311390323');
    await passInput.fill('3228552');
    await page.locator('button:has-text("登录"), button[type="submit"]').first().click();
    await page.waitForTimeout(5000);
  }

  let success = 0;
  let failed = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`\n[${i + 1}/${urls.length}] ${url}`);

    try {
      await page.goto(url, { timeout: 60000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);

      const html = await page.content();
      if (html.includes('TooManyRequestsError')) {
        console.log('  RATE LIMITED, waiting 90s...');
        await new Promise(r => setTimeout(r, 90000));
        await page.goto(url, { timeout: 60000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);
      }

      const pageData = await page.evaluate(() => window.pageData);

      if (pageData) {
        const keys = Object.keys(pageData);
        console.log(`  pageData keys: ${keys.join(', ')}`);

        // Save raw JSON
        const safeName = url.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 80);
        fs.writeFileSync(`${dataDir}/${safeName}.json`, JSON.stringify(pageData, null, 2));

        // Generate Markdown
        const md = pageDataToMarkdown(url, pageData);
        fs.writeFileSync(`${dataDir}/${safeName}.md`, md);
        console.log(`  Saved JSON + Markdown`);
        success++;
      } else {
        console.log('  No pageData');
        failed++;
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
      failed++;
    }

    // Wait between requests
    if (i < urls.length - 1) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log(`\n=== Done: ${success} success, ${failed} failed ===`);
  console.log(`Output: ${dataDir}/`);

  await browser.close();
}

main().catch(console.error);
