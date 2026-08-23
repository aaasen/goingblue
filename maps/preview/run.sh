#!/bin/sh
# Launch the offline basemap preview: serves this directory (with Range
# support, required by pmtiles.js) and opens the page.
cd "$(dirname "$0")"
python3 serve.py 8471 &
SERVER=$!
trap "kill $SERVER" EXIT INT TERM
sleep 1
open "http://localhost:8471/"
wait
