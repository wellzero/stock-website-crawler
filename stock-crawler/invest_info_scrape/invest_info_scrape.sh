#!/usr/bin/env bash
#
source ~/proxy.sh

cd /home/quant_volumn/quant_common/stock-website-crawler/stock-crawler
# xueqiu's WAF (ssxmod_itna JS challenge) serves 403 application/octet-stream to
# headless Chrome (Playwright aborts with "Download is starting"). Run headful
# (headless:false in conf.json) under Xvfb so the challenge passes.
xvfb-run -a node invest_info_scrape/scrape-blog-feeds.mjs invest_info_scrape/conf.json
