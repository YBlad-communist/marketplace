#!/bin/bash
cd /root/marketplace
set -a
source .env
set +a
exec node apps/api/dist/src/server.js
