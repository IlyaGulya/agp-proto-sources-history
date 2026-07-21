#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <agp-version> <extracted-sources-directory>" >&2
  exit 2
fi

version="$1"
extracted="$2"

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)[0-9]+)?$ ]]; then
  echo "invalid AGP version: $version" >&2
  exit 2
fi
if [[ ! -d "$extracted" ]]; then
  echo "sources directory does not exist: $extracted" >&2
  exit 2
fi

proto_modules=(
  "com.android.tools.analytics-library/protos"
  "com.android.tools.build/aapt2-proto"
)

for module in "${proto_modules[@]}"; do
  source_dir="$extracted/$module"
  mkdir -p "$module"

  if [[ -d "$source_dir" ]]; then
    rsync -a --delete "$source_dir/" "$module/"
  else
    find "$module" -mindepth 1 -depth -delete
  fi
done

printf '%s\n' "$version" > .agp-version
find "${proto_modules[@]}" -type f -exec chmod 0644 {} +
git add --all -- .agp-version "${proto_modules[@]}"
git commit --quiet -m "AGP $version"
git tag -a "agp-$version" -m "Android Gradle Plugin $version protobuf sources"
