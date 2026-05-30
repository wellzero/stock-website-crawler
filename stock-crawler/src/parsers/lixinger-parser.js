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
   * 从 URL 中提取 stockId
   */
  extractStockId(url) {
    const match = url.match(/\/(sh|sz|bj)\/\d+\/(\d+)/);
    return match ? match[2] : null;
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
   * 对于财务页面（bs/ps/cfs），额外添加年报/季报/半年报三种粒度 URL
   */
  async discoverLinks(page, urlRules) {
    await this.waitForLixingerContent(page);
    const linkFinder = new LinkFinder();
    const links = await linkFinder.extractLinks(page, urlRules, { fetchMethod: 'playwright' });

    // 为财务页面添加三种粒度（年报/季报/半年报），/m（重大事项）也有 yearly/quarter
    const financialPaths = ['/bs', '/ps', '/cfs', '/is', '/m'];
    const extraLinks = [];
    const granularities = [
      { key: 'y', suffix: 'yearly' },
      { key: 'q', suffix: 'quarter' }
    ];

    for (const url of links) {
      if (!financialPaths.some(p => url.includes(p))) continue;
      try {
        const u = new URL(url);
        const currentGranularity = u.searchParams.get('granularity');
        for (const g of granularities) {
          // 如果原始 URL 没有 granularity，跳过 quarter（原始 URL 会默认处理为季报）
          if (!currentGranularity && g.key === 'q') continue;
          if (currentGranularity === g.key) continue;
          const newUrl = new URL(url);
          newUrl.searchParams.set('granularity', g.key);
          // 保留其他必要参数
          if (!newUrl.searchParams.has('fs-owner-type')) {
            newUrl.searchParams.set('fs-owner-type', 'consolidated');
          }
          if (!newUrl.searchParams.has('data-display-type')) {
            newUrl.searchParams.set('data-display-type', 'number');
          }
          if (!newUrl.searchParams.has('data-report-type')) {
            newUrl.searchParams.set('data-report-type', 'all');
          }
          if (!newUrl.searchParams.has('data-metrics-types')) {
            newUrl.searchParams.set('data-metrics-types', 't,c,c2y,yoy,coc');
          }
          extraLinks.push(newUrl.toString());
        }
      } catch (e) {
        // ignore invalid URLs
      }
    }

    return [...links, ...extraLinks];
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

      // 跳过用户、通知、追踪、股票列表等非数据端点
      const skipPatterns = [
        '/user/users/', '/user/notifications/', '/site/notifications/',
        '/tracking.', '/api/send', '/page-configs/list-of-indexes',
        '/auth/', '/login', '/logout',
        // 股票集合/关注列表/指数成分——不是当前页面数据
        '/stock-collections', '/stocks/followed', '/stocks/by-ids',
        '/ii/constituents/list',
        // 用户设置/自定义指标——不是财务数据
        '/ugd/settings-groups', '/ugd/custom-fs-metrics/',
        // 日期范围——不是实际数据值
        '/fs-metrics/list/date-range',
        // 注意：list-info 包含实际财务指标数据（如毛利率、ROE 等），
        // 只在 fundamental 分析页面（/fundamental/profit, /fundamental/growth 等）保留
        // 不在此处跳过，由后续逻辑按需处理
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

      // 对于营收构成页面，点击最大年份按钮（20年）以获取全部历史数据
      if (url.includes('operation-revenue-constitution')) {
        try {
          const maxYearBtn = await page.locator('.btn-group .btn:has-text("20 年"), .btn-group label:has-text("20 年")').first();
          if (await maxYearBtn.isVisible()) {
            const isActive = await maxYearBtn.evaluate(el => el.classList.contains('active'));
            if (!isActive) {
              console.log('  [Lixinger] 点击 "20 年" 按钮以获取最大年份数据...');
              await maxYearBtn.click();
              await page.waitForTimeout(3000);
              await this.waitForLixingerContent(page);
            }
          }
        } catch (e) {
          // 忽略按钮点击错误
        }
      }

      // 检查是否是分页页面（bs/ps/cfs/is/m）
      const urlObj = new URL(url);
      const path = urlObj.pathname;
      const paginatedPaths = ['/bs', '/ps', '/cfs', '/is', '/m'];
      const isPaginatedPage = paginatedPaths.some(p => path.endsWith(p));
      const isFinancialStatement = ['/bs', '/ps', '/cfs', '/is'].some(p => path.endsWith(p));

      // 分页页面：每页数据存为独立文件（如 资产负债表_quarter_0.md, _1.md...）
      if (isPaginatedPage && options.pagesDir) {
        // /m 页面需要同时下载季报(q)和年报(y)
        const granularities = path.endsWith('/m') ? ['q', 'y'] : [null];
        const granularityNames = { q: 'quarter', y: 'yearly' };
        let anyPagesSaved = false;
        const fs = await import('fs');

        for (const gran of granularities) {
          const pageUrlWithGran = gran !== null
            ? `${url}${url.includes('?') ? '&' : '?'}granularity=${gran}`
            : url;
          const paginatedPages = await this.fetchPaginatedUrls(page, pageUrlWithGran, { separatePages: true });
          if (paginatedPages.length === 0) continue;

          anyPagesSaved = true;
          const baseFilename = this.buildSuggestedFilename(pageUrlWithGran);
          const granSuffix = gran !== null ? `_${granularityNames[gran]}` : '';

          for (const { pageIndex, tables } of paginatedPages) {
            // 过滤只有 1 列的表格（div-grid 误提取的指标列表）
            let validTables = tables.filter(t => t.headers && t.headers.length > 1);
            if (validTables.length === 0) continue;

            // 财务报表页面：过滤掉非财务报表数据（员工情况、股本估值等不属于资产负债表）
            if (isFinancialStatement) {
              validTables = validTables.map(table => {
                const reportRows = table.rows.filter(row => {
                  const label = row[0] || '';
                  // 跳过章节标题行
                  if (label.startsWith('四、员工情况') || label.startsWith('五、股本、股东以及估值')) return false;
                  // 跳过员工相关行
                  if (/^(员工人数|博士人数|硕士人数|学士人数|大专人数|高中及以下人数|生产人员人数|销售人员人数|技术人员人数|财务人员人数|行政人员人数|其他人员人数)$/.test(label)) return false;
                  // 跳过股本估值相关行
                  if (/^(市值|总股数|流通股数|总股东人数|A股股东人数|第一大股东持仓|前十大股东持仓|前十大流通股东持仓|进公募基金前十大持仓|公募基金持仓|公募基金\+自由流通股东持仓|PE-TTM|PE-TTM\(扣非\)|PB|PB\(不含商誉\)|PS-TTM|PCF-TTM|股息率)$/.test(label)) return false;
                  return true;
                });
                return { ...table, rows: reportRows };
              }).filter(t => t.rows.length > 0);
            }

            if (validTables.length === 0) continue;

            const sections = [];
            const pageUrl = `${pageUrlWithGran}${pageUrlWithGran.includes('?') ? '&' : '?'}page-index=${pageIndex}`;
            sections.push(`## 源URL\n\n${pageUrl}`);
            for (const table of validTables) {
              sections.push('');
              sections.push(`| ${table.headers.join(' | ')} |`);
              sections.push(`| ${table.headers.map(() => '---').join(' | ')} |`);
              for (const row of table.rows) {
                sections.push(`| ${row.join(' | ')} |`);
              }
            }
            const markdown = sections.join('\n');
            const filename = `${baseFilename}${granSuffix}_${pageIndex}.md`;
            const filepath = `${options.pagesDir}/${filename}`;
            if (fs.existsSync(filepath)) {
              const crypto = await import('crypto');
              const urlHash = crypto.createHash('md5').update(pageUrl).digest('hex').substring(0, 8);
              const uniqueFilename = `${baseFilename}${granSuffix}_${pageIndex}_${urlHash}.md`;
              fs.writeFileSync(`${options.pagesDir}/${uniqueFilename}`, markdown, 'utf-8');
              console.log(`  [Lixinger] 已保存分页文件: ${uniqueFilename}`);
            } else {
              fs.writeFileSync(filepath, markdown, 'utf-8');
              console.log(`  [Lixinger] 已保存分页文件: ${filename}`);
            }
          }
        }

        if (anyPagesSaved) {
          context.data.skipDefaultMarkdownOutput = true;
          context.data.suggestedFilename = this.buildSuggestedFilename(url);
          return this.formatResult(context.data, url);
        }
      }

      // 先通过 URL page-index 参数遍历所有分页（避免 UI 点击遗漏）
      const urlPaginatedData = await this.fetchPaginatedUrls(page, url);

      // 将 URL 分页数据写入浏览器全局变量
      const hasUrlPaginatedData = urlPaginatedData.length > 0;
      const hasWideColumns = urlPaginatedData.some(t => t.headers.length > 20);
      if (hasUrlPaginatedData) {
        await page.evaluate((data) => {
          window.__lixingerPaginatedData = data;
        }, urlPaginatedData);
      }

      // 如果 URL 分页已收集到宽列数据（多页合并），跳过 UI 点击避免覆盖
      // 同时跳过 fundamental 分析页面（/fundamental/profit, /fundamental/growth 等）
      // 这些页面的数据以图表形式展示，分页按钮通常属于无关组件（如股票对比列表）
      const isFundamentalAnalysisPage = /\/fundamental\/(profit|growth|cash-flow|operating-ability|cost|per-capita|asset|debt|safety)/.test(url);
      if (hasWideColumns) {
        console.log('  [Lixinger] URL 分页已收集完整数据，跳过 UI 点击');
      } else if (isFundamentalAnalysisPage) {
        console.log('  [Lixinger] fundamental 分析页面跳过 UI 分页点击');
      } else {
        await this.clickPaginationAndCollectData(page);
      }

      // chart-maker/fs-metrics 页面：通过 API 下载所有指标的所有计算方式数据
      if (url.includes('chart-maker/fs-metrics')) {
        try {
          const stockId = this.extractStockId(url);
          if (stockId) {
            console.log('  [Lixinger] chart-maker/fs-metrics 页面，通过 API 获取全量指标数据...');
            const fsMetricsData = await this.fetchAllChartMakerMetrics(page, stockId);
            if (fsMetricsData && fsMetricsData.length > 0) {
              const table = this.convertFsMetricsListToTable(fsMetricsData, url);
              if (table) {
                context.data.tables = [...(context.data.tables || []), table];
                console.log(`  [Lixinger] 已添加 chart-maker 数据: ${table.rows.length} 行 x ${table.headers.length} 列`);
              }
            }
          }
        } catch (e) {
          console.log('  [Lixinger] chart-maker API 获取失败:', e.message);
        }
      }

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
   * 点击分页按钮并收集所有页面数据
   * 理杏仁财务表格通常有分页，需要点击"下一页"加载全部数据
   */
  async clickPaginationAndCollectData(page) {
    try {
      // 先收集当前页面所有表格的数据（保留 URL 分页已累积的数据）
      await page.evaluate(() => {
        window.__lixingerPaginatedData = window.__lixingerPaginatedData || [];
        const tables = document.querySelectorAll('table');
        tables.forEach((table, idx) => {
          const headers = [];
          const headerCells = table.querySelectorAll('thead th, thead td');
          headerCells.forEach(cell => headers.push(cell.textContent?.trim() || ''));
          if (headers.length === 0) {
            const firstRow = table.querySelector('tr');
            if (firstRow) {
              firstRow.querySelectorAll('th, td').forEach(cell => headers.push(cell.textContent?.trim() || ''));
            }
          }
          const rows = [];
          const bodyRows = table.querySelectorAll('tbody tr');
          const rowsToProcess = bodyRows.length > 0 ? bodyRows : table.querySelectorAll('tr');
          rowsToProcess.forEach((row, rowIndex) => {
            if (rowIndex === 0 && headers.length > 0 && bodyRows.length === 0) return;
            const cells = Array.from(row.querySelectorAll('td, th'));
            if (cells.length > 0) {
              rows.push(cells.map(cell => cell.textContent?.trim() || ''));
            }
          });
          // 合并到已有数据（URL 分页可能已累积）
          const existing = window.__lixingerPaginatedData.find(t => t.index === idx);
          if (existing) {
            existing.headers = headers.length > 0 ? headers : existing.headers;
            for (const r of rows) {
              const isDup = existing.rows.some(er => JSON.stringify(er) === JSON.stringify(r));
              if (!isDup) existing.rows.push(r);
            }
          } else {
            window.__lixingerPaginatedData.push({ index: idx, headers, rows, caption: '' });
          }
        });
      });

      let hasMorePages = true;
      let pageNum = 1;
      const maxPages = 100;

      while (hasMorePages && pageNum < maxPages) {
        // 查找下一页按钮
        const nextSelectors = [
          '.el-pagination .btn-next:not(.disabled)',
          '.el-pager li.active + li',
          '.next:not(.disabled)',
          '[class*="next"]:not(.disabled)',
          'button:has-text("下一页")',
          'a:has-text("下一页")',
          'li:has-text("›")',
          'li:has-text(">")'
        ];

        let nextButton = null;
        for (const selector of nextSelectors) {
          try {
            const btn = page.locator(selector).first();
            const count = await btn.count();
            if (count > 0) {
              const isDisabled = await btn.evaluate(el => {
                return el.disabled || el.classList.contains('disabled') ||
                       el.classList.contains('el-pagination--disabled') ||
                       el.getAttribute('aria-disabled') === 'true';
              }).catch(() => false);
              if (!isDisabled) {
                nextButton = btn;
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }

        if (!nextButton) {
          hasMorePages = false;
          break;
        }

        await nextButton.click();
        console.log(`  [Lixinger] 点击第 ${pageNum + 1} 页分页按钮...`);
        await page.waitForTimeout(1000);

        // 等待数据加载并收集新行
        const hasNewData = await page.evaluate(() => {
          const tables = document.querySelectorAll('table');
          let newRowsAdded = 0;
          tables.forEach((table, idx) => {
            const existing = window.__lixingerPaginatedData.find(t => t.index === idx);
            if (!existing) return;
            const bodyRows = table.querySelectorAll('tbody tr');
            const rowsToProcess = bodyRows.length > 0 ? bodyRows : table.querySelectorAll('tr');
            rowsToProcess.forEach((row, rowIndex) => {
              if (rowIndex === 0 && existing.headers.length > 0 && bodyRows.length === 0) return;
              const cells = Array.from(row.querySelectorAll('td, th'));
              if (cells.length === 0) return;
              const rowData = cells.map(cell => cell.textContent?.trim() || '');
              // 去重：检查是否已存在相同行
              const isDuplicate = existing.rows.some(r => JSON.stringify(r) === JSON.stringify(rowData));
              if (!isDuplicate) {
                existing.rows.push(rowData);
                newRowsAdded++;
              }
            });
          });
          return newRowsAdded > 0;
        });

        if (!hasNewData) {
          console.log(`  [Lixinger] 分页无新数据，停止点击`);
          hasMorePages = false;
        } else {
          pageNum++;
          console.log(`  [Lixinger] 第 ${pageNum} 页数据已收集`);
        }
      }

      if (pageNum > 1) {
        console.log(`  [Lixinger] 共收集 ${pageNum} 页分页数据`);
      }
    } catch (error) {
      console.log(`  [Lixinger] 分页点击结束: ${error.message}`);
    }
  }

  /**
   * 通过 URL page-index 参数遍历所有分页数据
   * 理杏仁某些页面通过 page-index=0,1,2,3... 分页，需要直接构造 URL 访问
   * 返回在 Node.js 中累积的表格数据数组
   */
  async fetchPaginatedUrls(page, baseUrl, options = {}) {
    const { separatePages = false } = options;
    const accumulatedData = []; // 在 Node.js 中累积，避免 page.goto 刷新丢失
    const pagesData = []; // 用于 separatePages 模式：每个 page-index 独立保存

    try {
      const urlObj = new URL(baseUrl);
      const path = urlObj.pathname;

      // 处理财务数据页面（bs/ps/cfs/is）和重大事项页面（/m），排除 /fundamental/* 分析页面
      const paginatedPaths = ['/bs', '/ps', '/cfs', '/is', '/m'];
      const isPaginatedPage = paginatedPaths.some(p => path.endsWith(p));
      const isFinancialStatement = ['/bs', '/ps', '/cfs', '/is'].some(p => path.endsWith(p));
      if (!isPaginatedPage) return separatePages ? pagesData : accumulatedData;

      console.log(`  [Lixinger] 开始 URL 分页遍历...`);

      const buildUrl = (pageIndex) => {
        const u = new URL(baseUrl);
        u.searchParams.set('page-index', String(pageIndex));
        if (isFinancialStatement) {
          // 财务报表页面专用参数
          if (!u.searchParams.has('modulate-type')) u.searchParams.set('modulate-type', 'auto');
          if (!u.searchParams.has('fs-owner-type')) u.searchParams.set('fs-owner-type', 'consolidated');
          if (!u.searchParams.has('granularity')) u.searchParams.set('granularity', 'q');
          if (!u.searchParams.has('data-display-type')) u.searchParams.set('data-display-type', 'number');
          if (!u.searchParams.has('with-latest-data')) u.searchParams.set('with-latest-data', 'false');
          if (!u.searchParams.has('show-value-rebuilt-data')) u.searchParams.set('show-value-rebuilt-data', 'false');
          if (!u.searchParams.has('data-report-type')) u.searchParams.set('data-report-type', 'all');
          if (!u.searchParams.has('data-metrics-types')) u.searchParams.set('data-metrics-types', 't,c,c2y,yoy,coc');
          if (!u.searchParams.has('compare-stock-ids')) u.searchParams.set('compare-stock-ids', '');
          if (!u.searchParams.has('start-date')) {
            const startYear = new Date().getFullYear() - 30;
            const today = new Date().toISOString().split('T')[0];
            u.searchParams.set('start-date', `${startYear}-01-01`);
            u.searchParams.set('end-date', today);
          }
        } else if (path.endsWith('/m')) {
          // 重大事项页面参数：只保留 granularity（年报/季报）
          if (!u.searchParams.has('granularity')) u.searchParams.set('granularity', 'q');
        }
        return u.toString();
      };

      let pageIndex = 0;
      const maxPages = 100;
      let emptyCount = 0;
      const maxEmpty = 3;

      while (pageIndex < maxPages && emptyCount < maxEmpty) {
        const pageUrl = buildUrl(pageIndex);
        const currentUrl = page.url();

        // 检查是否需要导航：page-index 不同 或 granularity 不同 都需要重新导航
        const expectedGranularity = new URL(pageUrl).searchParams.get('granularity') || 'q';
        const currentGranularity = new URL(currentUrl).searchParams.get('granularity') || 'q';
        const needsNavigation = !currentUrl.includes(`page-index=${pageIndex}`) || currentGranularity !== expectedGranularity;

        if (needsNavigation) {
          console.log(`  [Lixinger] 导航到 page-index=${pageIndex} granularity=${expectedGranularity}...`);
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.waitForLixingerContent(page);
          await page.waitForTimeout(1500);
        }

        // 提取当前页表格数据（返回给 Node.js）
        const pageTables = await page.evaluate(() => {
          const results = [];
          const tables = document.querySelectorAll('table');
          tables.forEach((table, idx) => {
            const headers = [];
            const headerCells = table.querySelectorAll('thead th, thead td');
            headerCells.forEach(cell => headers.push(cell.textContent?.trim() || ''));
            if (headers.length === 0) {
              const firstRow = table.querySelector('tr');
              if (firstRow) {
                firstRow.querySelectorAll('th, td').forEach(cell => headers.push(cell.textContent?.trim() || ''));
              }
            }

            const rows = [];
            const bodyRows = table.querySelectorAll('tbody tr');
            const rowsToProcess = bodyRows.length > 0 ? bodyRows : table.querySelectorAll('tr');
            rowsToProcess.forEach((row, rowIndex) => {
              if (rowIndex === 0 && headers.length > 0 && bodyRows.length === 0) return;
              const cells = Array.from(row.querySelectorAll('td, th'));
              if (cells.length === 0) return;
              const rowData = cells.map(cell => cell.textContent?.trim() || '');
              if (rowData.every(c => c === '')) return;
              rows.push(rowData);
            });

            if (headers.length > 0 || rows.length > 0) {
              results.push({ index: idx, headers, rows, caption: '' });
            }
          });
          return results;
        });

        if (separatePages) {
          // 单独保存每个 page 的数据（不合并列）
          const filteredTables = [];
          for (const pt of pageTables) {
            // 跳过公司概况表（PE-TTM 等）
            if (pt.headers[0]?.includes('PE-TTM') || pt.headers[0]?.includes('贵州茅台 沪股通')) continue;
            // 跳过空表或只有标签列的表
            if (pt.headers.length <= 1 && pt.rows.length === 0) continue;

            // 过滤掉纯子标题行（如 Q1/Q2/Q3/Q4/原值/同比/环比 等）
            const filteredRows = pt.rows.filter(r => !this.isSubHeaderRow(r));

            if (pt.headers.length > 0 || filteredRows.length > 0) {
              filteredTables.push({
                index: pt.index,
                headers: [...pt.headers],
                rows: filteredRows.map(r => [...r]),
                caption: ''
              });
            }
          }

          // 检测是否有新数据：比较当前 page 和上一个 page 的表头（去掉标签列）
          let hasNewData = false;
          if (filteredTables.length > 0) {
            if (pagesData.length === 0) {
              hasNewData = true; // 第一个 page 总是有数据
            } else {
              const lastPage = pagesData[pagesData.length - 1];
              for (const table of filteredTables) {
                const lastTable = lastPage.tables.find(t => t.index === table.index);
                if (!lastTable) {
                  hasNewData = true;
                  break;
                }
                // 比较数据列头（去掉第一个标签列）
                const currentDataHeaders = table.headers.slice(1).join(',');
                const lastDataHeaders = lastTable.headers.slice(1).join(',');
                if (currentDataHeaders !== lastDataHeaders) {
                  hasNewData = true;
                  break;
                }
              }
            }
          }

          if (hasNewData) {
            pagesData.push({ pageIndex, tables: filteredTables });
            emptyCount = 0;
            console.log(`  [Lixinger] page-index=${pageIndex} 独立页面，${filteredTables.length} 个表格`);
          } else {
            emptyCount++;
            console.log(`  [Lixinger] page-index=${pageIndex} 无新数据 (${emptyCount}/${maxEmpty})`);
          }
        } else {
          // 水平合并：每个 page-index 显示相同行、不同列（年份），需要合并列
          let totalNewCols = 0;
          for (const pt of pageTables) {
            // 跳过公司概况表（PE-TTM 等）
            if (pt.headers[0]?.includes('PE-TTM') || pt.headers[0]?.includes('贵州茅台 沪股通')) continue;
            // 跳过空表或只有标签列的表
            if (pt.headers.length <= 2 && pt.rows.length === 0) continue;

            // 过滤掉纯子标题行（如 Q1/Q2/Q3/Q4/原值/同比/环比 等）
            const filteredRows = pt.rows.filter(r => !this.isSubHeaderRow(r));

            let existing = accumulatedData.find(t => t.index === pt.index);
            if (!existing) {
              // 第一次遇到这个表格索引：完整复制
              existing = {
                index: pt.index,
                headers: [...pt.headers],
                rows: filteredRows.map(r => [...r]),
                caption: ''
              };
              accumulatedData.push(existing);
              totalNewCols += pt.headers.length > 0 ? pt.headers.length - 1 : 0;
            } else {
              // 已存在：水平合并列
              const labelHeader = existing.headers[0];
              const existingDataHeaders = existing.headers.slice(1);
              const newDataHeaders = pt.headers.slice(1);

              // 收集新出现的列头
              const addedHeaders = [];
              for (const h of newDataHeaders) {
                if (!existingDataHeaders.includes(h)) {
                  existingDataHeaders.push(h);
                  addedHeaders.push(h);
                }
              }

              if (addedHeaders.length === 0) continue;

              existing.headers = [labelHeader, ...existingDataHeaders];
              totalNewCols += addedHeaders.length;

              // 为每一行追加新列的值
              const newRowsMap = new Map();
              for (const row of pt.rows) {
                newRowsMap.set(row[0], row.slice(1));
              }

              // 更新已有行
              for (const existingRow of existing.rows) {
                const label = existingRow[0];
                const newValues = newRowsMap.get(label);
                if (newValues) {
                  for (const h of addedHeaders) {
                    const idx = newDataHeaders.indexOf(h);
                    existingRow.push(idx >= 0 && idx < newValues.length ? newValues[idx] : '');
                  }
                  newRowsMap.delete(label);
                } else {
                  // 新页没有这一行，补空值
                  for (const h of addedHeaders) {
                    existingRow.push('');
                  }
                }
              }

              // 添加新页独有的行
              for (const [label, newValues] of newRowsMap) {
                const row = [label];
                // 旧列补空
                for (const h of existingDataHeaders) {
                  const idx = newDataHeaders.indexOf(h);
                  row.push(idx >= 0 && idx < newValues.length ? newValues[idx] : '');
                }
                existing.rows.push(row);
              }
            }
          }

          if (totalNewCols === 0) {
            emptyCount++;
            console.log(`  [Lixinger] page-index=${pageIndex} 无新列 (${emptyCount}/${maxEmpty})`);
          } else {
            emptyCount = 0;
            console.log(`  [Lixinger] page-index=${pageIndex} 新增 ${totalNewCols} 列`);
          }
        }

        pageIndex++;
      }

      // 导航回原始 URL，确保后续 UI 点击在原页面执行
      const currentUrl = page.url();
      if (!currentUrl.startsWith(baseUrl.split('?')[0])) {
        console.log(`  [Lixinger] 导航回原始页面...`);
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.waitForLixingerContent(page);
      }

      if (separatePages) {
        console.log(`  [Lixinger] URL 分页遍历完成，共 ${pagesData.length} 个独立页面`);
        return pagesData;
      }

      console.log(`  [Lixinger] URL 分页遍历完成，共检查 ${pageIndex} 页，累积 ${accumulatedData.length} 个表格`);
    } catch (error) {
      console.log(`  [Lixinger] URL 分页遍历结束: ${error.message}`);
    }

    return separatePages ? pagesData : accumulatedData;
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
      // 优先使用分页收集的数据（如果有的话）
      const paginatedData = window.__lixingerPaginatedData;
      if (paginatedData && paginatedData.length > 0) {
        paginatedData.forEach((tableData, index) => {
          if (tableData.headers.length > 0 || tableData.rows.length > 0) {
            const result = {
              headers: tableData.headers,
              rows: tableData.rows,
              caption: tableData.caption || ''
            };
            result.index = index;
            data.tables.push(result);
            data.mainContent.push({ type: 'table', ...result });
          }
        });
      } else {
        const tables = document.querySelectorAll('table');
        tables.forEach((table, index) => {
          const result = extractTableData(table);
          if (result) {
            result.index = index;
            data.tables.push(result);
            data.mainContent.push({ type: 'table', ...result });
          }
        });
      }

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

      // 第一轮：从常见文本元素提取
      const allTextElements = document.querySelectorAll('p, div[class*="text"], div[class*="desc"], span[class*="value"], span[class*="label"], section, article');
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

      // 第二轮：捕获可能遗漏的说明文字（如数据来源、更新频率等）
      // 这些文字可能在普通 div/span/p/small 中，没有特定 class
      // 使用 TreeWalker 遍历文本节点，能捕获被分割在多个元素中的说明文字
      const usefulPatterns2 = ['数据来源', '基础数据', '源自于', '更新', '统计', '说明', '排名', '占比',
        '累计', '截止', '截至', '来源于', '每周', '每月', '每年', '季度', '年度',
        '仅包含', '不包含', '以上数据', '数据范围', '中登'];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let textNode;
      while (textNode = walker.nextNode()) {
        const text = textNode.textContent?.trim();
        if (!text || text.length < 5 || text.length > 200) continue;
        if (seenTexts.has(text)) continue;
        const parent = textNode.parentElement;
        if (!parent) continue;
        // 跳过表格单元格中的文字（避免表头被当作说明文字）
        if (parent.tagName === 'TH' || parent.tagName === 'TD' || parent.closest('table, .el-table, .ant-table')) continue;
        const parentStyle = window.getComputedStyle(parent);
        if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') continue;
        if (usefulPatterns2.some(p => text.includes(p))) {
          seenTexts.add(text);
          data.paragraphs.push(text);
        }
      }

      // 第三轮：从元素级别补充捕获（处理整段说明文字）
      const navFooterTerms = ['首页', '公司', '天眼', '筛选器', '行业', '指数', '基金', '债券', '制图', '模型',
        '宏观', '开放平台', '免责申明', '加入我们', '价格调整表', '更新日志', 'APP更新日志', '友情链接',
        '客服电话', '京ICP备', '风险提示', '推荐Chrome', '用户协议', '免责声明', '隐私政策', '登录', '注册',
        '忘记密码', '第三方登录', '搜索(包含A股', 'Ctrl', 'K', '白天', '夜间', '中文', '公告', '互动易',
        '讨论', '资源分享', '波动率', '重大事件', '公司概况', '监管', '分红融资', '资金流向', '股本结构',
        '高管', '控参股公司', '员工', '客户及供应商', '经营数据', '营收构成', '财务指标', '资产负债表',
        '利润表', '现金流量表', '自定义财报', '基本面'];
      document.querySelectorAll('div, span, p, small, aside, footer, section, li').forEach(el => {
        const text = el.textContent?.trim();
        if (!text || text.length < 5 || text.length > 300) return;
        if (seenTexts.has(text)) return;
        if (navFooterTerms.some(t => text.includes(t))) return;
        if (usefulPatterns2.some(p => text.includes(p))) {
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
        const { url, data, field } = apiResponse;
        if (!Array.isArray(data) || data.length === 0) continue;

        // 特殊处理：fsMetricsList 数据（来自 /fs-metrics/list-info）
        // 这类数据包含时间序列的财务指标，需要转换为人类可读的表格
        if (field === 'fsMetricsList' || this.isFsMetricsList(data)) {
          const metricTable = this.convertFsMetricsListToTable(data, url);
          if (metricTable) {
            tables.push(metricTable);
          }
          continue;
        }

        // 特殊处理：价格指标数据（来自 /price-metrics/get-price-metrics-chart-info）
        if (field === 'priceMetricsList' || this.isPriceMetricsList(data)) {
          const priceTable = this.convertPriceMetricsListToTable(data, url);
          if (priceTable) {
            tables.push(priceTable);
          }
          continue;
        }

        // 特殊处理：股权质押历史数据（来自 /api/company/pledge/list）
        if (url.includes('/company/pledge/list') || this.isPledgeList(data)) {
          const pledgeTable = this.convertPledgeListToTable(data, url);
          if (pledgeTable) {
            tables.push(pledgeTable);
          }
          continue;
        }

        // 特殊处理：简单时间序列数据（如波动率、股价等 {date, value} 格式）
        if (this.isSimpleTimeSeries(data)) {
          const tsTable = this.convertSimpleTimeSeriesToTable(data, url);
          if (tsTable) {
            tables.push(tsTable);
          }
          continue;
        }

        // 递归展平对象，同时自动解包 {t: value} / {value: value} 等包装器
        const flattenObj = (obj, prefix = '') => {
          const result = {};
          for (const [k, v] of Object.entries(obj)) {
            const newKey = prefix ? `${prefix}.${k}` : k;
            if (v && typeof v === 'object' && !Array.isArray(v)) {
              // 检查是否是值包装器（如 {t: 123} 或 {value: 123}）
              const isWrapper = Object.keys(v).length === 1 && (v.t !== undefined || v.value !== undefined);
              if (isWrapper) {
                result[newKey] = v.t !== undefined ? v.t : v.value;
              } else {
                Object.assign(result, flattenObj(v, newKey));
              }
            } else {
              result[newKey] = v;
            }
          }
          return result;
        };

        const flattenedData = data.map(item => flattenObj(item));

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
          source: 'api-data'
        });
      } catch (error) {
        // ignore
      }
    }

    return tables;
  }

  /**
   * 判断数据是否为 fsMetricsList 格式（来自 /fs-metrics/list-info）
   */
  isFsMetricsList(data) {
    if (!Array.isArray(data) || data.length === 0) return false;
    const first = data[0];
    return first.stockId !== undefined && first.date !== undefined &&
      first.q !== undefined && typeof first.q === 'object';
  }

  /**
   * 判断数据是否为 priceMetricsList 格式（来自 /price-metrics/get-price-metrics-chart-info）
   */
  isPriceMetricsList(data) {
    if (!Array.isArray(data) || data.length === 0) return false;
    const first = data[0];
    return first.stockId !== undefined && first.date !== undefined &&
      (first.d_pe_ttm !== undefined || first.pb_wo_gw !== undefined || first.ps_ttm !== undefined);
  }

  /**
   * 将 priceMetricsList 转换为人类可读的表格
   * 采样为月度/季度数据点，避免 500+ 行日报表过于庞大
   */
  convertPriceMetricsListToTable(data, url) {
    try {
      // 指标名称映射
      const metricNames = {
        'd_pe_ttm': 'PE-TTM(扣非)',
        'pe_ttm': 'PE-TTM',
        'pb_wo_gw': 'PB(不含商誉)',
        'pb': 'PB',
        'ps_ttm': 'PS-TTM',
        'dyr': '股息率',
        'sp': '股价',
        'lxr_fc_rights': '理杏仁前复权'
      };

      // 选取有数据的指标列（支持直接数值或 { value: ... } 对象）
      const valueKeys = Object.keys(metricNames).filter(k =>
        data.some(d => {
          const v = d[k];
          if (v === undefined || v === null) return false;
          if (typeof v === 'object') return v.value !== undefined && v.value !== null;
          return true;
        })
      );
      if (valueKeys.length === 0) return null;

      // 按日期从新到旧排序
      const sortedData = [...data].sort((a, b) => new Date(b.date) - new Date(a.date));

      // 采样：每月取最后一个交易日，最多 24 个月
      const sampled = [];
      const seenMonths = new Set();
      for (const d of sortedData) {
        const date = new Date(d.date);
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        if (!seenMonths.has(monthKey)) {
          seenMonths.add(monthKey);
          sampled.push(d);
        }
        if (sampled.length >= 24) break;
      }

      const dates = sampled.map(d => {
        const date = new Date(d.date);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      }).reverse();
      const rowsData = sampled.reverse();

      const rows = [];
      for (const key of valueKeys) {
        const name = metricNames[key];
        const values = rowsData.map(d => {
          const raw = d[key];
          if (raw === undefined || raw === null) return '';
          // API 某些字段返回 { value: number, u: ..., m: ..., l: ... }
          const v = typeof raw === 'object' && raw.value !== undefined ? raw.value : raw;
          if (v === undefined || v === null || Number.isNaN(v)) return '';
          // 股息率为小数，转为百分比
          if (key === 'dyr') return (v * 100).toFixed(2) + '%';
          // 股价类保留两位小数
          if (key === 'sp' || key === 'lxr_fc_rights') return Number(v).toFixed(2);
          // 估值指标保留两位小数
          return Number(v).toFixed(2);
        });
        rows.push([name, ...values]);
      }

      return {
        index: 0,
        headers: ['指标', ...dates],
        rows,
        caption: '估值指标',
        source: 'price-metrics'
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * 将 fsMetricsList 转换为人类可读的表格
   * 行=指标（毛利率、ROE等），列=日期
   */
  convertFsMetricsListToTable(data, url) {
    try {
      // 指标名称映射
      const metricNames = {
        'ps.toi': '营业总收入', 'ps.toc': '营业总成本', 'ps.gp': '毛利润',
        'ps.op': '营业利润', 'ps.np': '净利润', 'ps.npadnrpatoshaopc': '扣非净利润',
        'ps.gp_m': '毛利率', 'ps.op_m': '营业利润率', 'ps.np_m': '净利润率',
        'ps.np_s_r': '销售净利率', 'ps.npadnrpatoshaopc_npatoshopc_r': '扣非净利润占比',
        'ps.wdroe': '扣非加权ROE', 'ps.ebit': 'EBIT', 'ps.ebitda': 'EBITDA',
        'ps.da': '折旧摊销', 'ps.ie': '利息支出', 'ps.oe': '营业外收支',
        'm.wroe': '加权ROE', 'm.roe': 'ROE', 'm.roe_atoshaopc': 'ROE(归属母公司)',
        'm.roe_adnrpatoshaopc': '扣非ROE', 'm.roa': 'ROA', 'm.roic': 'ROIC',
        'm.roc': '投入资本回报率', 'm.ta_to': '总资产周转率', 'm.l': '权益乘数',
        'm.gp_m': '毛利率', 'm.np_s_r': '净利润率',
        'bs.ta': '总资产', 'bs.tl': '总负债', 'bs.te': '股东权益',
        'bs.ca': '流动资产', 'bs.cl': '流动负债', 'bs.nca': '非流动资产',
        'bs.ncl': '非流动负债', 'bs.fa': '固定资产', 'bs.ia': '无形资产',
        'bs.ar': '应收账款', 'bs.inv': '存货', 'bs.ltbor': '长期借款',
        'cfs.ncf': '净现金流', 'cfs.ocf': '经营现金流', 'cfs.icf': '投资现金流',
        'cfs.fcf': '自由现金流', 'cfs.ocf_ps': '每股经营现金流'
      };

      // 计算方式名称映射
      const calcTypeNames = {
        't': '累计',
        't_y2y': '累计同比',
        't_c2c': '累计环比',
        'c': '单季',
        'c_y2y': '单季同比',
        'c_c2c': '单季环比',
        'c_2y': '单季年比',
        'ttm': 'TTM',
        'ttm_y2y': 'TTM同比',
        'ttm_c2c': 'TTM环比',
        't_o': '累计(原值)',
        'c_o': '单季(原值)',
        'ttm_o': 'TTM(原值)',
        't_r': '累计(比率)',
        'c_r': '单季(比率)'
      };

      // 收集所有指标键和计算方式
      const allMetrics = new Set();
      const allCalcTypes = new Set();
      for (const d of data) {
        for (const [cat, metrics] of Object.entries(d.q || {})) {
          for (const [metric, values] of Object.entries(metrics)) {
            allMetrics.add(`${cat}.${metric}`);
            for (const calcType of Object.keys(values)) {
              if (calcType !== '_id') allCalcTypes.add(calcType);
            }
          }
        }
      }

      if (allMetrics.size === 0) return null;

      // 提取日期（从最新到最旧，按季度去重，取前 20 个）
      const sortedData = [...data].sort((a, b) => new Date(b.date) - new Date(a.date));
      const uniqueData = [];
      const seenQuarters = new Set();
      for (const d of sortedData) {
        const date = new Date(d.date);
        const year = date.getFullYear();
        const quarter = Math.ceil((date.getMonth() + 1) / 3);
        const qKey = `${year}Q${quarter}`;
        if (!seenQuarters.has(qKey)) {
          seenQuarters.add(qKey);
          uniqueData.push(d);
        }
        if (uniqueData.length >= 20) break;
      }
      const dates = uniqueData.map(d => {
        const date = new Date(d.date);
        const year = date.getFullYear();
        const quarter = Math.ceil((date.getMonth() + 1) / 3);
        return `${year}Q${quarter}`;
      });

      // 构建表格行：每行是一个指标+计算方式的组合
      const rows = [];
      const sortedMetrics = Array.from(allMetrics).sort();
      const sortedCalcTypes = ['t', 't_y2y', 't_c2c', 'c', 'c_y2y', 'c_c2c', 'c_2y', 'ttm', 'ttm_y2y', 'ttm_c2c', 't_o', 'c_o', 'ttm_o', 't_r', 'c_r']
        .filter(ct => allCalcTypes.has(ct));

      for (const key of sortedMetrics) {
        const [category, metric] = key.split('.');
        const baseName = metricNames[key] || key;

        for (const calcType of sortedCalcTypes) {
          const calcName = calcTypeNames[calcType] || calcType;
          const values = uniqueData.map(d => {
            const metricObj = d.q?.[category]?.[metric];
            if (!metricObj) return '';
            let v = metricObj[calcType];
            if (v === undefined || v === null) return '';
            // 小于等于1的值视为百分比（如 0.8975 = 89.75%）
            if (Math.abs(v) <= 1 && v !== 0) return (v * 100).toFixed(2) + '%';
            // 大数值保留两位小数
            return Number(v).toFixed(2);
          });

          // 只添加有数据的行
          if (values.some(v => v !== '')) {
            rows.push([`${baseName}(${calcName})`, ...values]);
          }
        }
      }

      return {
        index: 0,
        headers: ['指标', ...dates],
        rows,
        caption: '财务指标',
        source: 'fs-metrics'
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * chart-maker/fs-metrics 页面：获取所有财务指标数据
   * 通过直接调用 API 获取 comprehensive metrics，而不是仅依赖页面默认选中的指标
   */
  async fetchAllChartMakerMetrics(page, stockId) {
    try {
      const comprehensiveMetrics = [
        // 利润表 (ps)
        'ps.toi', 'ps.toc', 'ps.gp', 'ps.op', 'ps.np', 'ps.npadnrpatoshaopc',
        'ps.gp_m', 'ps.op_m', 'ps.np_m', 'ps.np_s_r', 'ps.npadnrpatoshaopc_npatoshopc_r',
        'ps.wdroe', 'ps.ebit', 'ps.ebitda', 'ps.da', 'ps.ie', 'ps.oe',
        // 指标 (m)
        'm.roe', 'm.roe_atoshaopc', 'm.roe_adnrpatoshaopc', 'm.wroe',
        'm.roa', 'm.roic', 'm.roc', 'm.ta_to', 'm.l', 'm.gp_m', 'm.np_s_r',
        // 资产负债表 (bs)
        'bs.ta', 'bs.tl', 'bs.te', 'bs.ca', 'bs.cl', 'bs.nca', 'bs.ncl',
        'bs.fa', 'bs.ia', 'bs.ar', 'bs.inv', 'bs.ltbor',
        // 现金流量表 (cfs)
        'cfs.ncf', 'cfs.ocf', 'cfs.icf', 'cfs.fcf', 'cfs.ocf_ps'
      ];

      console.log(`  [Lixinger] 获取 chart-maker 全部指标数据...`);

      const result = await page.evaluate(async ({ stockId, metrics }) => {
        try {
          const endDate = new Date().toISOString().split('T')[0];
          const startDate = `${new Date().getFullYear() - 30}-01-01`;
          const res = await fetch('https://www.lixinger.com/api/company/fs-metrics/list-info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              stockIds: [parseInt(stockId)],
              startDate: `${startDate}T00:00:00.000Z`,
              endDate: `${endDate}T00:00:00.000Z`,
              ownerTypes: ['consolidated'],
              granularities: ['q'],
              metricsNames: metrics,
              expressionCalculateTypes: ['t', 't_y2y', 't_c2c', 'c', 'c_y2y', 'c_c2c', 'c_2y', 'ttm', 'ttm_y2y', 'ttm_c2c', 't_o', 'c_o', 'ttm_o'],
              withLatestData: true
            })
          });
          return await res.json();
        } catch (e) {
          return { error: e.message };
        }
      }, { stockId: String(stockId), metrics: comprehensiveMetrics });

      if (result.error) {
        console.log(`  [Lixinger] chart-maker API 错误: ${result.error}`);
        return null;
      }

      if (result.fsMetricsList && result.fsMetricsList.length > 0) {
        const metricCount = new Set();
        for (const item of result.fsMetricsList) {
          for (const [cat, metrics] of Object.entries(item.q || {})) {
            for (const m of Object.keys(metrics)) {
              metricCount.add(`${cat}.${m}`);
            }
          }
        }
        console.log(`  [Lixinger] chart-maker 获取 ${result.fsMetricsList.length} 条数据，${metricCount.size} 个指标`);
        return result.fsMetricsList;
      }

      return null;
    } catch (e) {
      console.log(`  [Lixinger] chart-maker 获取失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 判断数据是否为股权质押历史数据（来自 /api/company/pledge/list）
   */
  isPledgeList(data) {
    if (!Array.isArray(data) || data.length === 0) return false;
    const first = data[0];
    return first.stockId !== undefined && first.date !== undefined &&
      first.pledgeRatio !== undefined && first.pledgeCounts !== undefined;
  }

  /**
   * 将股权质押历史数据转换为人类可读的表格
   * 行=时间序列，列=质押指标
   */
  convertPledgeListToTable(data, url) {
    try {
      const fieldNames = {
        date: '日期',
        pledgeCounts: '质押笔数',
        noLimitedPledgeNums: '无限售股质押(股)',
        limitedPledgeNums: '有限售股质押(股)',
        capitalization: '总股本(股)',
        pledgeRatio: '质押比例',
        top10ShareholdersPledgeRatio: '前十大股东质押比例'
      };

      // 按日期从新到旧排序，取最近 50 条（约 1 年）
      const sortedData = [...data].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 50);

      const rows = sortedData.map(d => {
        const date = new Date(d.date);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const pledgeRatio = d.pledgeRatio !== undefined ? (d.pledgeRatio * 100).toFixed(4) + '%' : '';
        const top10Ratio = d.top10ShareholdersPledgeRatio !== undefined ? (d.top10ShareholdersPledgeRatio * 100).toFixed(4) + '%' : '';
        return [
          dateStr,
          d.pledgeCounts ?? '',
          d.noLimitedPledgeNums ?? '',
          d.limitedPledgeNums ?? '',
          d.capitalization ?? '',
          pledgeRatio,
          top10Ratio
        ];
      });

      return {
        index: 0,
        headers: ['日期', '质押笔数', '无限售股质押(股)', '有限售股质押(股)', '总股本(股)', '质押比例', '前十大股东质押比例'],
        rows,
        caption: '股权质押历史数据',
        source: 'pledge-api'
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * 判断数据是否为简单时间序列（如波动率、股价等 {date, value} 格式）
   */
  isSimpleTimeSeries(data) {
    if (!Array.isArray(data) || data.length === 0) return false;
    const first = data[0];
    if (!first.date) return false;
    // 检查是否只包含 date + 简单数值字段（不超过 5 个字段）
    const keys = Object.keys(first);
    if (keys.length > 5) return false;
    // 至少有一个数值字段
    const hasNumericField = keys.some(k =>
      k !== 'date' && k !== 'stockId' && k !== '_id' &&
      (typeof first[k] === 'number' || typeof first[k] === 'string')
    );
    return hasNumericField;
  }

  /**
   * 将简单时间序列数据转换为人类可读的表格
   * 按月采样，避免日报表过于庞大
   */
  convertSimpleTimeSeriesToTable(data, url) {
    try {
      const first = data[0];
      const keys = Object.keys(first).filter(k =>
        k !== 'date' && k !== 'stockId' && k !== '_id'
      );
      if (keys.length === 0) return null;

      // 指标名称映射
      const metricNames = {
        value: '数值',
        lxr_fc_rights: '理杏仁前复权',
        sp: '股价',
        d_pe_ttm: 'PE-TTM',
        pb_wo_gw: 'PB(不含商誉)',
        ps_ttm: 'PS-TTM',
        dyr: '股息率',
        volatility: '波动率',
        turnover: '换手率',
        amplitude: '振幅'
      };

      // 按月采样（取每月最后一个数据点）
      const monthlyData = [];
      const seenMonths = new Set();
      const sortedData = [...data].sort((a, b) => new Date(b.date) - new Date(a.date));

      for (const d of sortedData) {
        const date = new Date(d.date);
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        if (!seenMonths.has(monthKey)) {
          seenMonths.add(monthKey);
          monthlyData.push(d);
        }
        if (monthlyData.length >= 60) break; // 最多 60 个月
      }

      monthlyData.reverse(); // 从旧到新

      const dates = monthlyData.map(d => {
        const date = new Date(d.date);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      });

      const rows = [];
      for (const key of keys) {
        const name = metricNames[key] || key;
        const values = monthlyData.map(d => {
          const v = d[key];
          if (v === undefined || v === null) return '';
          if (typeof v === 'number') return v.toFixed(2);
          return String(v);
        });
        rows.push([name, ...values]);
      }

      // 从 URL 中提取页面类型作为标题
      const urlPath = url.split('/').pop().split('?')[0];
      const captionMap = {
        'list': '时间序列数据',
        'price-metrics': '价格指标',
        'get-price-metrics-chart-info': '估值指标'
      };
      const caption = captionMap[urlPath] || '时间序列数据';

      return {
        index: 0,
        headers: ['指标', ...dates],
        rows,
        caption,
        source: 'api-data'
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * 格式化最终结果
   */
  /**
   * 判断表格是否为财务报表数据（资产负债表/利润表/现金流量表）
   * 排除公司概况、估值指标等非财务表格
   */
  isFinancialTable(table) {
    if (!table || !table.headers || table.rows.length === 0) return false;

    const headerText = table.headers.join(' ');

    // 快速判断 1：表头包含独立的年份/季度列 → 财务表
    // 支持格式：2001, 2026Q1, Q1, 2026-05 等
    const hasYearHeader = table.headers.some(h =>
      /^\s*20\d{2}\s*$/.test(String(h)) ||           // 2001
      /^\s*20\d{2}Q[1-4]\s*$/.test(String(h)) ||    // 2026Q1
      /^\s*\d{4}-\d{2}\s*$/.test(String(h)) ||      // 2026-05
      /^\s*Q[1-4]\s*$/.test(String(h))               // Q1
    );
    if (hasYearHeader) {
      return true;
    }

    // 快速判断 2：表头包含明确的财务关键字 → 财务表
    // 同时排除公司估值指标（PE-TTM、PB、股息率等）
    const stockMetrics = ['PE-TTM', 'PB', '股息率', '股价', '涨跌幅', '市值'];
    const hasStockMetrics = stockMetrics.some(m => headerText.includes(m));
    if (hasStockMetrics) return false;

    const financialTerms = [
      '资产', '负债', '权益', '流动资产', '货币资金', '应收账款',
      '存货', '固定资产', '无形资产', '商誉', '长期股权投资',
      '负债合计', '流动负债', '非流动负债', '应付账款',
      '所有者权益', '股本', '资本公积', '未分配利润',
      '营业收入', '营业成本', '净利润', '毛利率',
      '现金流量', '经营活动', '投资活动', '筹资活动',
      '默认单位', '审计意见', '报表日期'
    ];
    const hasFinancialHeader = financialTerms.some(term => headerText.includes(term));
    if (hasFinancialHeader) return true;

    // 排除 API 原始数据表格（字段名为英文代码如 q.bs.ta, stockId 等）
    const isApiRawData = table.source === 'api' ||
      table.headers.some(h => /^(stockId|date|ownerType|dataType|q\.bs\.|q\.is\.|q\.cf\.)/.test(String(h)));
    if (isApiRawData) return false;

    // 排除公司概况表格（包含 PE-TTM、PB、股息率、股价等）
    const allText = [...table.headers, ...table.rows.flat()].join(' ');
    const nonFinancialPatterns = [
      /PE-TTM.*PB.*股息率/,
      /股价.*涨跌幅.*市值/,
      /所属三级行业.*申万/,
      /所属指数.*纳入纳出/,
      /最新大宗交易/,
      /实际控制人/
    ];
    if (nonFinancialPatterns.some(p => p.test(allText))) return false;

    // 排除纯子标题表格（只包含 Q1/Q2/Q3/Q4/原值/同比/环比/当期/累计/单季/年比 等）
    const subHeaderTerms = ['Q1', 'Q2', 'Q3', 'Q4', '原值', '同比', '环比', '当期', '累计', '单季', '年比'];
    const isSubHeaderOnly = table.rows.length > 0 && table.rows.every(row => {
      const nonEmptyCells = row.filter(c => c && c.trim() !== '');
      if (nonEmptyCells.length === 0) return true;
      return nonEmptyCells.every(c => subHeaderTerms.includes(c.trim()));
    });
    if (isSubHeaderOnly) return false;

    // 排除只有 "默认单位" 一个表头、无年份列的无意义表格
    if (table.headers.length === 1 && table.headers[0].includes('默认单位')) return false;

    // 兜底：整表包含财务关键字或年份/季度，且有一定规模
    const hasFinancialTerm = financialTerms.some(term => allText.includes(term));
    const hasYearOrQuarter = /\b20\d{2}\b/.test(allText) || /\bQ[1-4]\b/.test(allText);
    const isLargeTable = table.rows.length > 30;

    return hasFinancialTerm || hasYearOrQuarter || isLargeTable;
  }

  /**
   * 根据 URL 生成建议文件名，包含粒度标识（yearly/quarter/half_year）
   */
  buildSuggestedFilename(url) {
    try {
      const u = new URL(url);
      const path = u.pathname;

      // 从路径推断报表类型（只匹配真正的财务报表页面，排除 /fundamental/* 分析页面）
      const pathMap = {
        '/bs': '资产负债表',
        '/ps': '利润表',
        '/cfs': '现金流量表',
        '/is': '利润表'
      };
      let reportType = '';
      // 排除 fundamental 分析页面，避免 /fundamental/cashflow 被误判为现金流量表
      const isFundamentalPage = path.includes('/fundamental/');
      if (!isFundamentalPage) {
        for (const [key, value] of Object.entries(pathMap)) {
          if (path.endsWith(key)) {
            reportType = value;
            break;
          }
        }
      }

      // 从路径提取股票代码（如 600519）
      const stockMatch = path.match(/\/(sh|sz)\/(\d+)/);
      const stockCode = stockMatch ? stockMatch[2] : '';

      // 在财务报表页面（bs/ps/cfs）添加粒度后缀
      // /m 页面的粒度后缀在 parse() 中单独处理
      if (reportType) {
        const granularity = u.searchParams.get('granularity') || 'q';
        const granularitySuffix = { y: 'yearly', q: 'quarter', h: 'half_year' }[granularity] || 'quarter';
        return `${stockCode}_${reportType}_${granularitySuffix}`;
      }

      // /m (重大事项) 页面单独处理
      if (path.endsWith('/m')) {
        return `${stockCode}_major-issues`;
      }

      // 非财务报表页面：用 URL 路径最后几段拼接文件名（如 subsidiary-companies, fundamental_valuation_primary）
      const pathParts = path.split('/').filter(p => p && !/^\d+$/.test(p) && !['sh', 'sz', 'analytics', 'company', 'detail', 'open', 'api'].includes(p));
      const suffix = pathParts.join('_');
      if (suffix) {
        return `${stockCode}_${suffix}`;
      }
      return `${stockCode}_data`;
    } catch (e) {
      return '';
    }
  }

  /**
   * 生成表格去重签名：用表头 + 前3行数据的 MD5
   */
  tableSignature(table) {
    const sample = JSON.stringify(table.headers) +
      JSON.stringify(table.rows.slice(0, 3));
    return sample;
  }

  /**
   * 判断是否为公司概况/概览表格（PE-TTM、PB、所属行业、所属指数等）
   * 这类表格出现在几乎所有页面顶部，只在 fundamental 页保留
   */
  isCompanyOverviewTable(table) {
    if (!table || !table.headers) return false;
    // 公司概况表格通常是小型表格（< 15 行），大表格（如资产负债表）即使包含
    // PE-TTM/PB/股息率等行也不应被误判为公司概况
    if (table.rows.length > 15) return false;
    const allText = [...table.headers, ...table.rows.flat()].join(' ');
    const overviewPatterns = [
      /PE-TTM.*PB.*股息率/,
      /股价.*涨跌幅.*市值/,
      /所属三级行业.*申万/,
      /所属指数.*纳入纳出/,
      /最新大宗交易/,
      /实际控制人/,
    ];
    return overviewPatterns.some(p => p.test(allText));
  }

  /**
   * 判断一行是否仅为季度/指标子标题行（如 "Q1|Q4|Q3|Q2|Q1" 或 "原值|同比|环比"）
   * 这些行在 DOM 中作为视觉分隔，没有实际财务数据，应从输出中剔除
   */
  isSubHeaderRow(row) {
    if (!row || row.length === 0) return true;
    const subHeaderTerms = ['Q1', 'Q2', 'Q3', 'Q4', '原值', '同比', '环比', '当期', '累计', '单季', '年比'];
    const nonEmptyCells = row.filter(c => c && c.trim() !== '');
    if (nonEmptyCells.length === 0) return true;
    return nonEmptyCells.every(c => subHeaderTerms.includes(c.trim()));
  }

  formatResult(data, url) {
    let allTables = data.tables || [];

    // 0. 过滤只有 1 列的表格（div-grid 误提取的指标列表、侧边栏等）
    allTables = allTables.filter(t => t.headers && t.headers.length > 1);

    // 1. 去重：同一页面内被多个选择器重复提取的表格
    const seen = new Set();
    allTables = allTables.filter(t => {
      const sig = this.tableSignature(t);
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });

    // 2. 公司概况表格（PE-TTM、PB、所属行业等）只在 fundamental 页保留
    // 其他页面（major-issues、custom、bs 等）都跳过，避免所有文件内容雷同
    const isFundamentalPage = /\/fundamental$/.test(url);
    if (!isFundamentalPage) {
      allTables = allTables.filter(t => !this.isCompanyOverviewTable(t));
    }

    // 3. metric-section 产生的零散指标表格（如 PE-TTM、PB 等单值表格）
    // 只在 fundamental 页保留，其他页面跳过
    if (!isFundamentalPage) {
      allTables = allTables.filter(t => {
        // 跳过 source === 'metric-section' 的零散指标表格
        if (t.source === 'metric-section') return false;
        // 跳过只有 2 列且表头为 "指标 | 数值" 的小型估值表格
        if (t.headers?.length === 2 && t.headers[0] === '指标' && t.headers[1] === '数值' && t.rows?.length <= 50) {
          const allText = t.rows.flat().join(' ');
          // 如果内容只包含数字、百分比或少量中文，判定为估值指标碎片
          const isMetricFragment = !allText.includes('资产') && !allText.includes('负债')
            && !allText.includes('收入') && !allText.includes('现金')
            && !allText.includes('利润') && !allText.includes('成本');
          if (isMetricFragment) return false;
        }
        return true;
      });
    }

    // 4. 过滤 API 原始数据表格（字段名为英文代码如 stockId, candlestick._id, date 等）
    // 这些表格在所有页面都应排除，因为它们包含内部字段而非人类可读数据
    // 但保留已人工转换的可读表格（fs-metrics、pledge-api 等）
    allTables = allTables.filter(t => {
      // 4a. 直接排除 source === 'api' 的原始数据表格
      // 保留经过人工转换的可读表格（fs-metrics、pledge-api）
      if (t.source === 'api') return false;
      // 4b. 排除表头包含典型 API 内部字段的表格
      // 但保留 api-data 来源的已转换表格（如时间序列数据）
      if (t.source !== 'api-data') {
        const apiFieldPatterns = [
          /^(stockId|ownerType|dataType|sp|candlestick\.|stock\.|q\.bs\.|q\.is\.|q\.cf\.)/,
          /^[a-f0-9]{24}$/,  // MongoDB ObjectId
        ];
        const hasApiFieldHeader = t.headers.some(h => apiFieldPatterns.some(p => p.test(String(h))));
        if (hasApiFieldHeader) return false;
      }
      // 4c. 排除整表内容几乎全是英文代码/ID/布尔值的表格
      // 但保留已人工转换的可读表格（fs-metrics、pledge-api、price-metrics、api-data）
      if (t.source !== 'fs-metrics' && t.source !== 'pledge-api' && t.source !== 'price-metrics' && t.source !== 'api-data') {
        const allText = [...t.headers, ...t.rows.flat()].join(' ');
        const isMostlyCodes = allText.split(/\s+/).filter(w => w.length > 0).length > 0 &&
          allText.split(/\s+/).filter(w => /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(w) || w === 'true' || w === 'false' || /^[a-f0-9]{24}$/.test(w)).length /
          allText.split(/\s+/).filter(w => w.length > 0).length > 0.7;
        if (isMostlyCodes && t.headers.length > 5) return false;
      }
      return true;
    });

    // 5. 排除股票对比/列表表格（如 "公司名称(905)", "PE-TTM", "PB" 等）
    // 这些表格出现在页面底部，属于股票筛选组件，不是当前页面数据
    allTables = allTables.filter(t => {
      const headerText = t.headers.join(' ');
      // 排除包含 "公司名称" 带股票数量的表头
      if (/公司名称\(\d+\)/.test(headerText)) return false;
      // 排除同时包含 #、PE-TTM、PB 的股票列表表格
      if (t.headers.includes('#') && t.headers.includes('PE-TTM') && t.headers.includes('PB')) return false;
      // 排除行中包含多个不同股票代码的表格
      const stockCodes = new Set();
      for (const row of t.rows) {
        for (const cell of row) {
          const match = String(cell).match(/(\d{6}\.(sh|sz|hk))/);
          if (match) stockCodes.add(match[1]);
        }
      }
      if (stockCodes.size >= 3) return false;
      return true;
    });

    // 6. 排除空表格（0 行数据）和单列表头为 "#" 的分页 artifact 表格
    allTables = allTables.filter(t => {
      if (t.rows.length === 0) return false;
      if (t.headers.length === 1 && t.headers[0] === '#') return false;
      return true;
    });

    // 6. 只在真正的财务报表页面（资产负债表/利润表/现金流量表）上应用财务表格过滤
    const isFinancialStatementPage = /\/(bs|ps|cfs|is|cashflow|income)\b/.test(url);
    const financialTables = isFinancialStatementPage
      ? allTables.filter(t => this.isFinancialTable(t))
      : allTables;

    // 只保留表格类型的 mainContent
    const financialMainContent = (data.mainContent || [])
      .filter(item => item.type === 'table')
      .filter(item => !isFinancialStatementPage || this.isFinancialTable(item));

    // 7. 保留页面特有的说明文字（如数据来源、更新频率等），过滤掉导航/页脚等通用文字
    const usefulParagraphs = (data.paragraphs || []).filter(p => {
      const text = String(p).trim();
      if (text.length < 5 || text.length > 300) return false;
      const navFooterTerms = ['首页', '公司', '天眼', '筛选器', '行业', '指数', '基金', '债券', '制图', '模型',
        '宏观', '开放平台', '免责申明', '加入我们', '价格调整表', '更新日志', 'APP更新日志', '友情链接',
        '客服电话', '京ICP备', '风险提示', '推荐Chrome', '用户协议', '免责声明', '隐私政策', '登录', '注册',
        '忘记密码', '第三方登录', '搜索(包含A股', 'Ctrl', 'K', '白天', '夜间', '中文', '公告', '互动易',
        '讨论', '资源分享', '波动率', '重大事件', '公司概况', '监管', '分红融资', '资金流向', '股本结构',
        '高管', '控参股公司', '员工', '客户及供应商', '经营数据', '营收构成', '财务指标', '资产负债表',
        '利润表', '现金流量表', '自定义财报', '基本面'];
      if (navFooterTerms.some(t => text.includes(t))) return false;
      // 排除 UI 占位文字（备注输入框、提示等）
      const uiPlaceholderTerms = ['双击修改', '无备注', '点击修改', '请输入', '选择', '全部', '提交反馈', '错误', '改进', '需求'];
      if (uiPlaceholderTerms.some(t => text === t || text.startsWith(t))) return false;
      // 保留包含数据来源、更新频率、说明备注等关键信息的段落
      const usefulPatterns = ['数据来源', '基础数据', '更新', '统计', '说明', '备注', '排名', '占比',
        '累计', '截止', '截至', '来源于', '源自于', '每周', '每月', '每年', '季度', '年度',
        '仅包含', '不包含', '以上数据', '数据范围'];
      return usefulPatterns.some(pattern => text.includes(pattern));
    });

    // 去重
    const uniqueParagraphs = [...new Set(usefulParagraphs)];

    return {
      type: 'lixinger',
      url,
      title: '',
      description: '',
      headings: [],
      mainContent: financialMainContent,
      paragraphs: uniqueParagraphs,
      lists: [],
      tables: financialTables,
      codeBlocks: [],
      images: [],
      charts: [],
      chartData: [],
      blockquotes: [],
      definitionLists: [],
      horizontalRules: 0,
      videos: [],
      audios: [],
      apiData: 0,
      pageFeatures: { suggestedType: 'lixinger', confidence: 100, signals: ['vue-spa', 'financial-data'] },
      tabsAndDropdowns: [],
      dateFilters: [],
      suggestedFilename: this.buildSuggestedFilename(url)
    };
  }
}

export default LixingerParser;
