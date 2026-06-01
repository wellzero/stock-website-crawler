import LixingerFinanceParser from '../src/parsers/lixinger-finance-parser.js';

describe('LixingerFinanceParser', () => {
  let parser;

  beforeEach(() => {
    parser = new LixingerFinanceParser();
  });

  test('should be defined', () => {
    expect(parser).toBeDefined();
  });

  test('should have correct class name', () => {
    expect(parser.constructor.name).toBe('LixingerFinanceParser');
  });

  test('should match finance URLs', () => {
    expect(parser.matches('https://www.lixinger.com/analytics/company/detail/sh/600519/600519/bs')).toBe(true);
    expect(parser.matches('https://www.lixinger.com/analytics/company/detail/sh/600519/600519/ps')).toBe(true);
    expect(parser.matches('https://www.lixinger.com/analytics/company/detail/sh/600519/600519/cfs')).toBe(true);
    expect(parser.matches('https://www.lixinger.com/analytics/company/detail/sh/600519/600519/m')).toBe(true);
    expect(parser.matches('https://www.lixinger.com/analytics/company/detail/sh/600519/600519/operation-revenue-constitution')).toBe(true);
  });

  test('should not match non-finance URLs', () => {
    expect(parser.matches('https://www.lixinger.com/analytics/company/detail/sh/600519/600519/fundamental/profit')).toBe(false);
    expect(parser.matches('https://www.lixinger.com/analytics/company/detail/sh/600519/600519/capital-flow')).toBe(false);
    expect(parser.matches('https://www.lixinger.com/analytics/company/detail/sh/600519/600519/employee')).toBe(false);
    expect(parser.matches('https://example.com/bs/test')).toBe(false);
  });

  test('should have priority higher than LixingerParser', () => {
    expect(parser.getPriority()).toBe(105);
  });
});
