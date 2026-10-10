#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then echo "Run start.sh once first."; exit 1; fi
.venv/bin/python -m pip install -r requirements-desktop.txt
