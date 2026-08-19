#!/bin/sh
# 語法檢查 apps-script/*.gs（node --check 不吃 .gs 副檔名，先複製成 .js）
set -e
tmp=$(mktemp -d)
fail=0
for f in "$(dirname "$0")"/../apps-script/*.gs; do
  base=$(basename "$f" .gs)
  cp "$f" "$tmp/$base.js"
  if node --check "$tmp/$base.js"; then
    echo "ok   $base.gs"
  else
    echo "FAIL $base.gs"
    fail=1
  fi
done
rm -rf "$tmp"
exit $fail
