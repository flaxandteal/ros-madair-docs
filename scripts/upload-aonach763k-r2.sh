#!/usr/bin/env bash
# Upload the 763k Aonach Mór substrate to Cloudflare R2 (too big — ~2.4 GB — for the
# 1 GB GitHub Pages site limit). The docs demo then reads it cross-origin via
# NEXT_PUBLIC_DATA_HOST set to the bucket's public URL. Needs the account's S3 endpoint
# + an R2 API token exposed as an `r2` aws profile (or AWS_* env). Credential-free to
# author; you supply the bucket + token.
#
# Create once in the Cloudflare dashboard: R2 → create bucket; R2 → Manage API Tokens →
# create an S3 token (Object Read & Write) → gives an Access Key ID + Secret. Put them
# in ~/.aws/credentials under an [r2] profile. The endpoint is
# https://<ACCOUNT_ID>.r2.cloudflarestorage.com. Enable public access (r2.dev subdomain
# or a custom domain) and use that as NEXT_PUBLIC_DATA_HOST.
#
#   R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
#   R2_BUCKET=aonach-mor-demo \
#   AWS_PROFILE=r2 \
#   ./scripts/upload-aonach763k-r2.sh
set -euo pipefail
: "${R2_ENDPOINT:?set R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com}"
: "${R2_BUCKET:?set R2_BUCKET=<bucket-name>}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/public/data/aonach763k"
[ -d "$SRC" ] || { echo "missing $SRC — generate/emit the 763k substrate first"; exit 1; }

echo "syncing $(du -sh "$SRC" | cut -f1) → s3://$R2_BUCKET/aonach763k …"
aws s3 sync "$SRC" "s3://$R2_BUCKET/aonach763k" \
  --endpoint-url "$R2_ENDPOINT" --no-progress --only-show-errors

echo "applying CORS (range + the Pages origin) …"
aws s3api put-bucket-cors --bucket "$R2_BUCKET" \
  --endpoint-url "$R2_ENDPOINT" \
  --cors-configuration "file://$HERE/scripts/r2-cors.json"

echo "done. Now set NEXT_PUBLIC_DATA_HOST to the bucket's PUBLIC base URL"
echo "(e.g. https://<hash>.r2.dev  or  https://data.aonachmor.example) — the demo's"
echo "aonach763k/* fetches route there; everything else stays on Pages."
