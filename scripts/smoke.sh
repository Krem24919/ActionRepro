#!/usr/bin/env bash
# Local smoke test: exercises success + failure paths using fixed fixtures.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> build"
npm run build >/dev/null

echo "==> doctor"
node dist/cli.js doctor

for f in npm-fail python-fail cargo-fail go-fail pnpm-fail; do
  echo "==> inspect fixtures/logs/$f.log"
  node "dist/cli.js" inspect "fixtures/logs/$f.log" | head -n 6
done

echo "==> reproduce (npm fail)"
rm -rf /tmp/actionrepro-smoke
node dist/cli.js reproduce fixtures/logs/npm-fail.log --out /tmp/actionrepro-smoke
ls -la /tmp/actionrepro-smoke
test -f /tmp/actionrepro-smoke/reproduce.sh
test -f /tmp/actionrepro-smoke/README.md
test -f /tmp/actionrepro-smoke/failure.txt
test -f /tmp/actionrepro-smoke/environment.txt
test -f /tmp/actionrepro-smoke/repro.json

echo "==> redaction check (must not find fake secret)"
node dist/cli.js reproduce fixtures/logs/secrets.log --out /tmp/actionrepro-secrets
if grep -r "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456" /tmp/actionrepro-secrets; then
  echo "FAIL: secret leaked into bundle"
  exit 1
fi
echo "redaction OK"

echo "==> ALL SMOKE TESTS PASSED"
