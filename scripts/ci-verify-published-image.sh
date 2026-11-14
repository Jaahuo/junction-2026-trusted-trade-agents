#!/usr/bin/env bash
# Usage: ci-verify-published-image.sh <tag> <built config digest> <output name>
set -euo pipefail
tag=$1 expected=$2 output=$3
repository=jaahuo/junction-2026-trusted-trade-agents
image="ghcr.io/$repository:$tag"
token=$(curl --fail --silent --show-error --user "$REGISTRY_USER:$GH_TOKEN" \
  "https://ghcr.io/token?service=ghcr.io&scope=repository:$repository:pull" | jq -er .token)
for attempt in 1 2 3 4 5 6; do
  status=$(curl --silent --show-error --connect-timeout 10 --max-time 30 \
    --write-out '%{http_code}' -D "$RUNNER_TEMP/manifest-headers" -o "$RUNNER_TEMP/manifest.json" \
    -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/$repository/manifests/$tag")
  if [ "$status" = 200 ]; then break; fi
  if [ "$status" != 404 ] || [ "$attempt" = 6 ]; then
    echo "Manifest verification for $image failed with HTTP $status" >&2
    exit 1
  fi
  echo "Manifest for $image is not visible yet; checking again in 2 seconds." >&2
  sleep 2
done
digest=$(awk 'tolower($1) == "docker-content-digest:" { gsub("\r", "", $2); print $2 }' "$RUNNER_TEMP/manifest-headers")
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
[ "sha256:$(sha256sum "$RUNNER_TEMP/manifest.json" | cut -d ' ' -f 1)" = "$digest" ]
pushed=$(jq -er '.config.digest' "$RUNNER_TEMP/manifest.json")
[ "$pushed" = "$expected" ] || { echo "Pushed config digest $pushed does not match the build's $expected" >&2; exit 1; }
pinned="ghcr.io/$repository@$digest"
printf '%s=%s\n' "$output" "$pinned" >> "$GITHUB_OUTPUT"
printf '%s=%s\n' "$output" "$pinned" >> "$RUNNER_TEMP/deployment-evidence/identity.txt"
