import BaseParser from './base-parser.js';

/**
 * Lixinger Parser - 理杏仁专用解析器
 * 处理 Vue SPA 页面，等待动态数据加载完成后再提取
 */
class LixingerParser extends BaseParser {
  constructor() {
    super();
    this.apiData = [];
  }

  /**
   * 匹配理杏仁网站
   */
  matches(url) {
    return url.includes('lixinger.com');
  }

  /**
   * 获取优先级（高于 GenericParser）
   */
  getPriority() {
    return 100;
  }

  /**
   * 通过内容特征检测
   */
  async detectByContent(page) {
    try {
      const hasLixingerFeatures = await page.evaluate(() => {
        const hasVue = typeof window.Vue !== 'undefined' ||
          document.querySelector('[data-v-]') !== null;
        const hasLixingerText = document.body?.innerText?.includes('理杏仁') ||
          document.title?.includes('理杏仁');
        return hasVue && hasLixingerText;
      });
      return hasLixingerFeatures ? 90 : 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 预加载：注册 API 拦截器（包含 /v2/ 端点）
   */
  async beforeLoad(context) {
    const { page } = context;
    this.apiData = [];

    page.on('response', async (response) => {
      const responseUrl = response.url();
      const status = response.status();

      if (responseUrl.includes('lixinger.com') &&
          (responseUrl.includes('/api/') || responseUrl.includes('/data/') ||
           responseUrl.includes('/query/') || responseUrl.includes('/v2/'))) {
        try {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('json')) {
            const data = await response.json();
            if (Array.isArray(data) && data.length > 0) {
              this.apiData.push({ url: responseUrl, data });
            } else if (data && typeof data === 'object') {
              for (const key of Object.keys(data)) {
                if (Array.isArray(data[key]) && data[key].length > 0) {
                  this.apiData.push({ url: responseUrl, data: data[key], field: key });
                }
              }
            }
          }
        } catch (e) {
          // ignore
        }
      }
    });
  }

  /**
   * 解析页面 - 重写以添加理杏仁专用的等待逻辑
   */
  async parse(page, url, options = {}) {
    const context = { page, url, options, data: {} };

    try {
      if (typeof this.beforeLoad === 'function') {
        await this.beforeLoad(context);
      }

      await this.closePopups(page);
      await this.waitForLixingerContent(page);
      await this.closePopups(page);
      await this.scrollForLazyLoad(page);

      const extractedData = await this.extractLixingerData(page, url);
      Object.assign(context.data, extractedData);

      if (this.apiData.length > 0) {
        const apiTables = await this.convertAPIDataToTables(this.apiData);
        context.data.tables = [...(context.data.tables || []), ...apiTables];
        context.data.apiDataCount = this.apiData.length;
      }

      return this.formatResult(context.data, url);
    } catch (error) {
      console.error(`[LixingerParser] parse error on ${url}:`, error.message);
      return this.formatResult(context.data, url);
    }
  }

  /**
   * 等待理杏仁页面内容加载完成
   */
  async waitForLixingerContent(page) {
    console.log('  [Lixinger] 等待 Vue 页面渲染...');

    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // 理杏仁页面需要较长时间加载数据，固定等待 10 秒让 Vue 完成渲染
    await page.waitForTimeout(10000);

    // 等待页面标题从通用标题变为股票具体标题
    let titleReady = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      titleReady = await page.evaluate(() => {
        const title = document.title;
        const h1 = document.querySelector('h1');
        const h1Text = h1?.textContent?.trim() || '';
        return (title && title.length > 0 && !title.includes(' - 理杏仁') && !title.includes('理杏仁 -')) ||
               (h1Text.length > 0 && h1Text !== '理杏仁');
      });

      if (titleReady) {
        console.log(`  [Lixinger] 股票标题已加载 (尝试 ${attempt + 1})`);
        break;
      }

      await page.waitForTimeout(1000);
    }

    await page.waitForTimeout(3000);
    console.log('  [Lixinger] 页面内容加载完成');
  }

  /**
   * 滚动页面以触发懒加载
   */
  async scrollForLazyLoad(page) {
    try {
      await page.evaluate(async () => {
        const scrollStep = 500;
        const maxScrolls = 10;
        for (let i = 0; i < maxScrolls; i++) {
          window.scrollBy(0, scrollStep);
          await new Promise(r => setTimeout(r, 500));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(1000);
    } catch (e) {
      // ignore
    }
  }

  /**
   * 提取理杏仁页面数据
   */
  async extractLixingerData(page, url) {
    return await page.evaluate((pageUrl) => {
      const data = {
        title: '',
        description: '',
        headings: [],
        paragraphs: [],
        lists: [],
        tables: [],
        mainContent: [],
        images: [],
        codeBlocks: [],
      };

      const h1 = document.querySelector('h1');
      const h2 = document.querySelector('h2');
      const titleTag = document.querySelector('title');
      data.title = h1?.textContent?.trim() ||
                   h2?.textContent?.trim() ||
                   titleTag?.textContent?.trim() ||
                   '';

      const metaDesc = document.querySelector('meta[name="description"]');
      data.description = metaDesc?.getAttribute('content') || '';

      const tables = document.querySelectorAll('table');
      tables.forEach((table, index) => {
        const headers = [];
        const headerCells = table.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td');
        headerCells.forEach(cell => headers.push(cell.textContent?.trim() || ''));

        const rows = [];
        const bodyRows = table.querySelectorAll('tbody tr');
        const rowsToProcess = bodyRows.length > 0 ? bodyRows : table.querySelectorAll('tr');

        rowsToProcess.forEach((row, rowIndex) => {
          if (rowIndex === 0 && headers.length > 0 && bodyRows.length === 0) return;
          const cells = Array.from(row.querySelectorAll('td, th'));
          if (cells.length > 0) {
            const rowData = cells.map(cell => cell.textContent?.trim() || '');
            if (rowData.some(cell => cell.length > 0)) {
              rows.push(rowData);
            }
          }
        });

        if (headers.length > 0 || rows.length > 0) {
          let caption = '';
          let prevEl = table.previousElementSibling;
          let searchDepth = 3;
          while (prevEl && searchDepth > 0) {
            const text = prevEl.textContent?.trim();
            if (text && text.length > 0 && text.length < 100) {
              caption = text;
              break;
            }
            prevEl = prevEl.previousElementSibling;
            searchDepth--;
          }

          if (!caption) {
            const parent = table.closest('section, div[class*="panel"], div[class*="card"], div[class*="section"]');
            if (parent) {
              const titleEl = parent.querySelector('h1, h2, h3, h4, .title, [class*="title"]');
              if (titleEl) caption = titleEl.textContent?.trim();
            }
          }

          data.tables.push({ index, headers, rows, caption });
          data.mainContent.push({ type: 'table', headers, rows, caption });
        }
      });

      const allTextElements = document.querySelectorAll('p, div[class*="text"], div[class*="desc"], span[class*="value"], span[class*="label"]');
      const seenTexts = new Set();
      allTextElements.forEach(el => {
        const text = el.textContent?.trim();
        if (text && text.length > 2 && text.length < 500 &&
            !text.includes('客服电话') &&
            !text.includes('京ICP备') &&
            !text.includes('风险提示') &&
            !text.includes('推荐Chrome') &&
            !text.includes('用户协议') &&
            !seenTexts.has(text)) {
          seenTexts.add(text);
          data.paragraphs.push(text);
        }
      });

      document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
        const text = h.textContent?.trim();
        if (text && text.length > 0) {
          data.headings.push({ level: parseInt(h.tagName[1]), text });
        }
      });

      const mainSelectors = ['main', 'article', '[role="main"]', '#content', '.content', '#app', '.app'];
      let mainEl = null;
      for (const sel of mainSelectors) {
        mainEl = document.querySelector(sel);
        if (mainEl) break;
      }

      if (mainEl) {
        const walker = document.createTreeWalker(
          mainEl,
          NodeFilter.SHOW_TEXT,
          null,
          false
        );

        const textChunks = [];
        let node;
        while (node = walker.nextNode()) {
          const text = node.textContent?.trim();
          if (text && text.length > 0 && text.length < 200) {
            const parent = node.parentElement;
            if (parent) {
              const tag = parent.tagName;
              if (tag === 'SCRIPT' || tag === 'STYLE') continue;
              const style = window.getComputedStyle(parent);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
            }
            textChunks.push(text);
          }
        }

        const uniqueTexts = [...new Set(textChunks)];
        uniqueTexts.forEach(text => {
          if (!data.paragraphs.includes(text) &&
              !text.includes('客服电话') &&
              !text.includes('京ICP备') &&
              !text.includes('风险提示')) {
            data.paragraphs.push(text);
          }
        });
      }

      return data;
    }, url);
  }

  /**
   * 将 API 数据转换为表格
   */
  async convertAPIDataToTables(apiDataList) {
    const tables = [];

    for (const apiResponse of apiDataList) {
      try {
        const { url, data } = apiResponse;
        if (!Array.isArray(data) || data.length === 0) continue;

        const firstItem = data[0];
        const keys = Object.keys(firstItem);

        const flattenedData = data.map(item => {
          const flat = {};
          for (const key of keys) {
            const value = item[key];
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              for (const subKey of Object.keys(value)) {
                const subValue = value[subKey];
                if (subValue && typeof subValue === 'object' && !Array.isArray(subValue)) {
                  for (const subSubKey of Object.keys(subValue)) {
                    flat[`${key}.${subKey}.${subSubKey}`] = subValue[subSubKey];
                  }
                } else {
                  flat[`${key}.${subKey}`] = subValue;
                }
              }
            } else {
              flat[key] = value;
            }
          }
          return flat;
        });

        const allKeys = new Set();
        flattenedData.forEach(item => Object.keys(item).forEach(key => allKeys.add(key)));
        const headers = Array.from(allKeys);

        const rows = flattenedData.map(item => {
          return headers.map(header => {
            const value = item[header];
            if (value === null || value === undefined) return '';
            if (typeof value === 'object') return JSON.stringify(value);
            return String(value);
          });
        });

        tables.push({
          index: tables.length,
          headers,
          rows,
          caption: `API数据: ${url.split('/').pop().split('?')[0]}`,
          source: 'api'
        });
      } catch (error) {
        // ignore
      }
    }

    return tables;
  }

  /**
   * 格式化最终结果
   */
  formatResult(data, url) {
    return {
      type: 'generic',
      subtype: 'lixinger',
      url,
      title: data.title || '',
      description: data.description || '',
      headings: data.headings || [],
      mainContent: data.mainContent || [],
      paragraphs: data.paragraphs || [],
      lists: data.lists || [],
      tables: data.tables || [],
      codeBlocks: data.codeBlocks || [],
      images: data.images || [],
      charts: [],
      chartData: [],
      blockquotes: [],
      definitionLists: [],
      horizontalRules: 0,
      videos: [],
      audios: [],
      apiData: data.apiDataCount || 0,
      pageFeatures: { suggestedType: 'lixinger', confidence: 100, signals: ['vue-spa', 'financial-data'] },
      tabsAndDropdowns: [],
      dateFilters: []
    };
  }
}

export default LixingerParser;
