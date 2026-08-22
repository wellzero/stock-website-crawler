#!/usr/bin/env bash
#
source ~/proxy.sh

cd /home/quant_volumn/quant_common/stock-website-crawler/stock-crawler
node invest_info_scrape/scrape-blog-feeds.mjs invest_info_scrape/conf.json
