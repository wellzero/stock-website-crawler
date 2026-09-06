#!/usr/bin/env bash
#
source ~/proxy.sh

cd /home/quant_volumn/quant_common/stock-website-crawler/stock-crawler
node news_scrape/scrape-news.mjs news_scrape/conf.json
