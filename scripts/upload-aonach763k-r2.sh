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
# aws-cli >= 2.23 defaults request_checksum_calculation to "when_supported", which
# adds CRC32 trailers R2's SigV4 verification rejects on larger/multipart PUTs →
# "SignatureDoesNotMatch" on a subset of files. Revert to the pre-2.23 behaviour.
export AWS_REQUEST_CHECKSUM_CALCULATION="${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}"
export AWS_RESPONSE_CHECKSUM_VALIDATION="${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}"
# R2 ignores the region but the CLI insists one be set.
export AWS_REGION="${AWS_REGION:-auto}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/public/data/aonach763k"
[ -d "$SRC" ] || { echo "missing $SRC — generate/emit the 763k substrate first"; exit 1; }

# Snapshot-versioned layout for structural cache-busting (no purges):
#   - the artifacts go under aonach763k/<snapshot_id>/… and are cached `immutable`
#     (a re-emit changes snapshot_id → new URLs → automatically fresh), while
#   - manifest.json sits at the stable aonach763k/ path, `no-cache`, and names the
#     current snapshot. The demo reads the manifest, then the snapshot path.
SNAP="$(python3 -c "import json;print(json.load(open('$SRC/manifest.json'))['snapshot_id'])")"
[ -n "$SNAP" ] || { echo "no snapshot_id in $SRC/manifest.json"; exit 1; }

echo "syncing $(du -sh "$SRC" | cut -f1) artifacts → s3://$R2_BUCKET/aonach763k/$SNAP (immutable) …"
aws s3 sync "$SRC" "s3://$R2_BUCKET/aonach763k/$SNAP" \
  --endpoint-url "$R2_ENDPOINT" --no-progress --only-show-errors \
  --exclude "manifest.json" \
  --cache-control "public, max-age=31536000, immutable"

echo "placing manifest at the stable path (no-cache) …"
aws s3 cp "$SRC/manifest.json" "s3://$R2_BUCKET/aonach763k/manifest.json" \
  --endpoint-url "$R2_ENDPOINT" --only-show-errors \
  --content-type "application/json" --cache-control "no-cache, max-age=0, must-revalidate"

echo "applying CORS (range + the Pages origin) …"
aws s3api put-bucket-cors --bucket "$R2_BUCKET" \
  --endpoint-url "$R2_ENDPOINT" \
  --cors-configuration "file://$HERE/scripts/r2-cors.json"

# Prove the PUBLIC path actually serves range + CORS before we trust the demo to it.
# duckdb-wasm needs a 206 on a ranged GET and the CORS headers for the Pages origin;
# r2.dev or a custom-domain URL must pass this or the demo stalls exactly like before.
if [ -n "${PUBLIC_URL:-}" ]; then
  PROBE="${PUBLIC_URL%/}/aonach763k/manifest.json"
  ORIGIN="https://flaxandteal.github.io"
  echo ""
  echo "verifying range + CORS at $PROBE …"
  # NB: grep returns 1 on no-match, which would trip set -e inside $( ) — guard each.
  code=$(curl -s -o /dev/null -w '%{http_code}' -r 0-99 -H "Origin: $ORIGIN" "$PROBE" || echo 000)
  hdrs=$(curl -s -D - -o /dev/null -r 0-99 -H "Origin: $ORIGIN" "$PROBE" || true)
  acao=$(printf '%s' "$hdrs" | grep -i '^access-control-allow-origin' | tr -d '\r' || true)
  cr=$(printf '%s' "$hdrs" | grep -i '^content-range' | tr -d '\r' || true)
  echo "  ranged GET status : $code   (want 206)"
  echo "  Content-Range     : ${cr:-<none>}"
  echo "  CORS allow-origin : ${acao:-<none>}   (want * or $ORIGIN)"
  if [ "$code" = "206" ] && [ -n "$acao" ]; then
    echo "  ✓ range + CORS OK — safe to set NEXT_PUBLIC_DATA_HOST=$PUBLIC_URL"
  else
    echo "  ✗ NOT ready: range or CORS missing. Do NOT wire the demo yet — a custom"
    echo "    domain or a Worker proxy is the fix (see docs/consumer-handoff notes)."
    exit 2
  fi
else
  echo ""
  echo "done. Re-run with PUBLIC_URL=<public base url> set to auto-verify range+CORS,"
  echo "then set NEXT_PUBLIC_DATA_HOST to that URL (the demo's aonach763k/* fetches route"
  echo "there; everything else stays on Pages)."
fi
