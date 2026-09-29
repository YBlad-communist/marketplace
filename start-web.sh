#!/bin/bash
cd /root/marketplace/apps/web
set -a
source /root/marketplace/.env
set +a
export PORT=3000
export HOSTNAME=0.0.0.0
exec node /root/marketplace/node_modules/next/dist/bin/next start
