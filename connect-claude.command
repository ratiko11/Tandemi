#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Get it from https://nodejs.org and run this again."; read -r; exit 1; }
node engine/setup-mcp.js "$@"
