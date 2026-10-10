#!/bin/sh
set -eu
cd "$(dirname "$0")"
python3 -m unittest discover -s tests -v
node extension/test-parser.js
node extension/test-chatgpt.js
node extension/test-worker.js
node extension/test-approval.js
node extension/test-loop.js
