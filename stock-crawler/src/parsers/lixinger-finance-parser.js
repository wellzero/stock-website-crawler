#!/usr/bin/env node

/**
 * Lixinger Finance Parser
 * 专门处理理杏仁财务数据页面：
 *   /bs (资产负债表), /ps (利润表), /cfs (现金流量表), /is (行业统计),
 *   /m (重大事项), /operation-revenue-constitution (营收构成)
 *
 * 继承 LixingerParser 的全部能力，覆盖 URL 匹配、分页遍历、文件名生成等逻辑，
 * 让 ParserManager 优先把财务页面路由到本解析器。
 */

import LixingerParser from './lixinger-parser.js';
import LinkFinder from '../link-finder.js';

class LixingerFinanceParser extends LixingerParser {
  /**
   * 匹配财务数据页面
   */
  matches(url) {
    const financePaths = ['/bs', '/ps', '/cfs', '/is', '/m', '/operation-revenue-constitution'];
    return url.includes('lixinger.com') &&
      financePaths.some(p => url.includes(p));
  }

  /**
   * 优先级高于 LixingerParser (100)
   */
  getPriority() {
    return 105;
  }

  /**
   * Parser-based 链接发现 — 为财务页面额外添加年报/季报粒度 URL
   */
  async discoverLinks(page, urlRules) {
    await this.waitForLixingerContent(page);
    const linkFinder = new LinkFinder();
    const links = await linkFinder.extractLinks(page, urlRules, { fetchMethod: 'playwright' });

    // parse() already handles both quarterly (q) and yearly (y) for financial
    // statement pages (/bs, /ps, /cfs, /m) in a single visit. Adding
    // granularity variants here would cause duplicate downloads.
    return links;
  }

  /**
   * 解析页面 — 覆盖以处理分页财务页面
   */
  async parse(page, url, options = {}) {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    const paginatedPaths = ['/bs', '/ps', '/cfs', '/is', '/m'];
    const isPaginatedPage = paginatedPaths.some(p => path.endsWith(p));
    const isFinancialStatement = ['/bs', '/ps', '/cfs'].some(p => path.endsWith(p));

    // 分页页面：每页数据存为独立文件（如 600519_资产负债表_quarter_0.md, _1.md...）
    if (isPaginatedPage && options.pagesDir) {
      const context = { page, url, options, data: {} };
      // /m 页面和财务报表页面都需要同时下载季报(q)和年报(y)
      const granularities = (path.endsWith('/m') || isFinancialStatement) ? ['q', 'y'] : [null];
      const granularityNames = { q: 'quarter', y: 'yearly' };
      let anyPagesSaved = false;
      const fs = await import('fs');

      for (const gran of granularities) {
        let pageUrlWithGran;
        if (gran !== null) {
          const u = new URL(url);
          u.searchParams.set('granularity', gran);
          pageUrlWithGran = u.toString();
        } else {
          pageUrlWithGran = url;
        }
        const paginatedPages = path.endsWith('/m')
          ? await this.fetchPaginatedUrlsByUIClick(page, pageUrlWithGran)
          : await this.fetchPaginatedUrls(page, pageUrlWithGran, { separatePages: true });
        if (paginatedPages.length === 0) continue;

        anyPagesSaved = true;
        const baseFilename = this.buildSuggestedFilename(pageUrlWithGran);
        // 财务报表页面的 buildSuggestedFilename 已包含粒度后缀（_quarter/_yearly），/m 页面需要手动添加
        const granSuffix = (gran !== null && path.endsWith('/m')) ? `_${granularityNames[gran]}` : '';

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
          const pageUrlObj = new URL(pageUrlWithGran);
          pageUrlObj.searchParams.set('page-index', String(pageIndex));
          const pageUrl = pageUrlObj.toString();
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
            console.log(`  [FinanceParser] 已保存分页文件: ${uniqueFilename}`);
          } else {
            fs.writeFileSync(filepath, markdown, 'utf-8');
            console.log(`  [FinanceParser] 已保存分页文件: ${filename}`);
          }
        }
      }

      if (anyPagesSaved) {
        context.data.skipDefaultMarkdownOutput = true;
        context.data.suggestedFilename = this.buildSuggestedFilename(url);
        return this.formatResult(context.data, url);
      }
    }

    // 非分页场景：委托给父类处理
    return super.parse(page, url, options);
  }

  /**
   * 通过 URL page-index 参数遍历所有分页数据
   * 理杏仁某些页面通过 page-index=0,1,2,3... 分页，需要直接构造 URL 访问
   */
  async fetchPaginatedUrls(page, baseUrl, options = {}) {
    const { separatePages = false } = options;
    const accumulatedData = [];
    const pagesData = [];

    try {
      const urlObj = new URL(baseUrl);
      const path = urlObj.pathname;

      const paginatedPaths = ['/bs', '/ps', '/cfs', '/is', '/m'];
      const isPaginatedPage = paginatedPaths.some(p => path.endsWith(p));
      const isFinancialStatement = ['/bs', '/ps', '/cfs'].some(p => path.endsWith(p));
      if (!isPaginatedPage) return separatePages ? pagesData : accumulatedData;

      console.log(`  [FinanceParser] 开始 URL 分页遍历...`);

      const buildUrl = (pageIndex) => {
        const u = new URL(baseUrl);
        u.searchParams.set('page-index', String(pageIndex));
        if (isFinancialStatement) {
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

        const expectedGranularity = new URL(pageUrl).searchParams.get('granularity') || 'q';
        const currentGranularity = new URL(currentUrl).searchParams.get('granularity') || 'q';
        const needsNavigation = !currentUrl.includes(`page-index=${pageIndex}`) || currentGranularity !== expectedGranularity;

        if (needsNavigation) {
          console.log(`  [FinanceParser] 导航到 page-index=${pageIndex} granularity=${expectedGranularity}...`);
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.waitForLixingerContent(page);
          await page.waitForTimeout(1500);
        }

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
          const filteredTables = [];
          for (const pt of pageTables) {
            if (pt.headers[0]?.includes('PE-TTM') || pt.headers[0]?.includes('贵州茅台 沪股通')) continue;
            if (pt.headers.length <= 1 && pt.rows.length === 0) continue;

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

          let hasNewData = false;
          if (filteredTables.length > 0) {
            if (pagesData.length === 0) {
              hasNewData = true;
            } else {
              const lastPage = pagesData[pagesData.length - 1];
              for (const table of filteredTables) {
                const lastTable = lastPage.tables.find(t => t.index === table.index);
                if (!lastTable) {
                  hasNewData = true;
                  break;
                }
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
            console.log(`  [FinanceParser] page-index=${pageIndex} 独立页面，${filteredTables.length} 个表格`);
          } else {
            emptyCount++;
            console.log(`  [FinanceParser] page-index=${pageIndex} 无新数据 (${emptyCount}/${maxEmpty})`);
          }
        } else {
          let totalNewCols = 0;
          for (const pt of pageTables) {
            if (pt.headers[0]?.includes('PE-TTM') || pt.headers[0]?.includes('贵州茅台 沪股通')) continue;
            if (pt.headers.length <= 2 && pt.rows.length === 0) continue;

            const filteredRows = pt.rows.filter(r => !this.isSubHeaderRow(r));

            let existing = accumulatedData.find(t => t.index === pt.index);
            if (!existing) {
              existing = {
                index: pt.index,
                headers: [...pt.headers],
                rows: filteredRows.map(r => [...r]),
                caption: ''
              };
              accumulatedData.push(existing);
              totalNewCols += pt.headers.length > 0 ? pt.headers.length - 1 : 0;
            } else {
              const labelHeader = existing.headers[0];
              const existingDataHeaders = existing.headers.slice(1);
              const newDataHeaders = pt.headers.slice(1);

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

              const newRowsMap = new Map();
              for (const row of pt.rows) {
                newRowsMap.set(row[0], row.slice(1));
              }

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
                  for (const h of addedHeaders) {
                    existingRow.push('');
                  }
                }
              }

              for (const [label, newValues] of newRowsMap) {
                const row = [label];
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
            console.log(`  [FinanceParser] page-index=${pageIndex} 无新列 (${emptyCount}/${maxEmpty})`);
          } else {
            emptyCount = 0;
            console.log(`  [FinanceParser] page-index=${pageIndex} 新增 ${totalNewCols} 列`);
          }
        }

        pageIndex++;
      }

      const currentUrl = page.url();
      if (!currentUrl.startsWith(baseUrl.split('?')[0])) {
        console.log(`  [FinanceParser] 导航回原始页面...`);
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.waitForLixingerContent(page);
      }

      if (separatePages) {
        console.log(`  [FinanceParser] URL 分页遍历完成，共 ${pagesData.length} 个独立页面`);
        return pagesData;
      }

      console.log(`  [FinanceParser] URL 分页遍历完成，共检查 ${pageIndex} 页，累积 ${accumulatedData.length} 个表格`);
    } catch (error) {
      console.log(`  [FinanceParser] URL 分页遍历结束: ${error.message}`);
    }

    return separatePages ? pagesData : accumulatedData;
  }

  /**
   * 通过 UI 点击"下一页"遍历分页数据
   * 用于 /m (财务指标) 等使用 JavaScript 分页而非 URL page-index 的页面
   */
  async fetchPaginatedUrlsByUIClick(page, baseUrl) {
    const pagesData = [];
    try {
      const currentUrl = page.url();
      const expectedGranularity = new URL(baseUrl).searchParams.get('granularity') || 'q';
      const currentGranularity = new URL(currentUrl).searchParams.get('granularity') || 'q';
      const needsNavigation = !currentUrl.startsWith(baseUrl.split('?')[0]) || currentGranularity !== expectedGranularity;
      if (needsNavigation) {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.waitForLixingerContent(page);
        await page.waitForTimeout(1500);
      }

      let pageIndex = 0;
      const maxPages = 100;

      while (pageIndex < maxPages) {
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

        const filteredTables = [];
        for (const pt of pageTables) {
          if (pt.headers[0]?.includes('PE-TTM') || pt.headers[0]?.includes('贵州茅台 沪股通')) continue;
          if (pt.headers.length <= 1 && pt.rows.length === 0) continue;

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

        let hasNewData = false;
        if (filteredTables.length > 0) {
          if (pagesData.length === 0) {
            hasNewData = true;
          } else {
            const lastPage = pagesData[pagesData.length - 1];
            for (const table of filteredTables) {
              const lastTable = lastPage.tables.find(t => t.index === table.index);
              if (!lastTable) {
                hasNewData = true;
                break;
              }
              const currentDataHeaders = table.headers.slice(1).join(',');
              const lastDataHeaders = lastTable.headers.slice(1).join(',');
              if (currentDataHeaders !== lastDataHeaders) {
                hasNewData = true;
                break;
              }
            }
          }
        }

        if (!hasNewData) {
          console.log(`  [FinanceParser] UI分页 page=${pageIndex} 无新数据，停止`);
          break;
        }

        pagesData.push({ pageIndex, tables: filteredTables });
        console.log(`  [FinanceParser] UI分页 page=${pageIndex}, ${filteredTables.length} 个表格`);

        const nextBtn = page.locator('text=下一页').first();
        const count = await nextBtn.count();
        if (count === 0) {
          console.log(`  [FinanceParser] UI分页 未找到下一页按钮，停止`);
          break;
        }

        const isDisabled = await nextBtn.evaluate(el => {
          return el.disabled || el.classList.contains('disabled') ||
                 el.classList.contains('el-pagination--disabled') ||
                 el.getAttribute('aria-disabled') === 'true';
        }).catch(() => false);

        if (isDisabled) {
          console.log(`  [FinanceParser] UI分页 下一页已禁用，停止`);
          break;
        }

        await nextBtn.click();
        console.log(`  [FinanceParser] UI分页 点击下一页...`);
        await page.waitForTimeout(2000);
        await this.waitForLixingerContent(page);

        pageIndex++;
      }

      console.log(`  [FinanceParser] UI分页完成，共 ${pagesData.length} 页`);
    } catch (error) {
      console.log(`  [FinanceParser] UI分页结束: ${error.message}`);
    }

    return pagesData;
  }

  /**
   * 判断表格是否为财务报表数据（资产负债表/利润表/现金流量表）
   */
  isFinancialTable(table) {
    if (!table || !table.headers || table.rows.length === 0) return false;

    const headerText = table.headers.join(' ');

    const hasYearHeader = table.headers.some(h =>
      /^\s*20\d{2}\s*$/.test(String(h)) ||
      /^\s*20\d{2}Q[1-4]\s*$/.test(String(h)) ||
      /^\s*\d{4}-\d{2}\s*$/.test(String(h)) ||
      /^\s*Q[1-4]\s*$/.test(String(h))
    );
    if (hasYearHeader) return true;

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

    const isApiRawData = table.source === 'api' ||
      table.headers.some(h => /^(stockId|date|ownerType|dataType|q\.bs\.|q\.is\.|q\.cf\.)/.test(String(h)));
    if (isApiRawData) return false;

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

    const subHeaderTerms = ['Q1', 'Q2', 'Q3', 'Q4', '原值', '同比', '环比', '当期', '累计', '单季', '年比'];
    const isSubHeaderOnly = table.rows.length > 0 && table.rows.every(row => {
      const nonEmptyCells = row.filter(c => c && c.trim() !== '');
      if (nonEmptyCells.length === 0) return true;
      return nonEmptyCells.every(c => subHeaderTerms.includes(c.trim()));
    });
    if (isSubHeaderOnly) return false;

    if (table.headers.length === 1 && table.headers[0].includes('默认单位')) return false;

    const hasFinancialTerm = financialTerms.some(term => allText.includes(term));
    const hasYearOrQuarter = /\b20\d{2}\b/.test(allText) || /\bQ[1-4]\b/.test(allText);
    const isLargeTable = table.rows.length > 30;

    return hasFinancialTerm || hasYearOrQuarter || isLargeTable;
  }

  /**
   * 判断一行是否仅为季度/指标子标题行
   */
  isSubHeaderRow(row) {
    if (!row || row.length === 0) return true;
    const subHeaderTerms = ['Q1', 'Q2', 'Q3', 'Q4', '原值', '同比', '环比', '当期', '累计', '单季', '年比'];
    const nonEmptyCells = row.filter(c => c && c.trim() !== '');
    if (nonEmptyCells.length === 0) return true;
    return nonEmptyCells.every(c => subHeaderTerms.includes(c.trim()));
  }

  /**
   * 根据 URL 生成建议文件名，包含粒度标识（yearly/quarter/half_year）
   */
  buildSuggestedFilename(url) {
    try {
      const u = new URL(url);
      const path = u.pathname;

      const pathMap = {
        '/bs': '资产负债表',
        '/ps': '利润表',
        '/cfs': '现金流量表',
        '/is': '行业统计'
      };
      let reportType = '';
      const isFundamentalPage = path.includes('/fundamental/');
      if (!isFundamentalPage) {
        for (const [key, value] of Object.entries(pathMap)) {
          if (path.endsWith(key)) {
            reportType = value;
            break;
          }
        }
      }

      const stockMatch = path.match(/\/(sh|sz)\/(\d+)/);
      const stockCode = stockMatch ? stockMatch[2] : '';

      if (reportType) {
        const granularity = u.searchParams.get('granularity') || 'q';
        const granularitySuffix = { y: 'yearly', q: 'quarter', h: 'half_year' }[granularity] || 'quarter';
        return `${stockCode}_${reportType}_${granularitySuffix}`;
      }

      if (path.endsWith('/m')) {
        return `${stockCode}_matrix`;
      }

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
   * 格式化结果 — 覆盖以添加财务报表过滤
   */
  formatResult(data, url) {
    const isFinancialStatementPage = /\/(bs|ps|cfs|cashflow|income)\b/.test(url);
    if (!isFinancialStatementPage) {
      const result = super.formatResult(data, url);
      result.skipDefaultMarkdownOutput = data.skipDefaultMarkdownOutput;
      return result;
    }

    let allTables = data.tables || [];

    // 0. 过滤只有 1 列的表格
    allTables = allTables.filter(t => t.headers && t.headers.length > 1);

    // 1. 去重
    const seen = new Set();
    allTables = allTables.filter(t => {
      const sig = this.tableSignature(t);
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });

    // 2. 跳过公司概况表格
    allTables = allTables.filter(t => !this.isCompanyOverviewTable(t));

    // 3. 跳过零散指标表格
    allTables = allTables.filter(t => {
      if (t.source === 'metric-section') return false;
      if (t.headers?.length === 2 && t.headers[0] === '指标' && t.headers[1] === '数值' && t.rows?.length <= 50) {
        const allText = t.rows.flat().join(' ');
        const isMetricFragment = !allText.includes('资产') && !allText.includes('负债')
          && !allText.includes('收入') && !allText.includes('现金')
          && !allText.includes('利润') && !allText.includes('成本');
        if (isMetricFragment) return false;
      }
      return true;
    });

    // 4. 过滤 API 原始数据表格
    allTables = allTables.filter(t => {
      if (t.source === 'api') return false;
      if (t.source !== 'api-data') {
        const apiFieldPatterns = [
          /^(stockId|ownerType|dataType|sp|candlestick\.|stock\.|q\.bs\.|q\.is\.|q\.cf\.)/,
          /^[a-f0-9]{24}$/,
        ];
        const hasApiFieldHeader = t.headers.some(h => apiFieldPatterns.some(p => p.test(String(h))));
        if (hasApiFieldHeader) return false;
      }
      if (t.source !== 'fs-metrics' && t.source !== 'pledge-api' && t.source !== 'price-metrics' && t.source !== 'api-data' && t.source !== 'margin-trading-api') {
        const allText = [...t.headers, ...t.rows.flat()].join(' ');
        const isMostlyCodes = allText.split(/\s+/).filter(w => w.length > 0).length > 0 &&
          allText.split(/\s+/).filter(w => /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(w) || w === 'true' || w === 'false' || /^[a-f0-9]{24}$/.test(w)).length /
          allText.split(/\s+/).filter(w => w.length > 0).length > 0.7;
        if (isMostlyCodes && t.headers.length > 5) return false;
      }
      return true;
    });

    // 5. 排除股票对比/列表表格
    allTables = allTables.filter(t => {
      const headerText = t.headers.join(' ');
      if (/公司名称\(\d+\)/.test(headerText)) return false;
      if (t.headers.includes('#') && t.headers.includes('PE-TTM') && t.headers.includes('PB')) return false;
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

    // 6. 排除空表格
    allTables = allTables.filter(t => {
      if (t.rows.length === 0) return false;
      if (t.headers.length === 1 && t.headers[0] === '#') return false;
      return true;
    });

    // 7. 财务报表页面：只保留财务表格
    const financialTables = allTables.filter(t => this.isFinancialTable(t));
    const financialMainContent = (data.mainContent || [])
      .filter(item => item.type === 'table')
      .filter(item => this.isFinancialTable(item));

    // 保留页面特有的说明文字
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
      const uiPlaceholderTerms = ['双击修改', '无备注', '点击修改', '请输入', '选择', '全部', '提交反馈', '错误', '改进', '需求'];
      if (uiPlaceholderTerms.some(t => text === t || text.startsWith(t))) return false;
      const usefulPatterns = ['数据来源', '基础数据', '更新', '统计', '说明', '备注', '排名', '占比',
        '累计', '截止', '截至', '来源于', '源自于', '每周', '每月', '每年', '季度', '年度',
        '仅包含', '不包含', '以上数据', '数据范围'];
      return usefulPatterns.some(pattern => text.includes(pattern));
    });

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
      suggestedFilename: this.buildSuggestedFilename(url),
      skipDefaultMarkdownOutput: data.skipDefaultMarkdownOutput
    };
  }
}

export default LixingerFinanceParser;
