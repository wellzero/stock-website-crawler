#!/usr/bin/env node

/**
 * Lixinger Market & Code ID Parser
 *
 * 从理杏仁公司详情页 URL 中解析 market（交易所）、code（股票代码）、code_id（内部 ID）。
 *
 * URL 格式：
 *   https://www.lixinger.com/analytics/company/detail/{market}/{code}/{code_id}
 * 示例：
 *   https://www.lixinger.com/analytics/company/detail/nasdaq/LI/179170600
 *
 * 支持两种使用方式：
 * 1. 被 ParserManager 调用（标准 parser 接口）
 * 2. 独立运行：node src/parsers/lixinger-mkt-id-parser.js <stock-code>
 */

import { chromium } from 'playwright';

import fs from 'fs';
import path from 'path';

/**
 * 从参考配置文件中读取理杏仁账号密码
 * 默认路径：/home/openclaw_cnshare/workspace-IVI/agents/datasource/reference/lixinger-finance.json
 */
function loadRefConfig(refPath) {
  try {
    const content = fs.readFileSync(refPath, 'utf-8');
    const json = JSON.parse(content);
    return {
      username: json.login?.username || '',
      password: json.login?.password || '',
      loginUrl: json.login?.loginUrl || 'https://www.lixinger.com/open/api/my-apis'
    };
  } catch (e) {
    console.warn(`[Config] 无法读取参考配置: ${e.message}`);
    return {};
  }
}

class LixingerMktIdParser {
  constructor(config = {}) {
    // 优先使用传入的 config，其次尝试读取参考配置文件
    const refPath = config.refPath || '/home/openclaw_cnshare/workspace-IVI/agents/datasource/reference/lixinger-finance.json';
    const refConfig = loadRefConfig(refPath);

    this.config = {
      username: config.username || refConfig.username || '',
      password: config.password || refConfig.password || '',
      loginUrl: config.loginUrl || refConfig.loginUrl || 'https://www.lixinger.com/open/api/my-apis',
      timeout: config.timeout || 30000
    };
  }

  /**
   * 匹配理杏仁公司详情页 URL
   */
  matches(url) {
    return /lixinger\.com\/analytics\/company\/detail\/[^/]+\/[^/]+\/\d+/.test(url);
  }

  /**
   * 优先级（与 lixinger-fundamental-parser 同级）
   */
  getPriority() {
    return 110;
  }

  /**
   * 登录理杏仁
   * @param {import('playwright').Page} page
   */
  async login(page) {
    console.log('[Login] 导航到登录页...');
    await page.goto(this.config.loginUrl, { waitUntil: 'domcontentloaded', timeout: this.config.timeout });
    await page.waitForTimeout(3000);

    const needsLogin = await page.evaluate(() => {
      const hasPasswordInput = document.querySelector('input[type="password"]') !== null;
      const hasLoginButton = Array.from(document.querySelectorAll('button')).some(b => {
        const text = b.textContent?.trim() || '';
        return text.includes('登录') || text.includes('登錄');
      });
      return hasPasswordInput || hasLoginButton;
    });

    if (!needsLogin) {
      console.log('[Login] 已登录，跳过');
      return true;
    }

    console.log('[Login] 填写账号密码...');
    await page.evaluate(({ username, password }) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const textInput = inputs.find(i => {
        const type = i.type || i.getAttribute('type') || '';
        const placeholder = i.placeholder || '';
        return (type === 'text' || type === 'tel') &&
               !placeholder.includes('搜索') &&
               !placeholder.includes('A股') &&
               i.offsetParent !== null;
      });
      const passwordInput = inputs.find(i => {
        return (i.type || '') === 'password' && i.offsetParent !== null;
      });
      if (textInput) textInput.value = username;
      if (passwordInput) passwordInput.value = password;
      if (textInput) textInput.dispatchEvent(new Event('input', { bubbles: true }));
      if (passwordInput) passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    }, { username: this.config.username, password: this.config.password });

    console.log('[Login] 点击登录...');
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const loginBtn = buttons.find(b => {
        const text = b.textContent?.trim() || '';
        return (text.includes('登录') || text.includes('登錄')) && b.offsetParent !== null;
      });
      if (loginBtn) loginBtn.click();
    });

    try {
      await page.waitForNavigation({ timeout: 10000, waitUntil: 'domcontentloaded' });
    } catch {}
    await page.waitForTimeout(3000);

    const stillOnLogin = await page.evaluate(() => {
      return document.querySelector('input[type="password"]') !== null;
    });

    if (stillOnLogin) {
      console.error('[Login] 登录失败，请检查账号密码');
      return false;
    }

    console.log('[Login] 登录成功');
    return true;
  }

  /**
   * 从理杏仁公司详情页 URL 解析 market / code / code_id
   * @param {string} url
   * @returns {{market:string, code:string, code_id:string, url:string}|null}
   */
  parseUrl(url) {
    const match = url.match(/\/analytics\/company\/detail\/([^/]+)\/([^/]+)\/(\d+)(?:\/.*)?$/);
    if (match) {
      return {
        market: match[1],
        code: match[2],
        code_id: match[3],
        url
      };
    }
    return null;
  }

  /**
   * 调试辅助：打印页面上所有可见 input 元素的信息
   */
  async _dumpInputs(page) {
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, [contenteditable="true"]'))
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          placeholder: el.placeholder || '',
          className: el.className || '',
          id: el.id || '',
          name: el.name || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          offsetWidth: el.offsetWidth,
          offsetHeight: el.offsetHeight
        }))
    );
    console.log('[Debug] 页面上所有输入元素：');
    inputs.forEach((inp, i) => console.log(`  ${i + 1}.`, JSON.stringify(inp)));
    return inputs;
  }

  /**
   * 通过理杏仁首页搜索框查找股票代码对应的市场和 code_id
   *
   * 流程：
   * 1. 访问 https://www.lixinger.com/
   * 2. 在搜索框输入 stockCode（如 'LI'）
   * 3. 等待下拉结果并点击第一条
   * 4. 等待页面跳转后从 URL 提取信息
   *
   * @param {import('playwright').Page} page
   * @param {string} stockCode  股票代码，如 'LI', '600519', 'AAPL'
   * @returns {Promise<{market:string, code:string, code_id:string, url:string}>}
   */
  async searchByCode(page, stockCode) {
    // 0. 先登录（理杏仁首页未登录时只显示登录框，搜索框被遮挡）
    const loginOk = await this.login(page);
    if (!loginOk) {
      throw new Error('登录失败，无法继续搜索');
    }

    // 登录后停留在当前页即可搜索（login() 后的 API 页已有搜索框）
    console.log('[Search] 等待页面稳定...');
    await page.waitForTimeout(3000);

    // 2. 定位搜索框（理杏仁使用 Vue Multiselect，input 可能有 offsetWidth=0）
    let searchInput = null;

    // 先尝试不需要 isVisible 的特殊选择器
    const hiddenOkSelectors = [
      '.multiselect__input',
      'input[placeholder*="搜索(包含A股"]'
    ];
    for (const sel of hiddenOkSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) {
        searchInput = loc;
        break;
      }
    }

    // 再用常规可见选择器兜底
    if (!searchInput) {
      const visibleSelectors = [
        'input[placeholder*="搜索"]',
        'input[placeholder*="search"]',
        '.el-input__inner',
        '.search-input input',
        '[class*="search"] input[type="text"]',
        'header input[type="text"]'
      ];
      for (const sel of visibleSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
          searchInput = loc;
          break;
        }
      }
    }

    if (!searchInput) {
      await this._dumpInputs(page);
      throw new Error('未在理杏仁首页找到搜索框');
    }

    // 输入股票代码并等待下拉结果渲染
    // Vue Multiselect 需要先点击展开，再用 keyboard type 触发搜索
    const multiselectWrapper = page.locator('.multiselect').first();
    if (await multiselectWrapper.count() > 0) {
      await multiselectWrapper.click();
      await page.waitForTimeout(500);
      await page.keyboard.type(stockCode);
    } else {
      try {
        await searchInput.fill(stockCode);
      } catch {
        await page.evaluate((code) => {
          const inp = document.querySelector('.multiselect__input');
          if (inp) {
            inp.value = code;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('keyup', { bubbles: true }));
            inp.focus();
          }
        }, stockCode);
      }
    }
    await page.waitForTimeout(3000);

    // 3. 点击搜索结果中与 stockCode 匹配的项（而非第一条）
    // Vue Multiselect 选项通常是 .multiselect__option 或 .multiselect__element
    const allOptions = page.locator('.multiselect__option, .multiselect__element, .el-autocomplete-suggestion__list li, [class*="suggestion"] li');
    const count = await allOptions.count();

    let resultItem = null;
    if (count > 0) {
      // 打印所有结果供调试
      console.log(`[Search] 共 ${count} 个搜索结果:`);
      for (let i = 0; i < count; i++) {
        const text = await allOptions.nth(i).textContent().catch(() => '');
        console.log(`  ${i + 1}. ${text.trim()}`);
      }

      // 优先找文本内容包含精确股票代码的选项
      for (let i = 0; i < count; i++) {
        const text = await allOptions.nth(i).textContent().catch(() => '');
        const t = text.trim();

        // 排除搜索建议/页面导航项
        if (t.includes('搜索') || t.includes('天眼') || t.includes('(页面)')) continue;

        // 匹配规则：
        // 1. 股票代码.交易所 格式，如 "LI.nasdaq"
        // 2. 股票代码作为独立单词出现
        const exactMarket = new RegExp(`${stockCode}\.(nasdaq|nyse|sz|sh|hk)`, 'i');
        const standalone = new RegExp(`[\\s(（]${stockCode}[\\s)/）.]|^${stockCode}$`);
        if (exactMarket.test(t) || standalone.test(t)) {
          resultItem = allOptions.nth(i);
          console.log(`[Search] 选中结果 ${i + 1}: ${t}`);
          break;
        }
      }
      // 如果没找到精确匹配，点第一条
      if (!resultItem) {
        resultItem = allOptions.first();
        const firstText = await resultItem.textContent().catch(() => '');
        console.log(`[Search] 未找到精确匹配，选第一条: ${firstText.trim()}`);
      }
    }

    if (!resultItem) {
      // 兜底：用 evaluate 直接点击包含 stockCode 的 option，或第一个 option
      const clickedViaEval = await page.evaluate((code) => {
        const opts = Array.from(document.querySelectorAll('.multiselect__option, .multiselect__element'));
        const exact = opts.find(o => o.textContent.includes(code));
        const target = exact || opts[0];
        if (target) { target.click(); return true; }
        return false;
      }, stockCode);
      if (!clickedViaEval) {
        throw new Error(`搜索 "${stockCode}" 未返回可见结果`);
      }
    } else {
      await resultItem.click();
    }

    // 等待导航完成
    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch {}
    await page.waitForTimeout(3000);

    // 4. 从当前 URL 提取 market / code / code_id
    const finalUrl = page.url();
    const parsed = this.parseUrl(finalUrl);
    if (!parsed) {
      throw new Error(`跳转后的 URL 不符合预期格式: ${finalUrl}`);
    }

    return parsed;
  }

  /**
   * 标准 Parser 接口（供 ParserManager / CrawlerMain 调用）
   *
   * 如果 url 本身就是详情页链接，则直接解析；
   * 如果 options.stockCode 存在，则先搜索再解析。
   *
   * @param {import('playwright').Page} page
   * @param {string} url
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async parse(page, url, options = {}) {
    // 情况 A：URL 已经是详情页格式，直接提取
    const fromUrl = this.parseUrl(url);
    if (fromUrl) {
      return {
        type: 'lixinger-mkt-id',
        title: `${fromUrl.code} - ${fromUrl.market}`,
        ...fromUrl,
        skipDefaultMarkdownOutput: true
      };
    }

    // 情况 B：提供了 stockCode，通过搜索获取
    if (options.stockCode) {
      const result = await this.searchByCode(page, options.stockCode);
      return {
        type: 'lixinger-mkt-id',
        title: `${result.code} - ${result.market}`,
        ...result,
        skipDefaultMarkdownOutput: true
      };
    }

    // 无法解析
    return {
      type: 'lixinger-mkt-id',
      title: 'Unknown',
      market: null,
      code: null,
      code_id: null,
      url
    };
  }
}

/* ── 独立运行 CLI ── */

async function main() {
  const stockCode = process.argv[2];
  if (!stockCode) {
    console.log(`
Usage:
  node src/parsers/lixinger-mkt-id-parser.js <stock-code>

Examples:
  node src/parsers/lixinger-mkt-id-parser.js LI
  node src/parsers/lixinger-mkt-id-parser.js 600519
  node src/parsers/lixinger-mkt-id-parser.js AAPL
`);
    process.exit(1);
  }

  console.log(`[Search] 在理杏仁搜索股票代码: ${stockCode}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const parser = new LixingerMktIdParser();
    const result = await parser.searchByCode(page, stockCode);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('[Error]', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export default LixingerMktIdParser;
