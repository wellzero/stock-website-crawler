#!/usr/bin/env node

/**
 * Lixinger Fundamental Pages Parser
 * 专门用于解析 https://www.lixinger.com/analytics/company/detail/sh/600519/600519/fundamental 下的所有页面
 *
 * 两种使用方式：
 * 1. 被 lixinger-parser.js 调用：await new LixingerFundamentalParser().parse(page, url, options)
 * 2. 独立运行：node src/parsers/lixinger-fundamental-parser.js
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// ── 指标名称映射 ──
const METRIC_NAMES = {
  // Profit Statement
  'ps.toi': '营业总收入', 'ps.toc': '营业总成本', 'ps.gp': '毛利润',
  'ps.op': '营业利润', 'ps.np': '净利润', 'ps.npadnrpatoshaopc': '扣非净利润',
  'ps.gp_m': '毛利率', 'ps.op_m': '营业利润率', 'ps.np_m': '净利润率',
  'ps.np_s_r': '销售净利率', 'ps.npadnrpatoshaopc_npatoshopc_r': '扣非净利润占比',
  'ps.wdroe': '扣非加权ROE', 'ps.ebit': 'EBIT', 'ps.ebitda': 'EBITDA',
  'ps.da': '折旧摊销', 'ps.ie': '利息支出', 'ps.oe': '营业外收支',
  'ps.se_r': '销售费用率', 'ps.mae_r': '管理费用率',
  'ps.ae_r': '管理费用率', 'ps.oe_r': '营业费用率',
  'ps.ir_r': '所得税率', 'ps.fi_r': '财务费用率',
  'ps.fe_r': '财务费用率', 'ps.rd_r': '研发费用率',
  'ps.te_r': '税金及附加率', 'ps.ac_r': '资产减值损失率',
  'ps.cp_r': '营业成本率', 'ps.foe_r': '四费比率',
  'ps.ite_tp_r': '所得税/利润总额',
  'ps.op_m_adj': '调整后营业利润率', 'ps.op_m_r': '营业利润率(扣除)',
  'ps.beps': '基本每股收益', 'ps.cp': '资本支出',
  'ps.npatoshopc': '归母净利润', 'ps.oi': '营业收入',

  // Balance Sheet - Assets
  'bs.ta': '总资产', 'bs.tl': '总负债', 'bs.te': '股东权益',
  'bs.ca': '流动资产', 'bs.cl': '流动负债', 'bs.nca': '非流动资产',
  'bs.ncl': '非流动负债', 'bs.fa': '固定资产', 'bs.ia': '无形资产',
  'bs.ar': '应收账款', 'bs.inv': '存货', 'bs.ltbor': '长期借款',
  'bs.ahfs': '持有待售资产', 'bs.ats': '应收账款',
  'bs.cabb': '货币资金', 'bs.cdfa': '交易性金融资产',
  'bs.cip': '在建工程', 'bs.cri': '合同资产',
  'bs.dita': '递延所得税资产', 'bs.fahursa': '固定资产',
  'bs.gw': '商誉', 'bs.i': '存货',
  'bs.ltar': '长期应收款', 'bs.ltei': '长期股权投资',
  'bs.ltpe': '长期待摊费用', 'bs.ncadwioy': '一年内到期的非流动资产',
  'bs.ncafsfa': '发放贷款及垫款', 'bs.nclaatc': '非流动资产合计',
  'bs.nraar': '应收票据及应收账款', 'bs.oaga': '其他应收款',
  'bs.oca': '其他流动资产', 'bs.ocri': '其他债权投资',
  'bs.oeii': '其他权益工具投资', 'bs.onca': '其他非流动资产',
  'bs.oncfa': '其他非流动金融资产', 'bs.or': '其他',
  'bs.pba': '预付款项', 'bs.pe': '预收款项',
  'bs.pwba': '预付账款', 'bs.pwbaofi': '应付债券',
  'bs.rade': '开发支出', 'bs.rei': '其他债权投资',
  'bs.rf': '应收款项融资', 'bs.roua': '使用权资产',
  'bs.tca': '流动资产合计', 'bs.tfa': '交易性金融资产',
  'bs.tnca': '非流动资产合计',

  // Balance Sheet - Liabilities
  'bs.afc': '非流动资产', 'bs.bfcb': '交易性金融负债',
  'bs.bp': '应付票据', 'bs.cal': '流动资产',
  'bs.dfl': '递延收益', 'bs.didwioy': '一年内到期的非流动负债',
  'bs.ditl': '递延所得税负债', 'bs.fasurpa': '专项应付款',
  'bs.lhfs': '持有待售负债', 'bs.ll': '租赁负债',
  'bs.ltap': '长期应付账款', 'bs.ltdi': '长期递延收益',
  'bs.ltl': '长期借款', 'bs.ltpoe': '长期应付职工薪酬',
  'bs.npaap': '应付票据及应付账款', 'bs.ncldwioy': '一年内到期的非流动负债',
  'bs.oap': '其他应付款', 'bs.ocl': '其他流动负债',
  'bs.oncl': '其他非流动负债', 'bs.pfbaofi': '预收款项',
  'bs.psibp': '应付职工薪酬', 'bs.sawp': '短期借款',
  'bs.stbp': '应交税费', 'bs.stl': '短期借款',
  'bs.tcl': '流动负债合计', 'bs.tfl': '非流动负债合计',
  'bs.tncl': '非流动负债合计', 'bs.tp': '总负债',
  'bs.nwc': '营运资本',

  // Custom-chart / Valuation extras
  'bs.d_pe_ttm': '动态PE-TTM', 'bs.dyr': '股息率',
  'bs.ep_stn': '人均薪酬', 'bs.mc': '市值',
  'bs.pb_wo_gw': '扣商誉PB', 'bs.shn': '股东户数',
  'bs.tetoshopc': '归母股东权益', 'bs.tl_ta_r': '资产负债率',
  'bs.toe': '总股东权益',

  // Cashflow
  'cfs.ncf': '净现金流', 'cfs.ocf': '经营现金流',
  'cfs.icf': '投资现金流', 'cfs.fcf': '自由现金流',
  'cfs.ocf_ps': '每股经营现金流',
  'cfs.ncfffa': '筹资活动现金流净额',
  'cfs.ncffia': '投资活动现金流净额',
  'cfs.ncffoa': '经营活动现金流净额',

  // Ratios - Profitability
  'm.wroe': '加权ROE', 'm.roe': 'ROE',
  'm.roe_atoshaopc': 'ROE(归属母公司)',
  'm.roe_adnrpatoshaopc': '扣非ROE', 'm.roa': 'ROA',
  'm.roic': 'ROIC', 'm.roc': '投入资本回报率',
  'm.ta_to': '总资产周转率', 'm.l': '权益乘数',
  'm.gp_m': '毛利率', 'm.np_s_r': '净利润率',

  // Ratios - Cashflow
  'm.crfscapls_oi_r': '销售收现率',
  'm.crfscapls_ta_r': '总资产现金回收率',
  'm.fcf': '自由现金流',
  'm.ncffoa_fa_r': '经营现金流/固定资产比率',
  'm.ncffoa_np_r': '经营现金流/净利润比率',
  'm.ncffoa_op_r': '经营现金流/营业利润比率',

  // Ratios - Safety
  'm.cabb_tcl_r': '现金比率', 'm.c_r': '流动比率',
  'm.lv_r': '产权比率', 'm.lwi_ta_r': '有息负债率',
  'm.q_r': '速动比率', 'm.tl_ta_r': '资产负债率',

  // Ratios - Operation Capability (turnover days)
  'm.afc_ds': '固定资产周转天数(均)',
  'm.ap_ds': '应付账款周转天数',
  'm.ar_ds': '应收账款周转天数',
  'm.ats_ds': '总资产周转天数',
  'm.ca_ds': '流动资产周转天数',
  'm.cl_ds': '流动负债周转天数',
  'm.fa_ds': '固定资产周转天数',
  'm.i_ds': '存货周转天数',
  'm.m_ds': '营业周期',
  'm.npaap_ds': '应付票据及应付账款周转天数',
  'm.np_ds': '现金周转周期',
  'm.nraar_ds': '应收票据及应收账款周转天数',
  'm.nr_ds': '净营业周期',
  'm.rf_ds': '应收款项融资周转天数',

  // Per-capita
  'm.ep_stn': '人均薪酬', 'm.np_pc': '人均净利润',
  'm.s_pc': '人均营业收入', 'm.toi_pc': '人均营业总收入'
};

const CALC_TYPE_NAMES = {
  't': '累计', 't_y2y': '累计同比', 't_c2c': '累计环比',
  'c': '单季', 'c_y2y': '单季同比', 'c_c2c': '单季环比',
  'c_2y': '单季年比', 'ttm': 'TTM', 'ttm_y2y': 'TTM同比',
  'ttm_c2c': 'TTM环比', 't_o': '累计(原值)', 'c_o': '单季(原值)',
  'ttm_o': 'TTM(原值)', 't_r': '累计(比率)', 'c_r': '单季(比率)'
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isSubHeaderRow(row) {
  if (!row || row.length === 0) return true;
  const subHeaderTerms = ['Q1', 'Q2', 'Q3', 'Q4', '原值', '同比', '环比', '当期', '累计', '单季', '年比'];
  const nonEmptyCells = row.filter(c => c && c.trim() !== '');
  if (nonEmptyCells.length === 0) return true;
  return nonEmptyCells.every(c => subHeaderTerms.includes(c.trim()));
}

function isCompanyOverviewTable(table) {
  if (!table || !table.headers) return false;
  if (table.source === 'fs-metrics' || table.source === 'price-metrics' || table.source === 'api-data') return false;
  if (table.rows.length > 15) return false;
  const hasManyDateColumns = table.headers.some(h =>
    /^\d{4}-\d{2}$/.test(String(h)) || /^20\d{2}Q[1-4]$/.test(String(h)) || /^20\d{2}$/.test(String(h))
  );
  if (hasManyDateColumns && table.headers.length > 10) return false;
  const allText = [...table.headers, ...table.rows.flat()].join(' ');
  const overviewPatterns = [
    /PE-TTM.*PB.*股息率/, /股价.*涨跌幅.*市值/, /所属三级行业.*申万/,
    /所属指数.*纳入纳出/, /最新大宗交易/, /实际控制人/
  ];
  return overviewPatterns.some(p => p.test(allText));
}

function isFsMetricsList(data) {
  if (!Array.isArray(data) || data.length === 0) return false;
  const first = data[0];
  if (first.stockId === undefined || first.date === undefined) return false;
  if (first.q !== undefined && typeof first.q === 'object') return true;
  if (first.y !== undefined && typeof first.y === 'object') return true;
  if (first.metrics?.mcw?.q !== undefined || first.metrics?.mcw?.y !== undefined) return true;
  return false;
}

function convertFsMetricsListToTable(data) {
  try {
    const getFsData = (d) => d.q || d.y || d.metrics?.mcw?.q || d.metrics?.mcw?.y || {};

    const allMetrics = new Set();
    const allCalcTypes = new Set();
    for (const d of data) {
      for (const [cat, metrics] of Object.entries(getFsData(d))) {
        for (const [metric, values] of Object.entries(metrics)) {
          allMetrics.add(`${cat}.${metric}`);
          for (const calcType of Object.keys(values)) {
            if (calcType !== '_id') allCalcTypes.add(calcType);
          }
        }
      }
    }

    if (allMetrics.size === 0) return null;

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
      if (uniqueData.length >= 100) break;
    }

    const dates = uniqueData.map(d => {
      const date = new Date(d.date);
      const year = date.getFullYear();
      const quarter = Math.ceil((date.getMonth() + 1) / 3);
      return `${year}Q${quarter}`;
    });

    const rows = [];
    const sortedMetrics = Array.from(allMetrics).sort();
    const sortedCalcTypes = ['t', 't_y2y', 't_c2c', 'c', 'c_y2y', 'c_c2c', 'c_2y', 'ttm', 'ttm_y2y', 'ttm_c2c', 't_o', 'c_o', 'ttm_o', 't_r', 'c_r']
      .filter(ct => allCalcTypes.has(ct));

    for (const key of sortedMetrics) {
      const [category, metric] = key.split('.');
      const baseName = METRIC_NAMES[key] || key;

      for (const calcType of sortedCalcTypes) {
        const calcName = CALC_TYPE_NAMES[calcType] || calcType;
        const values = uniqueData.map(d => {
          const metricObj = getFsData(d)[category]?.[metric];
          if (!metricObj) return '';
          let v = metricObj[calcType];
          if (v === undefined || v === null) return '';
          if (Math.abs(v) <= 1 && v !== 0) return (v * 100).toFixed(2) + '%';
          return Number(v).toFixed(2);
        });

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
 * 判断数据是否为 priceMetricsList 格式
 */
export function isPriceMetricsList(data) {
  if (!Array.isArray(data) || data.length === 0) return false;
  const first = data[0];
  return first.stockId !== undefined && first.date !== undefined &&
    (first.d_pe_ttm !== undefined || first.pb_wo_gw !== undefined || first.ps_ttm !== undefined);
}

/**
 * 将 priceMetricsList 转换为人类可读的表格
 * 采样为月度数据点，避免 500+ 行日报表过于庞大
 */
export function convertPriceMetricsListToTable(data, url) {
  try {
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

    const valueKeys = Object.keys(metricNames).filter(k =>
      data.some(d => {
        const v = d[k];
        if (v === undefined || v === null) return false;
        if (typeof v === 'object') return v.value !== undefined && v.value !== null;
        return true;
      })
    );
    if (valueKeys.length === 0) return null;

    const sortedData = [...data].sort((a, b) => new Date(b.date) - new Date(a.date));

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
        const v = typeof raw === 'object' && raw.value !== undefined ? raw.value : raw;
        if (v === undefined || v === null || Number.isNaN(v)) return '';
        if (key === 'dyr') return (v * 100).toFixed(2) + '%';
        if (key === 'sp' || key === 'lxr_fc_rights') return Number(v).toFixed(2);
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

export function convertAPIDataToTables(apiDataList) {
  const tables = [];
  for (const apiResponse of apiDataList) {
    try {
      const { url, data, field } = apiResponse;
      if (!Array.isArray(data) || data.length === 0) continue;

      if (field === 'fsMetricsList' || isFsMetricsList(data)) {
        const metricTable = convertFsMetricsListToTable(data);
        if (metricTable) tables.push(metricTable);
        continue;
      }

      if (field === 'priceMetricsList' || isPriceMetricsList(data)) {
        const priceTable = convertPriceMetricsListToTable(data, url);
        if (priceTable) tables.push(priceTable);
        continue;
      }

      if (data[0]?.date && Object.keys(data[0]).length <= 5) {
        const keys = Object.keys(data[0]).filter(k => k !== 'date' && k !== 'stockId' && k !== '_id');
        if (keys.length > 0) {
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
            if (monthlyData.length >= 300) break;
          }
          monthlyData.reverse();
          const dates = monthlyData.map(d => {
            const date = new Date(d.date);
            return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          });
          const rows = [];
          for (const key of keys) {
            const values = monthlyData.map(d => {
              let v = d[key];
              if (v === undefined || v === null) return '';
              // 处理 { value: number } wrapper 对象
              if (v && typeof v === 'object' && v.value !== undefined) {
                v = v.value;
              }
              if (typeof v === 'number') return v.toFixed(2);
              return String(v);
            });
            rows.push([key, ...values]);
          }
          tables.push({ index: tables.length, headers: ['指标', ...dates], rows, caption: '时间序列数据', source: 'api-data' });
        }
        continue;
      }

      const flattenObj = (obj, prefix = '') => {
        const result = {};
        for (const [k, v] of Object.entries(obj)) {
          const newKey = prefix ? `${prefix}.${k}` : k;
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            // 处理 { value: number, u: ..., m: ..., l: ... } 等 wrapper 对象
            const hasValue = v.value !== undefined;
            const isWrapper = Object.keys(v).length === 1 && (v.t !== undefined || v.value !== undefined);
            if (isWrapper) {
              result[newKey] = v.t !== undefined ? v.t : v.value;
            } else if (hasValue && ['number', 'string', 'boolean'].includes(typeof v.value)) {
              // 对象包含 .value 且为原始类型 → 提取 value，跳过其他 keys（如 u/m/l 波段边界）
              result[newKey] = v.value;
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
      const rows = flattenedData.map(item => headers.map(header => {
        const value = item[header];
        if (value === null || value === undefined) return '';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
      }));

      tables.push({
        index: tables.length,
        headers,
        rows,
        caption: `API数据: ${url.split('/').pop().split('?')[0]}`,
        source: 'api-data'
      });
    } catch {
      // ignore
    }
  }
  return tables;
}

class LixingerFundamentalParser {
  /**
   * 匹配 fundamental 页面（供 ParserManager 使用）
   */
  matches(url) {
    return url.includes('lixinger.com') && url.includes('/fundamental/');
  }

  /**
   * 获取优先级（高于 LixingerParser）
   */
  getPriority() {
    return 110;
  }

  constructor(config = {}) {
    this.config = {
      stockId: config.stockId || '600519',
      baseUrl: config.baseUrl || 'https://www.lixinger.com/analytics/company/detail/sh/600519/600519',
      fundamentalBase: config.fundamentalBase || 'https://www.lixinger.com/analytics/company/detail/sh/600519/600519/fundamental',
      username: config.username || '13311390323',
      password: config.password || '3228552',
      loginUrl: config.loginUrl || 'https://www.lixinger.com/open/api/my-apis',
      outputDir: config.outputDir || './output/lixinger-fundmental-parse',
      headless: config.headless !== undefined ? config.headless : true,
      timeout: config.timeout || 30000,
      waitBetweenRequests: config.waitBetweenRequests || 2000,
    };
    this.browser = null;
    this.context = null;
    this.page = null;
    this.apiData = [];
  }

  async launch() {
    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'zh-CN'
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.config.timeout);
    return this;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  async login() {
    const page = this.page;
    console.log('[Login] 导航到登录页...');
    await page.goto(this.config.loginUrl, { waitUntil: 'domcontentloaded', timeout: this.config.timeout });
    await sleep(2000);

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
    await sleep(3000);

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

  async waitForContent(page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const hasRealData = async () => {
      return page.evaluate(() => {
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
        const title = document.title;
        const h1 = document.querySelector('h1');
        const h1Text = h1?.textContent?.trim() || '';
        const isGenericTitle = title === '理杏仁' || title.endsWith(' - 理杏仁') || title.startsWith('理杏仁 -') || h1Text === '理杏仁';
        if (!isGenericTitle && /[一-龥]/.test(title)) {
          const bodyText = document.body?.innerText || '';
          if (bodyText.length > 1000) return true;
        }
        return false;
      });
    };

    for (let i = 0; i < 25; i++) {
      if (await hasRealData()) break;
      await sleep(200);
    }
    await sleep(500);
  }

  async selectMaxTimeRange(page) {
    try {
      const timeRanges = [
        { text: '30 年', years: 30 }, { text: '20 年', years: 20 },
        { text: '10 年', years: 10 }, { text: '5 年', years: 5 },
        { text: '3 年', years: 3 }, { text: '2 年', years: 2 },
        { text: '1 年', years: 1 }, { text: '今年以来', years: 0 }
      ];
      const buttons = await page.locator('.btn-outline-classic, [class*="time-range"], [class*="date-range"]').all();
      if (buttons.length === 0) return;

      const buttonInfos = [];
      for (const btn of buttons) {
        const text = await btn.textContent().catch(() => '');
        const trimmed = text?.trim() || '';
        const matched = timeRanges.find(tr => trimmed.includes(tr.text));
        if (matched) {
          const isActive = await btn.evaluate(el =>
            el.classList.contains('active') || el.classList.contains('is-active') || el.getAttribute('aria-pressed') === 'true'
          ).catch(() => false);
          buttonInfos.push({ btn, text: trimmed, years: matched.years, isActive });
        }
      }

      if (buttonInfos.length === 0) return;
      buttonInfos.sort((a, b) => b.years - a.years);
      const maxBtn = buttonInfos[0];
      if (maxBtn.isActive) return;

      console.log(`  [TimeRange] 点击: ${maxBtn.text}`);
      await maxBtn.btn.click();
      await sleep(3000);
      await this.waitForContent(page);
    } catch {}
  }

  async detectGranularityOptions(page) {
    try {
      const buttons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.btn-outline-classic, [class*="granularity"], [class*="period"]')).map(el => ({
          text: el.textContent?.trim() || '',
          isActive: el.classList.contains('active') || el.classList.contains('is-active')
        }));
      });
      const granularityTexts = ['年', '半年', '季度', '年报数值'];
      const found = buttons.filter(b => granularityTexts.includes(b.text)).map(b => b.text);
      return [...new Set(found)];
    } catch {
      return [];
    }
  }

  async selectGranularityOption(page, text) {
    try {
      const buttons = await page.locator('.btn-outline-classic, [class*="granularity"], [class*="period"]').all();
      for (const btn of buttons) {
        const btnText = await btn.textContent().catch(() => '');
        if (btnText.trim() === text) {
          const isActive = await btn.evaluate(el =>
            el.classList.contains('active') || el.classList.contains('is-active')
          ).catch(() => false);
          if (isActive) return true;
          await btn.click();
          await sleep(2500);
          await this.waitForContent(page);
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async hasUIPagination(page) {
    try {
      const nextBtn = page.locator('text=下一页').first();
      const count = await nextBtn.count();
      if (count === 0) return false;
      const isDisabled = await nextBtn.evaluate(el => {
        return el.disabled || el.classList.contains('disabled') ||
               el.classList.contains('el-pagination--disabled') ||
               el.getAttribute('aria-disabled') === 'true';
      }).catch(() => false);
      return !isDisabled;
    } catch {
      return false;
    }
  }

  async fetchAllUIPages(page) {
    const pagesData = [];
    try {
      let pageIndex = 0;
      const maxPages = 100;

      while (pageIndex < maxPages) {
        const pageTables = await this.extractPageTables(page);

        const filteredTables = [];
        for (const pt of pageTables) {
          if (pt.headers[0]?.includes('PE-TTM') || pt.headers[0]?.includes('贵州茅台 沪股通')) continue;
          if (pt.headers.length <= 1 && pt.rows.length === 0) continue;
          const filteredRows = pt.rows.filter(r => !isSubHeaderRow(r));
          if (pt.headers.length > 0 || filteredRows.length > 0) {
            filteredTables.push({ index: pt.index, headers: [...pt.headers], rows: filteredRows.map(r => [...r]), caption: '' });
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
              if (!lastTable) { hasNewData = true; break; }
              const currentDataHeaders = table.headers.slice(1).join(',');
              const lastDataHeaders = lastTable.headers.slice(1).join(',');
              if (currentDataHeaders !== lastDataHeaders) { hasNewData = true; break; }
            }
          }
        }

        if (!hasNewData) break;

        pagesData.push({ pageIndex, tables: filteredTables });

        const nextBtn = page.locator('text=下一页').first();
        const count = await nextBtn.count();
        if (count === 0) break;
        const isDisabled = await nextBtn.evaluate(el => {
          return el.disabled || el.classList.contains('disabled') ||
                 el.classList.contains('el-pagination--disabled') ||
                 el.getAttribute('aria-disabled') === 'true';
        }).catch(() => false);
        if (isDisabled) break;

        await nextBtn.click();
        await sleep(2000);
        await this.waitForContent(page);
        pageIndex++;
      }
    } catch (error) {
      console.log(`  [Pagination] 结束: ${error.message}`);
    }
    return pagesData;
  }

  async extractPageTables(page) {
    return page.evaluate(() => {
      const results = [];
      document.querySelectorAll('table').forEach((table, idx) => {
        const headers = [];
        table.querySelectorAll('thead th, thead td').forEach(c => headers.push(c.textContent?.trim() || ''));
        if (headers.length === 0) {
          const firstRow = table.querySelector('tr');
          if (firstRow) firstRow.querySelectorAll('th, td').forEach(c => headers.push(c.textContent?.trim() || ''));
        }
        const rows = [];
        const bodyRows = table.querySelectorAll('tbody tr');
        const toProcess = bodyRows.length > 0 ? bodyRows : table.querySelectorAll('tr');
        toProcess.forEach((row, ri) => {
          if (ri === 0 && headers.length > 0 && bodyRows.length === 0) return;
          const cells = Array.from(row.querySelectorAll('td, th'));
          if (cells.length === 0) return;
          const rd = cells.map(c => c.textContent?.trim() || '');
          if (rd.every(c => c === '')) return;
          rows.push(rd);
        });
        if (headers.length > 0 || rows.length > 0) {
          results.push({ index: idx, headers, rows, caption: '' });
        }
      });
      return results;
    });
  }

  async discoverLinks(page) {
    console.log('[Discovery] 导航到 fundamental 页面...');
    await page.goto(this.config.fundamentalBase, { waitUntil: 'domcontentloaded', timeout: this.config.timeout });
    await this.waitForContent(page);
    await sleep(2000);

    await page.evaluate(() => {
      document.querySelectorAll('details').forEach(d => d.open = true);
      document.querySelectorAll('[class*="collapse"], [class*="expand"]').forEach(el => {
        try { el.click(); } catch {}
      });
    });
    await sleep(500);

    const links = await page.evaluate(() => {
      const results = new Set();
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href');
        if (!href) return;
        if (href.includes('/fundamental/') || href.includes('/fundamental"')) {
          let url;
          try {
            url = new URL(href, window.location.href).href;
          } catch {
            return;
          }
          if (/login|logout|register|open\/api\/doc/.test(url)) return;
          results.add(url);
        }
      });
      return Array.from(results);
    });

    const uniqueLinks = [...new Set(links)].sort();

    const knownPages = [
      '/fundamental/valuation',
      '/fundamental/valuation/primary',
      '/fundamental/valuation/other',
      '/fundamental/valuation/band',
      '/fundamental/custom-chart',
      '/fundamental/safety',
      '/fundamental/profit',
      '/fundamental/growth',
      '/fundamental/cashflow',
      '/fundamental/operation-capability',
      '/fundamental/costs',
      '/fundamental/per-capita',
      '/fundamental/asset',
      '/fundamental/debt',
      '/fundamental/surplus-reinvestment-rate',
      '/fundamental/peg',
      '/fundamental/dcf'
    ];

    const allLinks = new Set(uniqueLinks);
    for (const p of knownPages) {
      allLinks.add(`${this.config.baseUrl}${p}`);
    }

    return [...allLinks].sort();
  }

  buildFilename(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(p => p && !/^(sh|sz|bj|analytics|company|detail|\d+)$/.test(p));
      return `${this.config.stockId}_${parts.join('_')}`;
    } catch {
      return `${this.config.stockId}_data`;
    }
  }

  /**
   * 在导航前设置 API 拦截器（供主爬虫调用）
   */
  async beforeLoad(context) {
    const { page } = context;
    this.apiData = [];

    page.on('response', async (response) => {
      const responseUrl = response.url();
      if (!responseUrl.includes('lixinger.com')) return;
      const skipPatterns = [
        '/user/users/', '/user/notifications/', '/site/notifications/',
        '/tracking.', '/api/send', '/page-configs/list-of-indexes',
        '/auth/', '/login', '/logout',
        '/stock-collections', '/stocks/followed', '/stocks/by-ids',
        '/ii/constituents/list',
        '/ugd/settings-groups', '/ugd/custom-fs-metrics/',
        '/fs-metrics/list/date-range',
      ];
      if (skipPatterns.some(p => responseUrl.includes(p))) return;

      try {
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('json')) return;
        const data = await response.json();
        if (data && ((data.code !== undefined && data.code !== 0) || data.error !== undefined)) return;

        if (Array.isArray(data) && data.length >= 5) {
          if (data[0]?.stockType === 'index' && data[0]?.weighting !== undefined) return;
          this.apiData.push({ url: responseUrl, data });
        } else if (data && typeof data === 'object') {
          for (const key of Object.keys(data)) {
            if (['granularities', 'granularity'].includes(key)) continue;
            if (Array.isArray(data[key]) && data[key].length >= 5) {
              if (data[key][0]?.stockType === 'index' && data[key][0]?.weighting !== undefined) continue;
              this.apiData.push({ url: responseUrl, data: data[key], field: key });
            }
          }
        }
      } catch {}
    });
  }

  /**
   * 解析单个 fundamental 页面
   * 供 lixinger-parser.js 调用
   */
  async parse(page, url, options = {}) {
    console.log(`[FundamentalParser] ${url}`);

    // 先设置 API 拦截器（在导航前，确保捕获页面加载时的 API 请求）
    const apiDataList = [...this.apiData];
    const collectApiData = async (response) => {
      const responseUrl = response.url();
      if (!responseUrl.includes('lixinger.com')) return;
      const skipPatterns = [
        '/user/users/', '/user/notifications/', '/site/notifications/',
        '/tracking.', '/api/send', '/page-configs/list-of-indexes',
        '/auth/', '/login', '/logout',
        '/stock-collections', '/stocks/followed', '/stocks/by-ids',
        '/ii/constituents/list',
        '/ugd/settings-groups', '/ugd/custom-fs-metrics/',
        '/fs-metrics/list/date-range',
      ];
      if (skipPatterns.some(p => responseUrl.includes(p))) return;

      try {
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('json')) return;
        const data = await response.json();
        if (data && ((data.code !== undefined && data.code !== 0) || data.error !== undefined)) return;

        if (Array.isArray(data) && data.length >= 5) {
          if (data[0]?.stockType === 'index' && data[0]?.weighting !== undefined) return;
          apiDataList.push({ url: responseUrl, data });
        } else if (data && typeof data === 'object') {
          for (const key of Object.keys(data)) {
            if (['granularities', 'granularity'].includes(key)) continue;
            if (Array.isArray(data[key]) && data[key].length >= 5) {
              if (data[key][0]?.stockType === 'index' && data[key][0]?.weighting !== undefined) continue;
              apiDataList.push({ url: responseUrl, data: data[key], field: key });
            }
          }
        }
      } catch {}
    };
    page.on('response', collectApiData);

    // 如果页面已经在目标 URL（主爬虫已导航），则跳过重复 goto
    const currentUrl = page.url();
    const isAlreadyLoaded = currentUrl && (currentUrl === url || currentUrl.split('?')[0] === url.split('?')[0]);
    if (!isAlreadyLoaded) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.timeout });
    }
    await this.waitForContent(page);
    await sleep(2000);

    await this.selectMaxTimeRange(page);

    await page.evaluate(async () => {
      for (let i = 0; i < 10; i++) {
        window.scrollBy(0, 800);
        await new Promise(r => setTimeout(r, 600));
      }
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 800));
    });
    await sleep(2000);
    await this.waitForContent(page);
    await sleep(3000);

    page.off('response', collectApiData);

    const granularityOptions = await this.detectGranularityOptions(page);
    const hasPagination = await this.hasUIPagination(page);

    const baseFilename = this.buildFilename(url);
    const desiredGranularities = granularityOptions.length > 0
      ? ['年', '季度'].filter(g => granularityOptions.includes(g) || granularityOptions.includes('年报数值'))
      : [null];
    if (granularityOptions.includes('年报数值') && !granularityOptions.includes('年')) {
      desiredGranularities.push('年报数值');
    }

    const granularityNames = { '年': 'yearly', '季度': 'quarter', '年报数值': 'yearly' };

    let anyPagesSaved = false;
    const pagesDir = options.pagesDir;

    for (const gran of desiredGranularities) {
      if (gran !== null) {
        const selected = await this.selectGranularityOption(page, gran);
        if (!selected) continue;
        await sleep(2000);
      }

      const paginatedPages = hasPagination
        ? await this.fetchAllUIPages(page)
        : [{ pageIndex: 0, tables: await this.extractPageTables(page) }];

      const validPages = paginatedPages.map(p => ({
        pageIndex: p.pageIndex,
        tables: p.tables.filter(t => t.headers && t.headers.length > 1 && !isCompanyOverviewTable(t))
      })).filter(p => p.tables.length > 0);

      let apiTables = [];
      if (apiDataList.length > 0) {
        apiTables = convertAPIDataToTables(apiDataList);
      }

      if (validPages.length === 0 && apiTables.length === 0) continue;

      const granSuffix = gran !== null ? `_${granularityNames[gran]}` : '';

      for (const { pageIndex, tables } of validPages) {
        const allTables = [...tables, ...apiTables];
        const sections = [];
        sections.push(`## 源URL\n\n${url}`);
        for (const table of allTables) {
          sections.push('');
          sections.push(`| ${table.headers.join(' | ')} |`);
          sections.push(`| ${table.headers.map(() => '---').join(' | ')} |`);
          for (const row of table.rows) {
            sections.push(`| ${row.join(' | ')} |`);
          }
        }
        const markdown = sections.join('\n');
        const filename = `${baseFilename}${granSuffix}_${pageIndex}.md`;
        if (pagesDir) {
          fs.writeFileSync(path.join(pagesDir, filename), markdown, 'utf-8');
        }
        console.log(`  [Save] ${filename} (${allTables.length} 个表格)`);
        anyPagesSaved = true;
      }

      if (validPages.length === 0 && apiTables.length > 0) {
        const sections = [];
        sections.push(`## 源URL\n\n${url}`);
        for (const table of apiTables) {
          sections.push('');
          sections.push(`| ${table.headers.join(' | ')} |`);
          sections.push(`| ${table.headers.map(() => '---').join(' | ')} |`);
          for (const row of table.rows) {
            sections.push(`| ${row.join(' | ')} |`);
          }
        }
        const markdown = sections.join('\n');
        const filename = `${baseFilename}${granSuffix}_0.md`;
        if (pagesDir) {
          fs.writeFileSync(path.join(pagesDir, filename), markdown, 'utf-8');
        }
        console.log(`  [Save] ${filename} (仅 API 数据)`);
        anyPagesSaved = true;
      }

      if (gran !== null && desiredGranularities.indexOf(gran) < desiredGranularities.length - 1) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.timeout });
        await this.waitForContent(page);
        await sleep(1500);
      }
    }

    // 返回与 lixinger-parser.js 兼容的结果
    return {
      type: 'lixinger',
      url,
      title: '',
      description: '',
      headings: [],
      mainContent: [],
      paragraphs: [],
      lists: [],
      tables: [],
      codeBlocks: [],
      images: [],
      charts: [],
      chartData: [],
      blockquotes: [],
      definitionLists: [],
      horizontalRules: 0,
      videos: [],
      audios: [],
      apiData: apiDataList.length,
      pageFeatures: { suggestedType: 'lixinger', confidence: 100, signals: ['vue-spa', 'fundamental'] },
      tabsAndDropdowns: [],
      dateFilters: [],
      suggestedFilename: baseFilename,
      skipDefaultMarkdownOutput: anyPagesSaved
    };
  }

  /**
   * 独立运行模式：发现所有 fundamental 链接并逐个解析
   */
  async run() {
    console.log('=== Lixinger Fundamental Parser ===\n');

    ensureDir(this.config.outputDir);
    const pagesDir = path.join(this.config.outputDir, 'data');
    ensureDir(pagesDir);

    console.log(`[Output] ${pagesDir}\n`);

    await this.launch();

    const loginSuccess = await this.login();
    if (!loginSuccess) {
      await this.close();
      process.exit(1);
    }

    console.log('\n[Discovery] 发现 fundamental 页面链接...');
    const links = await this.discoverLinks(this.page);
    console.log(`[Discovery] 发现 ${links.length} 个页面:`);
    links.forEach(l => console.log(`  - ${l}`));

    console.log('\n[Parse] 开始解析页面...\n');
    for (let i = 0; i < links.length; i++) {
      const url = links[i];
      console.log(`\n[${i + 1}/${links.length}] ${url}`);
      try {
        await this.parse(this.page, url, { pagesDir });
      } catch (error) {
        console.error(`  [Error] ${error.message}`);
      }
      await sleep(this.config.waitBetweenRequests);
    }

    await this.close();
    console.log(`\n[Done] 所有页面已解析完成，输出目录: ${pagesDir}`);
  }
}

// ── CLI 入口：直接运行时执行 ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const parser = new LixingerFundamentalParser();
  parser.run().catch(err => {
    console.error('[Fatal]', err);
    process.exit(1);
  });
}

export default LixingerFundamentalParser;
