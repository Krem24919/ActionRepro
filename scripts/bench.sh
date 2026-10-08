#!/usr/bin/env bash
# ActionRepro benchmark: measures extraction accuracy, fingerprint stability,
# verification correctness (incl. false positives/negatives), context
# reduction, and per-command overhead across every failure fixture.
#
# Every number below is measured live by this script — nothing is hardcoded.
# Usage: npm run bench   (requires `npm run build` first)
# Exit status: 0 when every check passes, 1 otherwise (CI-gateable).
#
# Fallible commands are always guarded (`|| code=$?`): a broken build step
# must FAIL its row, never abort the whole run.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f dist/cli.js ]; then
  echo "bench: dist/cli.js missing — run 'npm run build' first." >&2
  exit 2
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
TIMING_INSPECT=0
TIMING_REPRODUCE=0
TIMING_VERIFY=0
N_TIMED=0

now_ms() {
  node -p "Number(process.hrtime.bigint() / 1000000n)"
}

field() {
  # field <json-file> <key> — top-level JSON value, empty when absent/unreadable
  node -e "try{const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const v=d[process.argv[2]];console.log(v ?? '')}catch(e){console.log('')}" "$1" "$2"
}

FIXTURES=$(node -e "console.log(Object.keys(require('./bench/expected.json').fixtures).join('\n'))")
CLEAN=$(node -e "console.log(require('./bench/expected.json').cleanLog)")
MUST_NOT=$(node -e "console.log(require('./bench/expected.json').summaryMustNotContain.join('\n'))")

echo "## ActionRepro benchmark"
echo ""
echo "| fixture | ecosystem | anchor ok | stable fp | same→REPRO | diff→NOT | clean→NOT |"
echo "| ------- | --------- | --------- | --------- | ---------- | --------- | --------- |"

for F in $FIXTURES; do
  LOG="fixtures/logs/$F"
  EXP_ECO=$(node -e "console.log(require('./bench/expected.json').fixtures['$F'].ecosystem)")
  EXP_ANCHOR=$(node -e "console.log(require('./bench/expected.json').fixtures['$F'].anchorContains)")
  OTHER="fixtures/logs/go-fail.log"
  [ "$F" = "go-fail.log" ] && OTHER="fixtures/logs/npm-fail.log"

  # --- inspect: ecosystem + anchor accuracy + timing ---
  T0=$(now_ms)
  INSPECT_CODE=0
  node dist/cli.js inspect "$LOG" --json > "$WORK/inspect.json" 2>/dev/null || INSPECT_CODE=$?
  T1=$(now_ms)
  TIMING_INSPECT=$((TIMING_INSPECT + T1 - T0))
  ECO=$(field "$WORK/inspect.json" ecosystem)
  SUMMARY=$(field "$WORK/inspect.json" summary)
  ANCHOR_OK=$([ "$INSPECT_CODE" = "0" ] && printf '%s' "$SUMMARY" | grep -qF -- "$EXP_ANCHOR" && echo 0 || echo 1)
  BAD_SUMMARY=1
  while IFS= read -r bad; do
    [ -n "$bad" ] && printf '%s' "$SUMMARY" | grep -qF -- "$bad" && BAD_SUMMARY=0 || true
  done <<< "$MUST_NOT"

  # --- reproduce: bundle + timing + reduction ---
  T0=$(now_ms)
  REPRO_CODE=0
  node dist/cli.js reproduce "$LOG" --out "$WORK/b-$F" --json > /dev/null 2>&1 || REPRO_CODE=$?
  T1=$(now_ms)
  TIMING_REPRODUCE=$((TIMING_REPRODUCE + T1 - T0))
  FP1=$(field "$WORK/b-$F/repro.json" fingerprint)
  LOG_BYTES=$(wc -c < "$LOG")
  # Context reduction is informational only: what an agent must read
  # (failure.txt) vs the raw log. Small fixtures can read negative
  # because fixed bundle costs dominate — that is expected, not a failure.
  FAILTXT_BYTES=0
  if [ -f "$WORK/b-$F/failure.txt" ]; then
    FAILTXT_BYTES=$(wc -c < "$WORK/b-$F/failure.txt")
  fi
  REDUCTION=0
  [ "$LOG_BYTES" -gt 0 ] && [ "$FAILTXT_BYTES" -gt 0 ] && REDUCTION=$((100 - FAILTXT_BYTES * 100 / LOG_BYTES)) || true

  # --- stability: timestamp-shifted copy must hash identically ---
  sed -E 's/20[0-9]{2}-[0-9-]+T[0-9:.]+Z?/2099-12-31T23:59:59.0000000Z/g' "$LOG" > "$WORK/noisy-$F"
  node dist/cli.js reproduce "$WORK/noisy-$F" --out "$WORK/bn-$F" --json > /dev/null 2>&1 || true
  FP2=$(field "$WORK/bn-$F/repro.json" fingerprint)
  STABLE=1
  [ -n "$FP1" ] && [ "$FP1" = "$FP2" ] && STABLE=0 || true

  # --- verify: same (REPRODUCED/exit 0), different (NOT/exit 1), clean (NOT/exit 1) ---
  T0=$(now_ms)
  SAME_CODE=0
  node dist/cli.js verify "$WORK/b-$F" "$LOG" > /dev/null 2>&1 || SAME_CODE=$?
  T1=$(now_ms)
  TIMING_VERIFY=$((TIMING_VERIFY + T1 - T0))
  DIFF_CODE=0
  node dist/cli.js verify "$WORK/b-$F" "$OTHER" > /dev/null 2>&1 || DIFF_CODE=$?
  CLEAN_CODE=0
  node dist/cli.js verify "$WORK/b-$F" "fixtures/logs/$CLEAN" > /dev/null 2>&1 || CLEAN_CODE=$?

  N_TIMED=$((N_TIMED + 1))
  [ "$ANCHOR_OK" = "0" ] && A=yes || A=no
  [ "$STABLE" = "0" ] && S=yes || S=no
  [ "$SAME_CODE" = "0" ] && R=yes || R=no
  [ "$DIFF_CODE" = "1" ] && D=yes || D=no
  [ "$CLEAN_CODE" = "1" ] && C=yes || C=no
  ROW_OK=1
  [ "$A" = yes ] && [ "$S" = yes ] && [ "$R" = yes ] && [ "$D" = yes ] && [ "$C" = yes ] && [ "$BAD_SUMMARY" = 1 ] && [ "$ECO" = "$EXP_ECO" ] && [ "$REPRO_CODE" = "0" ] && ROW_OK=0 || true
  if [ "$ROW_OK" = 0 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $F row ($A/$S/$R/$D/$C eco=$ECO bad=$BAD_SUMMARY red=${REDUCTION}%)"; fi
  echo "| $F | $ECO | $A | $S | $R | $D | $C |"
  echo "  ($F: evidence=${REDUCTION}% log=${LOG_BYTES}B failure.txt=${FAILTXT_BYTES}B fp=${FP1})" >&2
done

echo ""
echo "timings (avg ms over $N_TIMED fixtures): inspect=$((TIMING_INSPECT / N_TIMED)) reproduce=$((TIMING_REPRODUCE / N_TIMED)) verify=$((TIMING_VERIFY / N_TIMED))"
echo ""
echo "result: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
