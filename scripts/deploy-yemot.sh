#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${YEMOT_TOKEN:-}" ]]; then
  echo "YEMOT_TOKEN is missing."
  exit 1
fi

api_url="https://www.call2all.co.il/ym/api/UploadTextFile"
config_root="yemot/ivr"

if [[ ! -d "$config_root" ]]; then
  echo "Configuration folder not found: $config_root"
  exit 1
fi

while IFS= read -r -d '' file; do
  relative_path="${file#"$config_root"}"
  remote_path="ivr2:${relative_path}"

  echo "Uploading ${remote_path}"

  response="$(
    curl --fail-with-body --silent --show-error       --request POST       --data-urlencode "token=${YEMOT_TOKEN}"       --data-urlencode "what=${remote_path}"       --data-urlencode "contents@${file}"       "$api_url"
  )"

  status="$(jq -r '.responseStatus // empty' <<<"$response")"
  if [[ "$status" != "OK" ]]; then
    echo "Upload failed for ${remote_path}"
    jq . <<<"$response"
    exit 1
  fi
done < <(find "$config_root" -type f -name '*.ini' -print0 | sort -z)

echo "Yemot IVR configuration uploaded successfully."
