#!/usr/bin/env bash
# Mutation check for the digest zero-loss test.
#
# The point of this script is to prove the test is load-bearing: it must go RED
# when someone re-promotes the lossy v4 digest, which is precisely the mistake
# this whole task exists to prevent. A test that cannot fail proves nothing.
#
# Method: work on a COPY of the app tree. Never mutate the real digest.
set -uo pipefail

APP=/workspace/tasks/073f99b5-1e1e-4751-bbb5-59caa20b1e5b/asterion/app
MUT=/tmp/digest-mutation-check

rm -rf "$MUT"
mkdir -p "$MUT"
cp -r "$APP/tests" "$MUT/tests"
mkdir -p "$MUT/src"

echo "═══ 1. BASELINE: the shipped digest must pass ═══"
cp "$APP/src/corpus-digest.json" "$MUT/src/corpus-digest.json"
( cd "$MUT" && node --test tests/digest-union.test.mjs 2>&1 | tail -6 )
BASE_STATUS=${PIPESTATUS[0]}

echo
echo "═══ 2. MUTATION: promote lossy v4 verbatim (the real regression) ═══"
node -e '
const { gunzipSync } = require("node:zlib");
const { readFileSync, writeFileSync } = require("node:fs");
const raw = gunzipSync(readFileSync("'"$APP"'/tests/fixtures/digest-inputs/v4.json.gz"));
const v4 = JSON.parse(raw.toString("utf8"));
v4.version = "5";                     // pretend it was promoted
writeFileSync("'"$MUT"'/src/corpus-digest.json", JSON.stringify(v4));
console.log("  wrote v4 content under version 5 (" + Object.values(v4.precedent).reduce((a,l)=>a+l.length,0) + " precedent rows)");
'
( cd "$MUT" && node --test tests/digest-union.test.mjs 2>&1 | tail -22 )
MUT_STATUS=${PIPESTATUS[0]}

echo
echo "═══ 3. RESTORE: original digest must pass again ═══"
cp "$APP/src/corpus-digest.json" "$MUT/src/corpus-digest.json"
( cd "$MUT" && node --test tests/digest-union.test.mjs 2>&1 | tail -6 )
BACK_STATUS=${PIPESTATUS[0]}

echo
echo "──────── RESULT ────────"
echo "baseline exit (expect 0):   $BASE_STATUS"
echo "mutation exit (expect !=0): $MUT_STATUS"
echo "restore  exit (expect 0):   $BACK_STATUS"

if [ "$BASE_STATUS" -eq 0 ] && [ "$MUT_STATUS" -ne 0 ] && [ "$BACK_STATUS" -eq 0 ]; then
  echo "PASS: the test is red on lossy v4 and green on the union."
  rm -rf "$MUT"
  exit 0
fi
echo "FAIL: mutation check did not behave as required."
exit 1
