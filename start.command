#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "Node.js is not installed. Get the LTS version from https://nodejs.org and run this again."; read -r; exit 1; fi
node engine/server.js
