#!/bin/bash
# Best Alpha Strategy — Quick Runner
# Usage: ./scripts/best_alpha_strategy.sh [--walk-forward N] [--no-market-timing]

cd "$(dirname "$0")/.."

# Check if analysis_v2 data exists
if [ ! -d "/Users/fengzhi/Downloads/git2/analysis_v2/data_cache/market_data" ]; then
    echo "ERROR: analysis_v2 data_cache not found at /Users/fengzhi/Downloads/git2/analysis_v2/data_cache/"
    exit 1
fi

# Default: run last 3 months with market timing
if [ $# -eq 0 ]; then
    python3 scripts/best_alpha_strategy.py \
        --start 2026-04-01 --end 2026-07-03 \
        --top-n 30 --rebalance-days 3
else
    python3 scripts/best_alpha_strategy.py "$@"
fi
