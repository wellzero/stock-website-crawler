# 大盘择时/宏观事件 EVENT INDICATOR 模式分析报告

## 目录
1. [大盘PE标准差偏离度定投](#1-大盘pe标准差偏离度定投)
2. [FED+格雷厄姆指数顶底判断](#2-fed格雷厄姆指数顶底判断)
3. [股债波动平衡](#3-股债波动平衡)
4. [拥挤率择时](#4-拥挤率择时)
5. [牛熊指标（波动率/换手率）](#5-牛熊指标波动率换手率)
6. [MACD/MA5复合熔断择时](#6-macdma5复合熔断择时)
7. [市场宽度（扩散指标）](#7-市场宽度扩散指标)
8. [大盘跌幅择时（别人恐惧我贪婪）](#8-大盘跌幅择时别人恐惧我贪婪)
9. [宏观数据中长线（PMI经济周期）](#9-宏观数据中长线pmi经济周期)
10. [价值投资+大盘择时（RiskControl）](#10-价值投资大盘择时riskcontrol)
11. [RSRS择时+北上资金](#11-rsrs择时北上资金)
12. [市场底部特征综合](#12-市场底部特征综合)
13. [盘中止损策略](#13-盘中止损策略)

---

## 1. 大盘PE标准差偏离度定投

### 来源文件
- `jk2bt-main/strategies/53 基于大盘PE标准差偏离度的聪明基金定投策略.txt`

### 检测代码
```python
def get_pe_mean_and_std(security, start_date, end_date, frequency='1d'):
    df = attribute_history(security, count=400, unit='1d', fields=['close', 'pe_ratio'],
                           skip_paused=True, df=True, fq='pre')
    return np.mean(df['pe_ratio']), np.std(df['pe_ratio'])

g.stdpeH = 1.5   # PE均值+1.5倍标准差，顶部阈值
g.stdpeL = 1.2   # PE均值+1.2倍标准差，底部阈值
```

### 阈值
| 参数 | 值 | 含义 |
|------|-----|------|
| `g.stdpeH` | 1.5 | PE > (均值 + 1.5×std)，市场过热，卖出/减仓 |
| `g.stdpeL` | 1.2 | PE < (均值 + 1.2×std)，市场低估，买入/定投 |

### 决策逻辑
- 当PE偏离度 > 1.5σ → 大幅减仓/买入债券
- 当PE偏离度 < 1.2σ → 加仓/定投沪深300ETF
- 使用沪深300（000300.XSHG）作为基准指数
- 采用定投方式分批买入

### 实现特点
- 使用历史PE的均值和标准差作为衡量当前估值水平的依据
- 不同于绝对PE值，这种相对偏离度的方式适应不同市场环境
- 配合"聪明基金定投"策略，做逆向投资

---

## 2. FED+格雷厄姆指数顶底判断

### 来源文件
- `jk2bt-main/strategies/97 大周期顶底判断：FED指标+格雷厄姆指数一次搞定.ipynb`
- `聚宽有价值策略558/market_sentiment_indicators.py`

### 核心公式
```
FED指标 = (1/PE) - 10年期国债收益率
格雷厄姆指数 = (1/PE) / 10年期国债收益率
```

### 检测代码
```python
# FED指标计算
y = ((100 / last_dataframe['pe']) - last_dataframe['ten_bond']).values

# 格雷厄姆指数计算
pe_ten_bond = (100 / last_dataframe['pe']) / last_dataframe['ten_bond']

# 获取PE（沪深300成分股）
security = get_index_stocks('000300.XSHG', date=csrq)
df = get_valuation(security, start_date=None, end_date=csrq, fields=['pe_ratio'], count=1)
bpe = [df['pe_ratio'].median()]

# 获取10年期国债收益率（从chinabond网站爬取）
def bond_china_yield(start_date, end_date):
    url = "http://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery"
    params = {"startDate": start_date, "endDate": end_date, "gjqx": "10", ...}
    ...
```

### 顶底阈值
| 指标 | 分位阈值 | 含义 |
|------|---------|------|
| FED指标 | 10%分位（-1σ附近） | 底部区域（沪深300低估） |
| FED指标 | 90%分位（+1σ附近） | 顶部区域（沪深300高估） |
| FED指标 | 5%分位 | 极度低估 |
| FED指标 | 95%分位 | 极度高估 |

```python
# 分位计算
fw10 = int(len(y)/10)
top10 = pe_list1[fw10-1]         # 10%下线（底部）
bottom10 = pe_list1[-fw10]       # 10%上线（顶部）
fw20 = int(len(y)/20)
top5 = pe_list1[fw20-1]          # 5%下线（极度低估）
bottom5 = pe_list1[-fw20]        # 5%上线（极度高估）
```

### market_sentiment_indicators.py 中的简化版
```python
# 简化版数据处理（使用3%固定国债收益率近似）
result["bond_yield"] = 3.0
result["fed"] = (100 / result["pe"]) - result["bond_yield"]
result["graham"] = (100 / result["pe"]) / result["bond_yield"]
```

### 决策逻辑
- FED > 90%分位 → 市场高估 → 注意回调风险
- FED < 10%分位 → 市场低估 → 可逐步建仓
- 格雷厄姆指数 > 2.0 → 市场相对债券有吸引力
- 格雷厄姆指数 < 1.0 → 市场相对债券缺乏吸引力

---

## 3. 股债波动平衡

### 来源文件
- `jk2bt-main/strategies/07 股债波动平衡.txt`
- `聚宽有价值策略558/57 别人恐惧我贪婪3——年化20%的股债组合.txt`
- `聚宽有价值策略558/58 ETF动量轮动RSRS与北上择时-股债平衡-盘中止损.txt`

### 核心公式
```
目标仓位 = 权重 / (波动率 ^ 2)
目标仓位 = 目标仓位 / 目标仓位.sum()
```

### 检测代码
```python
# 波动率计算
def get_volatility(df, down=False):
    df['pre'] = df.shift(1)
    df = df.dropna()
    df['day_volatility'] = np.log(df.iloc[:,0] / df['pre'])
    # 3σ 去极值
    vol = df['day_volatility'].std()
    mean = df['day_volatility'].mean()
    df.loc[df.day_volatility > mean + 3*vol, "day_volatility"] = mean + 3*vol
    df.loc[df.day_volatility < mean - 3*vol, "day_volatility"] = mean - 3*vol
    volatility = df['day_volatility'].std() * math.sqrt(250.0) * 100
    return volatility

# 资产配置
stocks = ['161005.XSHE', '163412.XSHE', '511010.XSHG', '513100.XSHG',
          '513500.XSHG', '518880.XSHG', '159928.XSHE', '512010.XSHE']
weights = [15.0, 20.0, 2.0, 15.0, 7.5, 4.0, 25.0, 20.0]

df = history(40, unit='1d', field='close', security_list=stocks, df=True)
for s in stocks:
    waves.append(get_volatility(df[[s]], False))

g.position["position"] = g.position.weight / (g.position.wave ** 2)
g.position.position = g.position.position / g.position.position.sum()
```

### 再平衡阈值
```python
def need_balance(context):
    x = 0.0
    for s in position.index.values:
        p = position.position[s]
        r = p
        if s in context.portfolio.positions.keys():
            r = context.portfolio.positions[s].value / context.portfolio.total_value
        x += abs(r - p)
    return x > 0.05   # 偏离超过5%时再平衡
```

### 决策逻辑
- 每周五检查（`weekday != 5 and len(context.portfolio.positions) > 0: return`）
- 波动率倒数加权：低波动资产配比高，高波动资产配比低
- 偏离>5%触发再平衡

### 别人恐惧我贪婪3——股债组合（57）
```python
# 简化版：只有1个股票ETF + 1个国债ETF
g.pool = ['512100.XSHG']       # 中证1000ETF
g.nationaldabt = ['511010.XSHG']  # 国债ETF

# 触发买入条件：连续两日跌幅超过阈值
if y_cha <= -0.015 and t_cha <= -0.014:
    order_target_value(g.nationaldabt[0], 0)   # 卖出国债
    order_target_value(g.pool[0], cash_value)   # 买入指数

# 20天后自动清仓
if g.day % 20 == 0:
    order_target_value(g.pool[0], 0)            # 卖出指数
    order_target_value(g.nationaldabt[0], cash_value)  # 买入国债
```

---

## 4. 拥挤率择时

### 来源文件
- `jk2bt-main/strategies/82 拥挤率指标-择时大盘顶底-Clone1-第二版.ipynb`
- `jk2bt-main/strategies/42 大盘拥挤率极速版-180天3秒.ipynb`

### 核心定义
拥挤率 = 成交额前5%的股票的总成交额 / 全市场总成交额 × 100

### 检测代码
```python
# 版本1（慢速版）
for date1 in trade_days:
    all_stocks = list(get_all_securities(date=date1).index)
    h = get_price(all_stocks, end_date=date1, frequency='1d', fields='money',
                  count=1, panel=False).sort_values(by='money', ascending=False)
    n_five_pct = int(len(h) / 20)   # 5%
    n_crowd = h.iloc[:n_five_pct]['money'].sum() / h['money'].sum()
    dict_crowd[date1] = n_crowd * 100

# 版本2（极速版，pivot优化）
h = get_price(all_stocks, end_date=trade_day, frequency='1d', fields='money',
              count=days, panel=False).pivot(index='code', columns='time', values='money')

for day in h.columns:
    s2 = h[day].dropna().sort_values(ascending=False)
    dict_crowd[day] = (100 * s2.iloc[:len(s2)//20].sum()) / s2.sum()
```

### 阈值
| 区间 | 拥挤率值 | 含义 |
|------|---------|------|
| 顶部 | >55% | 资金过度集中，市场可能见顶 |
| 底部 | <33% | 资金分散，市场可能见底 |
| 正常 | 33%~55% | 中性区间 |

### 基于dataframe的筛选
```python
df_crowd[df_crowd.crowd_rate >= 55]   # 顶部信号
df_crowd[df_crowd.crowd_rate <= 33]   # 底部信号
```

---

## 5. 牛熊指标（波动率/换手率）

### 来源文件
- `jk2bt-main/strategies/63 研究 【复现】华泰证券-波动率和换手率构建牛熊指标.ipynb`

### 核心公式
```
牛熊指标(Kernel Index) = 波动率(200日/250日标准差) / 换手率(200日/250日均值)
```

### 检测代码
```python
class VT_Factor:
    def _Calc_func(self, x_df):
        df = x_df.copy()
        periods = self.periods
        for n in periods:
            turnover_ma = df['turnover_rate_f'].rolling(n).mean()
            std = df['pct_chg'].rolling(n).std(ddof=0)
            kernel_factor = std / turnover_ma
            kernel_factor.name = 'kernel_' + str(n)
        return kernel_factor

# 构建示例
close_df['kernel_index'] = close_df['std_200'] / index_daily_df['turnover_rate_200']
```

### 市场状态划分矩阵
| 波动率 | 换手率 | 市场状态 | 牛熊指标方向 |
|--------|--------|---------|------------|
| ↑上行 | ↓下行 | 典型熊市 | ↑上升（看空） |
| ↑上行 | ↑上行 | 典型牛市 | 上升或震荡 |
| ↓下行 | ↑上行 | 牛市初期/反弹 | ↓下降（看多） |
| ↓下行 | ↓下行 | 震荡市 | 取决于相对速度 |

### 择时策略
```python
# 双均线策略（对牛熊指标反向操作）
# 牛熊指标趋势向上 → 看空指数
# 牛熊指标趋势向下 → 看多指数
MA_20 = rolling(20).mean()
MA_60 = rolling(60).mean()
# 金叉(MA20上穿MA60)→牛熊指标向上→看空
# 死叉(MA20下穿MA60)→牛熊指标向下→看多

# 回测结果（上证综指2007-2019）
# 牛熊指标择时: 年化7.91%, 夏普0.51, 胜率81.82%
# 指数直接择时: 年化1.11%, 夏普0.08, 胜率29.03%
```

### 波动率与指数的相关系数
```python
corr = close_df[['kernel_index']].corrwith(close_df['close']).values[0]
# 相关系数约为 -0.55
```

---

## 6. MACD/MA5复合熔断择时

### 来源文件
- `jk2bt-main/strategies/23 大盘择时，逻辑简单.txt`

### 检测代码
```python
# MACD择时（基于沪深300指数的月线）
def get_macd_M(stock_list, check_date):
    for stock in stock_list:
        array = get_bars(security=stock, count=500, unit='1M',
                         fields=['close'], include_now=False, end_dt=check_date)
        close_list = array['close']
        dif, dea, macd = tb.MACD(close_list, fastperiod=12, slowperiod=26, signalperiod=9)
        last_macd = macd[-1]
        macd_dic = (last_dif, last_dea, last_macd*2)
    return macd_list

# MACD > 0 开仓信号
if today_sig > 0:
    g.no_trading_today_signal = False   # 允许交易

# MACD <= 0 空仓信号
if today_sig <= 0:
    g.no_trading_today_signal = True    # 禁止交易
    # 全仓卖出所有股票，买入300ETF
    for s in stock_list:
        order_target(s, 0)
    order_value(g.etf_B, context.portfolio.available_cash)
```

### 选股配合条件
```python
# 基本面筛选：PB<1, 市值>500亿, ROA>0.15
choice_roa: query(valuation).filter(
    valuation.pb_ratio < 1, valuation.pb_ratio > 0,
    valuation.market_cap > 500, indicator.roa > 0.15)

# Beta筛选：相对于300指数的历史Beta < 0.7
g.beta = 0.7
stocks = get_beta(yesterday, stocks)
df = df.query(f'score<{g.beta}')
```

### 决策逻辑
| MACD信号 | 操作 |
|----------|------|
| MACD > 0 | 允许买入股票（最多5只），否则持有货币ETF |
| MACD <= 0 | 强制清仓股票，买入沪深300ETF作为替代 |

---

## 7. 市场宽度（扩散指标）

### 来源文件
- `jk2bt-main/strategies/45 研究 市场宽度.ipynb`
- `jk2bt-main/strategies/52 市场宽度——简洁版.ipynb`
- `jk2bt-main/strategies/97 市场宽度20210622.ipynb`

### 核心定义
市场宽度 = BIAS(Close, MA20) > 0 的股票比例（按行业汇总）

### 检测代码
```python
# BIAS计算
def _calc_bias(stocks, end_date, window=20):
    prices = get_price(stocks, end_date=end_date, count=window+1,
                       fields=["close"], panel=False)
    pivot = prices.pivot(index="time", columns="code", values="close")
    ma = pivot.rolling(window).mean()
    last_close = pivot.iloc[-1]
    last_ma = ma.iloc[-1]
    bias = ((last_close - last_ma) / last_ma * 100).dropna()
    return bias.to_dict()

# 按行业汇总BIAS>0的比例
# 简洁版
df_bias = df_close.iloc[20:] > df_close.rolling(20).mean().iloc[20:]   # C > MA20
# 按行业
for idx, row in df_industries.iterrows():
    ind_stocks = set(get_industry_stocks(idx, date=end_date))
    ind_avail_stocks = list(columns & ind_stocks)
    if ind_avail_stocks:
        df[row['name']] = (100 * (df_bias[ind_avail_stocks].sum(axis=1)) / len(ind_avail_stocks)).astype(int)
```

### 阈值（根据market_sentiment_indicators.py）
| 区间 | 宽度值 | 含义 |
|------|--------|------|
| 极度悲观 | <30% | 可能接近底部 |
| 中性 | 30%~70% | 正常区间 |
| 极度乐观 | >70% | 注意顶部风险 |

### 热力图可视化
- 使用seaborn heatmap显示各行业每日宽度
- vmin=0, vmax=100
- 三种汇总方式：直接加总、行业再平均、全市场比例

---

## 8. 大盘跌幅择时（别人恐惧我贪婪）

### 来源文件
- `jk2bt-main/strategies/47 别人恐惧我贪婪——重视大盘择时.txt`
- `聚宽有价值策略558/57 别人恐惧我贪婪3——年化20%的股债组合.txt`

### 检测代码
```python
# 获取上证指数昨日跌幅
df = attribute_history('000001.XSHG', count=2, unit='1d',
        fields=['open', 'close', 'high', 'low', 'volume', 'money'],
        skip_paused=True, df=True, fq='pre')
y1_close = df['close'][0]
y2_close = df['close'][1]
y_cha = (y2_close - y1_close) / y1_close    # 昨日跌幅

# 获取今日截止目前的跌幅
current_data_now = get_current_tick('000001.XSHG')
t_cha = (current_data_now.current - y2_close) / y2_close

# 触发买入条件（恐惧时贪婪）
if y_cha <= -0.015 and t_cha <= -0.015:  # 连续两日跌超1.5%
    buy_stock(context, g.pool)            # 买入中证500市值前50大股票
    g.buttun = 1

# 触发卖出条件（持有20天后清仓）
if g.day % 20 == 0:
    for sell_code in context.portfolio.positions.keys():
        order_target_value(sell_code, 0)
    g.day = 1
    g.buttun = 0
```

### 阈值
| 参数 | 值 | 含义 |
|------|-----|------|
| 昨日跌幅阈值 | -1.5%（-0.015） | 昨日上证指数跌超1.5% |
| 今日实时跌幅 | -1.5%（-0.015） | 今日上证指数截止14:55跌超1.5% |
| 持有天数 | 20天 | 买入后持有20个交易日自动卖出 |
| 股票池 | 中证500市值前50 | 选最大市值股票以求稳健 |

### 变体（57号文件）
```python
# 买入阈值略有不同
if y_cha <= -0.015 and t_cha <= -0.014:  # 今日阈值-1.4%（略宽松）
```

---

## 9. 宏观数据中长线（PMI经济周期）

### 来源文件
- `聚宽有价值策略558/48 一种宏观数据的中长线策略，年化15%，最大回撤9%.txt`

### 检测代码
```python
# PMI拟合判断经济周期
x = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]   # 13个月横坐标
y = get_PMI(current_date)                          # 获取过去13个月PMI
params = op.curve_fit(func, x, y)                  # 二次拟合 y = A*x^2 + B*x + C
k = 2 * params[0][0] * 12 + params[0][1]           # k是当前斜率

# PMI条件判断复苏
if k > 0.0 and y[-1] >= 50.0 and y[0] <= y[-1]:
    # PMI上升 + PMI>=50 + PMI同比上涨 → 经济扩张

# 供需格局判断（生产指数与新订单指数）
provide_and_need = calc_provide_and_need(g.begin_date, current_date)
# 复苏条件：供<50分位 && 需>50分位
if provide_and_need[0] < 50.0 and provide_and_need[1] > 50.0:

# 库存格局判断
save = calc_save(g.begin_date, current_date)
# 复苏条件：原材料库存<50分位
if save[0] < 50.0:
    g.mode = 1  # 启动长线玩法
```

### 1248定投法则
```python
def order_func(total_cash, available_cash, fund_price):
    buy_cash = 2 ** g.times * g.order_amount * total_cash
    # 每次下跌买入金额翻倍：1x, 2x, 4x, 8x
```

### 两种入场模式
| 模式 | 触发条件 | 每次加仓 | 止盈条件 |
|------|---------|---------|---------|
| 长线（经济周期） | PMI向上≥50 + 供需复苏+库存复苏 | PMI模式下跌2%加仓 | 供需过热(>97分位)+库存滞涨 |
| 中线（年K线MA10） | 沪深300跌破10年年K线MA10 | 年K线模式下跌5%加仓 | MA5<MA20（日线死叉且价格>MA120） |

### 右侧买入条件
```python
# MA5 > MA10 > MA20 > MA30 > MA30(前日)
ma5 = day_move_average(5, True)
ma10 = day_move_average(10, True)
ma20 = day_move_average(20, True)
ma30 = day_move_average(30, True)
ma30_pre = day_move_average(30, False)
if ma5 > ma10 > ma20 > ma30 > ma30_pre:
    order_value(g.stock_security, context.portfolio.available_cash)  # 全仓买入
```

---

## 10. 价值投资+大盘择时（RiskControl）

### 来源文件
- `jk2bt-main/strategies/54 价值投资策略-大盘择时.txt`

### RiskControl类
```python
class RiskControl(object):
    def __init__(self, symbol):
        self.symbol = symbol
        self.status = RiskControlStatus.RISK_NORMAL

    def compute_ma_rate(self, period, show_ma_rate):
        hst = get_bars(self.symbol, period, '1d', ['close'])
        ma = talib.MA(close_list, timeperiod=period)[-1]
        ma_rate = hst['close'][-1] / ma
        return ma_rate

    def check_for_rsi(self, period, rsi_min, rsi_max, show_rsi):
        rsi = talib.RSI(np.array(close), timeperiod=period)[-1]
        return (rsi_min < rsi < rsi_max)
```

### 状态机阈值
```python
def check_for_benchmark(self, context):
    ma_rate = self.compute_ma_rate(1000, False)  # 1000日均线偏离率

    if self.status == RiskControlStatus.RISK_NORMAL:
        if (ma_rate > 2.5) or (ma_rate < 0.30):
            self.status = RiskControlStatus.RISK_WARNING

    elif self.status == RiskControlStatus.RISK_WARNING:
        if 0.35 <= ma_rate <= 0.7:
            self.status = RiskControlStatus.RISK_NORMAL

    if self.status == RiskControlStatus.RISK_WARNING:
        could_trade = (self.check_for_rsi(15, 55, 90, False) and
                       self.check_for_rsi(90, 50, 90, False))
    elif self.status == RiskControlStatus.RISK_NORMAL:
        could_trade = self.check_for_rsi(60, 50, 99, False)

    return could_trade
```

### 阈值汇总
| 参数 | 值 | 含义 |
|------|-----|------|
| MA1000偏离率>2.5 | 从正常→警告 | 严重高于长期均值 |
| MA1000偏离率<0.30 | 从正常→警告 | 严重低于长期均值 |
| MA1000偏离率0.35~0.7 | 从警告→正常 | 回到合理区间 |
| RSI(15) | 55~90 | 短期不超卖（警告状态下） |
| RSI(90) | 50~90 | 长期不超卖（警告状态下） |
| RSI(60) | 50~99 | 正常状态下允许交易 |

### 基本面选股条件
- 总市值 ≥ 市场均值×1.2
- 流动比率 ≥ 市场均值
- 近四季ROE ≥ 市场均值
- 近3年FCF均为正值（>100万）
- 营收成长率15%~50%
- EPS成长率8%~50%

### 均线过滤
```python
def judge_More_average(security):
    MA5 < MA20 and MA10 < MA30:  # 空头排列则拒绝买入
```

### 止盈止损
- 盈利>35% → 止盈
- 5日跌幅>10% → 止损

---

## 11. RSRS择时+北上资金

### 来源文件
- `聚宽有价值策略558/58 ETF动量轮动RSRS与北上择时-股债平衡-盘中止损.txt`

### 核心公式
```
RSRS斜率 = 线性回归(最低价, 最高价)   # 18日窗口
RSRS标准分 = (当前斜率 - 均值) / 标准差  # 600日滚动
RSRS因子 = RSRS标准分 × R²
```

### 检测代码
```python
def get_ols(x, y):
    slope, intercept = np.polyfit(x, y, 1)
    r2 = 1 - (sum((y - (slope*x + intercept))**2) / ((len(y)-1) * np.var(y, ddof=1)))
    return (intercept, slope, r2)

def get_zscore(slope_series):
    mean = np.mean(slope_series)
    std = np.std(slope_series)
    return (slope_series[-1] - mean) / std

def get_timing_signal(context, stock):
    get_north_money(context)   # 获取北上资金数据
    data = attribute_history(g.ref_stock, 18, '1d', ['high', 'low'])
    intercept, slope, r2 = get_ols(data.low, data.high)
    g.slope_series.append(slope)
    rsrs_score = get_zscore(g.slope_series[-g.M:]) * r2

    if g.north_money >= 0:
        if rsrs_score > g.score_threshold: return "BUY"
        elif rsrs_score < -g.score_threshold: return "SELL"
        else: return "KEEP"
    else:
        return 'SELL'    # 北上资金净流出时强制卖出
```

### 参数
| 参数 | 值 | 含义 |
|------|-----|------|
| g.N | 18 | 回归窗口（计算斜率） |
| g.M | 600 | 滚动z-score窗口 |
| g.score_threshold | 0.7 | RSRS因子阈值 |
| g.momentum_day | 20 | 动量计算周期 |
| g.ref_stock | 000300.XSHG | 基准为沪深300 |

### 动量选股
```python
def get_rank(context, stock_pool):
    biasN = 90
    for stock in g.stock_pool:
        data = attribute_history(stock, biasN + g.momentum_day, '1d', ['close'])
        bias = (data.close / data.close.rolling(biasN).mean())[-g.momentum_day:]
        score = np.polyfit(np.arange(g.momentum_day), bias/bias[0], 1)[0].real
    # 乖离动量拟合斜率排名
```

### 北上资金择时
```python
def get_north_money(context):
    # 沪股通（310001）+ 深股通（310002）
    n_sh = finance.run_query(query(finance.STK_ML_QUOTA).filter(
        finance.STK_ML_QUOTA.link_id == 310001).limit(10))
    n_sz = finance.run_query(query(finance.STK_ML_QUOTA).filter(
        finance.STK_ML_QUOTA.link_id == 310002).limit(10))

    total_net_in = 0
    for i in range(0, 2):
        sh_in = n_sh['buy_amount'][i] - n_sh['sell_amount'][i]
        sz_in = n_sz['buy_amount'][i] - n_sz['sell_amount'][i]
        total_net_in += sh_in + sz_in
    g.north_money = total_net_in
```

### 决策矩阵
| RSRS信号 | 北上资金 | 操作 |
|----------|---------|------|
| BUY (>0.7) | 净流入(≥0) | 买入最强的ETF |
| KEEP | 净流入(≥0) | 持有（波动平衡） |
| SELL (<-0.7) | 净流入(≥0) | 清仓（保留债券/纳指） |
| 任意 | 净流出(<0) | 强制卖出 |

### ETF轮动池
```python
g.stock_pool = [
    '510050.XSHG',  # 上证50ETF
    '510500.XSHG',  # 中证500ETF
    '510300.XSHG',  # 沪深300ETF
    '512100.XSHG',  # 1000ETF
    '159949.XSHE',  # 创业板50
    '163417.XSHE',  # 兴全合宜
    '161005.XSHE',  # 富国天惠
]
```

---

## 12. 市场底部特征综合

### 来源文件
- `聚宽有价值策略558/market_sentiment_indicators.py`

### 9大底部信号
| # | 指标 | 含义 |
|---|------|------|
| 1 | 股价<2元个股占比 | 低价股比例高→市场低迷 |
| 2 | 破净(PB<1)个股占比 | 大面积破净→底部特征 |
| 3 | 全市场成交额萎缩程度 | 成交额 vs 近期最高值的比值 |
| 4 | 个股平均成交金额 | 市场活跃度 |
| 5 | 个股区间最大跌幅中位数 | 市场调整深度 |
| 6 | 次新股破发率 | 新上市股票首日破发比例 |

### 综合判断阈值
```python
is_bottom = (
    market_breadth < 30 and
    crowding_rate < 40 and
    new_high_ratio < 1
)

is_top = (
    market_breadth > 70 and
    new_high_ratio > 5
)
```

### GSISI投资者情绪指数
```python
# 基于申万一级行业的Beta与Spearman秩相关
def gsisi(self, start_date, end_date, window=35, pct_window=15):
    sw_pct = sw_df.pct_change(pct_window)
    index_pct = index_price.pct_change(pct_window)
    beta_df = sw_pct.apply(lambda x: tb.BETA(x, index_pct, window))
    gsisi_series = sw_pct.corrwith(beta_df, method="spearman", axis=1)

# 情绪判断
if latest > 0.3:   偏乐观
elif latest < -0.3: 偏悲观
else: 中性
```

---

## 13. 盘中止损策略

### 来源文件
- `聚宽有价值策略558/58 ETF动量轮动RSRS与北上择时-股债平衡-盘中止损.txt`

### 检测代码
```python
def hold_check(context):
    N = 20
    hour = context.current_dt.hour
    minute = context.current_dt.minute
    if context.portfolio.positions:
        if hour == 13 and minute == 0:   # 13:00盘中检查
            for stk in context.portfolio.positions:
                dt = attribute_history(stk, N+2, '60m', ['close'])
                dt['man'] = dt.close / dt.close.rolling(N).mean()
                if dt.man[-1] < 1.0:     # 当前价格 < 60分钟MA20
                    order_target_value(stk, 0)
                    log.info('盘中止损', stk)
```

### 止损规则
- 时间：每日13:00盘中检查
- 条件：60分钟K线收盘价 < MA20（20期均线）
- 操作：清仓止损
- 标的：当前持仓的全部ETF

---

## 附表：文件索引

| # | 文件名 | 目录 | 模式类型 |
|---|--------|------|---------|
| 07 | 股债波动平衡.txt | jk2bt | 股债平衡 |
| 23 | 大盘择时，逻辑简单.txt | jk2bt | MACD择时+选股 |
| 42 | 大盘拥挤率极速版-180天3秒.ipynb | jk2bt | 拥挤率 |
| 45 | 研究 市场宽度.ipynb | jk2bt | 市场宽度 |
| 47 | 别人恐惧我贪婪——重视大盘择时.txt | jk2bt | 恐慌买入 |
| 48 | 一种宏观数据的中长线策略...txt | 聚宽558 | PMI经济周期 |
| 52 | 市场宽度——简洁版.ipynb | jk2bt | 市场宽度 |
| 53 | 基于大盘PE标准差偏离度...txt | jk2bt | PE定投 |
| 54 | 价值投资策略-大盘择时.txt | jk2bt | RiskControl |
| 57 | 别人恐惧我贪婪3——年化20%的股债组合.txt | 聚宽558 | 恐慌买入+股债 |
| 58 | ETF动量轮动RSRS与北上择时-股债平衡-盘中止损.txt | 聚宽558 | RSRS+北上+波动平衡 |
| 63 | 研究 【复现】华泰证券-波动率和换手率构建牛熊指标.ipynb | jk2bt | 牛熊指标 |
| 82 | 拥挤率指标-择时大盘顶底-Clone1-第二版.ipynb | jk2bt | 拥挤率 |
| 97 | 大周期顶底判断：FED指标+格雷厄姆指数一次搞定.ipynb | jk2bt | FED+格雷厄姆 |
| 97 | 市场宽度20210622.ipynb | jk2bt | 市场宽度 |
| — | market_sentiment_indicators.py | 聚宽558 | 综合指标库 |
