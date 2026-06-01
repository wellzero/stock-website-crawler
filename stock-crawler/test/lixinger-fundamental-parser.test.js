import LixingerFundamentalParser, {
  isPriceMetricsList,
  convertPriceMetricsListToTable,
  convertAPIDataToTables
} from '../src/parsers/lixinger-fundamental-parser.js';

describe('LixingerFundamentalParser', () => {
  let parser;

  beforeEach(() => {
    parser = new LixingerFundamentalParser();
  });

  test('should be defined', () => {
    expect(parser).toBeDefined();
  });

  test('should have correct class name', () => {
    expect(parser.constructor.name).toBe('LixingerFundamentalParser');
  });

  test('should match lixinger fundamental URLs', () => {
    expect(parser.matches('https://www.lixinger.com/analytics/company/detail/sh/600519/600519/fundamental/profit')).toBe(true);
    expect(parser.matches('https://www.lixinger.com/analytics/company/detail/sh/600519/600519/fundamental/valuation')).toBe(true);
    expect(parser.matches('https://www.lixinger.com/analytics/company/detail/sh/600519/600519/fundamental/costs')).toBe(true);
  });

  test('should not match non-fundamental URLs', () => {
    expect(parser.matches('https://www.lixinger.com/analytics/company/detail/sh/600519/600519/bs')).toBe(false);
    expect(parser.matches('https://www.lixinger.com/analytics/company/detail/sh/600519/600519/ps')).toBe(false);
    expect(parser.matches('https://www.lixinger.com/analytics/company/detail/sh/600519/600519/m')).toBe(false);
    expect(parser.matches('https://example.com/fundamental/test')).toBe(false);
  });

  test('should have priority higher than LixingerParser', () => {
    expect(parser.getPriority()).toBe(110);
  });

  test('should have default config', () => {
    expect(parser.config.stockId).toBe('600519');
    expect(parser.config.baseUrl).toContain('lixinger.com');
    expect(parser.config.fundamentalBase).toContain('/fundamental');
  });

  test('should accept custom config', () => {
    const customParser = new LixingerFundamentalParser({ stockId: '000001' });
    expect(customParser.config.stockId).toBe('000001');
  });

  test('should build filename from URL', () => {
    const url = 'https://www.lixinger.com/analytics/company/detail/sh/600519/600519/fundamental/costs';
    expect(parser.buildFilename(url)).toBe('600519_fundamental_costs');
  });

  test('should build filename from valuation URL', () => {
    const url = 'https://www.lixinger.com/analytics/company/detail/sh/600519/600519/fundamental/valuation/primary';
    expect(parser.buildFilename(url)).toBe('600519_fundamental_valuation_primary');
  });
});

describe('isPriceMetricsList', () => {
  test('should return true for price metrics data', () => {
    const data = [
      { stockId: '600519', date: '2024-01-15', d_pe_ttm: 30.5, pb_wo_gw: 8.2 }
    ];
    expect(isPriceMetricsList(data)).toBe(true);
  });

  test('should return true for data with ps_ttm', () => {
    const data = [
      { stockId: '600519', date: '2024-01-15', ps_ttm: 15.3 }
    ];
    expect(isPriceMetricsList(data)).toBe(true);
  });

  test('should return false for non-price metrics data', () => {
    const data = [
      { stockId: '600519', date: '2024-01-15', revenue: 100 }
    ];
    expect(isPriceMetricsList(data)).toBe(false);
  });

  test('should return false for empty array', () => {
    expect(isPriceMetricsList([])).toBe(false);
  });
});

describe('convertPriceMetricsListToTable', () => {
  test('should extract value from { value: ... } wrapper objects', () => {
    const data = [
      { stockId: '600519', date: '2024-01-15', d_pe_ttm: { value: 30.5, u: 35, m: 30, l: 25 } },
      { stockId: '600519', date: '2024-02-15', d_pe_ttm: { value: 31.2, u: 36, m: 31, l: 26 } }
    ];
    const result = convertPriceMetricsListToTable(data, 'test');
    expect(result).not.toBeNull();
    expect(result.caption).toBe('估值指标');
    expect(result.rows[0][0]).toBe('PE-TTM(扣非)');
    expect(result.rows[0][1]).toBe('30.50');
    expect(result.rows[0][2]).toBe('31.20');
  });

  test('should handle plain numeric values', () => {
    const data = [
      { stockId: '600519', date: '2024-01-15', pe_ttm: 28.5 },
      { stockId: '600519', date: '2024-02-15', pe_ttm: 29.0 }
    ];
    const result = convertPriceMetricsListToTable(data, 'test');
    expect(result).not.toBeNull();
    expect(result.rows[0][1]).toBe('28.50');
    expect(result.rows[0][2]).toBe('29.00');
  });

  test('should convert dyr to percentage', () => {
    const data = [
      { stockId: '600519', date: '2024-01-15', dyr: 0.0153 }
    ];
    const result = convertPriceMetricsListToTable(data, 'test');
    expect(result.rows[0][1]).toBe('1.53%');
  });

  test('should sample monthly data', () => {
    const data = [];
    for (let i = 0; i < 5; i++) {
      data.push({
        stockId: '600519',
        date: `2024-01-${String(10 + i).padStart(2, '0')}`,
        d_pe_ttm: 30 + i
      });
    }
    const result = convertPriceMetricsListToTable(data, 'test');
    expect(result).not.toBeNull();
    // 同一月份只应保留一个数据点
    expect(result.headers.length).toBe(2); // '指标' + 1个月份
  });
});

describe('convertAPIDataToTables with price metrics', () => {
  test('should route priceMetricsList to convertPriceMetricsListToTable', () => {
    const apiDataList = [{
      url: 'https://www.lixinger.com/price-metrics/get-price-metrics-chart-info',
      field: 'priceMetricsList',
      data: [
        { stockId: '600519', date: '2024-01-15', d_pe_ttm: { value: 30.5, u: 35, m: 30, l: 25 } },
        { stockId: '600519', date: '2024-02-15', d_pe_ttm: { value: 31.2, u: 36, m: 31, l: 26 } }
      ]
    }];
    const tables = convertAPIDataToTables(apiDataList);
    expect(tables.length).toBe(1);
    expect(tables[0].caption).toBe('估值指标');
    expect(tables[0].rows[0][0]).toBe('PE-TTM(扣非)');
    expect(tables[0].rows[0][1]).toBe('30.50');
  });

  test('should not produce [object Object] for value wrappers in generic data', () => {
    const apiDataList = [{
      url: 'https://www.lixinger.com/api/test',
      field: 'other',
      data: [
        { date: '2024-01-15', metric: { value: 42.5, extra: 'ignored' }, name: 'test' }
      ]
    }];
    const tables = convertAPIDataToTables(apiDataList);
    expect(tables.length).toBe(1);
    const metricRow = tables[0].rows.find(r => r[0] === 'metric');
    expect(metricRow).toBeDefined();
    expect(metricRow[1]).toBe('42.50');
    expect(metricRow[1]).not.toContain('[object Object]');
  });
});
