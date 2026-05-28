import BaseParser from './base-parser.js';
import LinkFinder from '../link-finder.js';

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
   * 声明支持 parser-based 链接发现
   */
  supportsLinkDiscovery() {
    return true;
  }

  /**
   * Parser-based 链接发现 — 先等待 Vue 渲染，再用 linkFinder.extractLinks 过滤
   */
  async discoverLinks(page, urlRules) {
    await this.waitForLixingerContent(page);
    const linkFinder = new LinkFinder();
    return await linkFinder.extractLinks(page, urlRules, { fetchMethod: 'playwright' });
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

      // 只拦截来自 lixinger.com 的 JSON 响应
      if (!responseUrl.includes('lixinger.com')) return;

      // 跳过用户、通知、追踪等非数据端点
      const skipPatterns = [
        '/user/users/', '/user/notifications/', '/site/notifications/',
        '/tracking.', '/api/send', '/page-configs/list-of-indexes',
        '/auth/', '/login', '/logout'
      ];
      if (skipPatterns.some(p => responseUrl.includes(p))) return;

      try {
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('json')) return;

        const data = await response.json();

        // 过滤掉错误响应
        if (data && (data.code !== undefined || data.error !== undefined)) {
          console.log(`  [Lixinger API] ${responseUrl} -> 错误响应 (code: ${data.code}, error: ${data.error})`);
          return;
        }

        console.log(`  [Lixinger API] ${responseUrl} -> ${typeof data} (keys: ${data && typeof data === 'object' ? Object.keys(data).slice(0, 5).join(',') : 'N/A'})`);

        // 过滤规则：跳过配置数据、索引成分数据等
        const urlKey = responseUrl.split('/').pop().split('?')[0];
        const skipDataKeys = ['granularities', 'granularity'];

        if (Array.isArray(data) && data.length >= 5) {
          // 跳过指数成分数据（股票页面不需要）
          if (data[0]?.stockType === 'index' && data[0]?.weighting !== undefined) {
            console.log(`    ⊘ 跳过指数成分数据 (${data.length} 条)`);
            return;
          }
          this.apiData.push({ url: responseUrl, data });
          console.log(`    ✓ API数据已捕获: ${urlKey} (${data.length} 条)`);
        } else if (data && typeof data === 'object') {
          for (const key of Object.keys(data)) {
            if (skipDataKeys.includes(key)) continue;
            if (Array.isArray(data[key]) && data[key].length >= 5) {
              // 跳过指数成分数据
              if (data[key][0]?.stockType === 'index' && data[key][0]?.weighting !== undefined) {
                console.log(`    ⊘ 跳过指数成分数据 [${key}] (${data[key].length} 条)`);
                continue;
              }
              this.apiData.push({ url: responseUrl, data: data[key], field: key });
              console.log(`    ✓ API数据已捕获: ${urlKey} [${key}] (${data[key].length} 条)`);
            }
          }
        }
      } catch (e) {
        // ignore
      }
    });
  }

  /**
   * 解析页面 - 重写以添加理杏仁专用的等待逻辑
   */
  async parse(page, url, options = {}) {
    const context = { page, url, options, data: {} };

    try {
      await this.closePopups(page);
      await this.waitForLixingerContent(page);
      await this.closePopups(page);
      await this.scrollForLazyLoad(page);

      // 滚动后再次等待内容加载
      console.log('  [Lixinger] 滚动后等待额外内容加载...');
      await page.waitForTimeout(2000);
      await this.waitForLixingerContent(page);

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
   * 等待理杏仁页面内容加载完成（优化版）
   * 使用智能轮询替代固定长等待，通常 2-5 秒完成
   */
  async waitForLixingerContent(page) {
    console.log('  [Lixinger] 等待 Vue 页面渲染...');
    const startTime = Date.now();

    // Phase 1: 基础加载
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // Phase 2: 智能轮询 — 每 200ms 检测一次真实数据，最多 5 秒
    const hasRealData = async () => {
      return page.evaluate(() => {
        // 检测 1: 包含数值数据的表格（非仅有表头）
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
          const dataCells = table.querySelectorAll('tbody td, tr td');
          let meaningfulCells = 0;
          for (const cell of dataCells) {
            const text = cell.textContent.trim();
            if (text.length > 0 && /[\d%\.]/.test(text)) {
              meaningfulCells++;
            }
            if (meaningfulCells >= 3) return true;
          }
        }

        // 检测 2: 包含财务指标的数据容器
        const metricContainers = document.querySelectorAll(
          '[class*="metric"], [class*="indicator"], [class*="financial"], [class*="data-row"]'
        );
        for (const container of metricContainers) {
          const text = container.textContent.trim();
          if (text.length > 30 && /[\d%\.]/.test(text)) return true;
        }

        // 检测 3: 标题已变为股票专属且正文有足够内容
        const title = document.title;
        const h1 = document.querySelector('h1');
        const h1Text = h1?.textContent?.trim() || '';
        const isGenericTitle = title === '理杏仁' ||
                               title.endsWith(' - 理杏仁') ||
                               title.startsWith('理杏仁 -') ||
                               h1Text === '理杏仁';
        if (!isGenericTitle && /[一-龥]/.test(title)) {
          const bodyText = document.body?.innerText || '';
          if (bodyText.length > 1000) return true;
        }

        return false;
      });
    };

    let found = false;
    for (let i = 0; i < 25; i++) { // 25 * 200ms = 5 秒上限
      if (await hasRealData()) {
        found = true;
        break;
      }
      await page.waitForTimeout(200);
    }

    // 最后缓冲 500ms 确保渲染完成
    await page.waitForTimeout(500);

    const elapsed = Date.now() - startTime;
    console.log(`  [Lixinger] 页面内容加载完成 (${elapsed}ms)`);
  }

  /**
   * 滚动页面以触发懒加载
   */
  async scrollForLazyLoad(page) {
    try {
      console.log('  [Lixinger] 滚动触发懒加载...');
      await page.evaluate(async () => {
        const scrollStep = 800;
        const maxScrolls = 20;
        for (let i = 0; i < maxScrolls; i++) {
          window.scrollBy(0, scrollStep);
          await new Promise(r => setTimeout(r, 600));
        }
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 800));
      });
      await page.waitForTimeout(1500);

      // 再次检查是否有新表格加载
      const newTableCount = await page.evaluate(() => {
        const tables = document.querySelectorAll('table, .el-table, .ant-table, [class*="data-grid"]');
        return tables.length;
      });
      console.log(`  [Lixinger] 滚动后检测到 ${newTableCount} 个表格/数据网格`);
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

      // 提取标准 HTML table
      const tables = document.querySelectorAll('table');
      tables.forEach((table, index) => {
        const result = extractTableData(table);
        if (result) {
          result.index = index;
          data.tables.push(result);
          data.mainContent.push({ type: 'table', ...result });
        }
      });

      // 提取 Vue Element UI 表格 (.el-table)
      const elTables = document.querySelectorAll('.el-table');
      elTables.forEach((table, idx) => {
        const result = extractElTable(table);
        if (result) {
          result.index = data.tables.length;
          result.source = 'el-table';
          data.tables.push(result);
          data.mainContent.push({ type: 'table', ...result });
        }
      });

      // 提取 Ant Design 表格 (.ant-table)
      const antTables = document.querySelectorAll('.ant-table');
      antTables.forEach((table, idx) => {
        const result = extractAntTable(table);
        if (result) {
          result.index = data.tables.length;
          result.source = 'ant-table';
          data.tables.push(result);
          data.mainContent.push({ type: 'table', ...result });
        }
      });

      // 提取通用 div grid 表格
      const gridTables = document.querySelectorAll('[class*="data-grid"], [class*="table-grid"], [class*="virtual-list"]');
      gridTables.forEach((table, idx) => {
        const result = extractDivGrid(table);
        if (result) {
          result.index = data.tables.length;
          result.source = 'div-grid';
          data.tables.push(result);
          data.mainContent.push({ type: 'table', ...result });
        }
      });

      // 提取页面中的结构化数值数据 (metric cards)
      const metricSections = document.querySelectorAll('[class*="metric"], [class*="indicator"], [class*="financial"], [class*="valuation"]');
      metricSections.forEach((section, idx) => {
        const items = section.querySelectorAll('div, span, p');
        const metricData = [];
        let currentRow = [];
        items.forEach(item => {
          const text = item.textContent?.trim() || '';
          if (text && text.length > 0 && text.length < 50) {
            currentRow.push(text);
            if (currentRow.length >= 2) {
              metricData.push([...currentRow]);
              currentRow = [];
            }
          }
        });
        if (metricData.length > 0) {
          data.tables.push({
            index: data.tables.length,
            headers: ['指标', '数值'],
            rows: metricData,
            caption: '估值指标',
            source: 'metric-section'
          });
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

      // 尝试从 window.__INITIAL_STATE__ 或类似全局变量提取数据
      try {
        const globalDataKeys = ['__INITIAL_STATE__', '__DATA__', '__APP__', '__INITIAL_DATA__', 'appData'];
        for (const key of globalDataKeys) {
          if (window[key]) {
            const stateData = window[key];
            if (typeof stateData === 'object') {
              // 查找对象中的数组属性（可能是表格数据）
              for (const [prop, value] of Object.entries(stateData)) {
                if (Array.isArray(value) && value.length > 3 && typeof value[0] === 'object') {
                  const keys = Object.keys(value[0]);
                  const rows = value.map(item => keys.map(k => String(item[k] ?? '')));
                  data.tables.push({
                    index: data.tables.length,
                    headers: keys,
                    rows,
                    caption: `全局数据: ${key}.${prop}`,
                    source: 'global-state'
                  });
                }
              }
            }
          }
        }
      } catch (e) {
        // ignore
      }

      return data;

      // Helper: 提取标准 HTML table
      function extractTableData(table) {
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

        // 过滤掉无效表格
        if (headers.length === 0 && rows.length === 0) return null;
        // 跳过只有表头没有数据行的表格
        if (rows.length === 0) return null;
        // 跳过列数过少的表格（可能是分页控件或占位符）
        const maxCols = Math.max(headers.length, ...rows.map(r => r.length));
        if (maxCols < 2) return null;
        // 跳过所有行都是纯数字/页码的表格（分页控件）
        const isPagination = rows.every(row =>
          row.every(cell => /^[\d›‹<>»«]+$/.test(cell.trim()) || cell.trim() === '')
        );
        if (isPagination) return null;

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

        return { headers, rows, caption };
      }

      // Helper: 提取 Element UI 表格
      function extractElTable(table) {
        const headers = [];
        const headerCells = table.querySelectorAll('.el-table__header th, .el-table__header .cell');
        headerCells.forEach(cell => {
          const text = cell.textContent?.trim();
          if (text && !headers.includes(text)) headers.push(text);
        });

        const rows = [];
        const bodyRows = table.querySelectorAll('.el-table__body tr, .el-table__row');
        bodyRows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('.cell, td'));
          const rowData = cells.map(cell => cell.textContent?.trim() || '');
          if (rowData.some(cell => cell.length > 0)) {
            rows.push(rowData);
          }
        });

        if (headers.length === 0 && rows.length === 0) return null;

        const captionEl = table.closest('section, div[class*="panel"], div[class*="card"]')?.querySelector('h1, h2, h3, h4, .title');
        const caption = captionEl?.textContent?.trim() || '';
        return { headers, rows, caption };
      }

      // Helper: 提取 Ant Design 表格
      function extractAntTable(table) {
        const headers = [];
        const headerCells = table.querySelectorAll('.ant-table-thead th, .ant-table-cell');
        headerCells.forEach(cell => {
          const text = cell.textContent?.trim();
          if (text && !headers.includes(text)) headers.push(text);
        });

        const rows = [];
        const bodyRows = table.querySelectorAll('.ant-table-tbody tr');
        bodyRows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('.ant-table-cell, td'));
          const rowData = cells.map(cell => cell.textContent?.trim() || '');
          if (rowData.some(cell => cell.length > 0)) {
            rows.push(rowData);
          }
        });

        if (headers.length === 0 && rows.length === 0) return null;
        return { headers, rows, caption: '' };
      }

      // Helper: 提取通用 div grid
      function extractDivGrid(grid) {
        const headers = [];
        const headerEls = grid.querySelectorAll('[class*="header"], [class*="title"]');
        headerEls.forEach(el => {
          const text = el.textContent?.trim();
          if (text && text.length < 50 && !headers.includes(text)) headers.push(text);
        });

        const rows = [];
        const rowEls = grid.querySelectorAll('[class*="row"], [class*="item"]');
        rowEls.forEach(row => {
          const cells = Array.from(row.children);
          const rowData = cells.map(cell => cell.textContent?.trim() || '');
          if (rowData.some(cell => cell.length > 0)) {
            rows.push(rowData);
          }
        });

        if (headers.length === 0 && rows.length === 0) return null;
        return { headers, rows, caption: '' };
      }
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
