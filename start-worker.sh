#!/bin/bash
cd /root/marketplace
set -a
source .env
set +a
exec node apps/worker/dist/index.js
