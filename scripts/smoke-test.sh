#!/bin/bash
set -euo pipefail
set -x
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
SB=2584
CP=2585
CP2=2586
BASE_SB="http://127.0.0.1:${SB}"
BASE_CP="http://127.0.0.1:${CP}"
BASE_CP2="http://127.0.0.1:${CP2}"

pass() { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
fail() { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m %s — %s\n" "$1" "$2"; }

cleanup() { kill %1 2>/dev/null; kill %2 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT

sign_jwt() {
  local key_hex="$1" aud="$2" lxm="$3"
  deno run --allow-env --allow-read --allow-write --allow-run --allow-net --unstable-worker-options - <<EOF
import { signerFromPrivateKeyHex, signComputeServiceAuth } from "@publicdomainrelay/compute-deno-atproto";
const sk = await signerFromPrivateKeyHex("${key_hex}");
console.log(await signComputeServiceAuth(sk, "${aud}", "${lxm}"));
EOF
}

deno run --allow-env --allow-read --allow-write --allow-run --allow-net --unstable-worker-options hono-sandbox/mod.ts --port "$SB" &
sleep 2

H=$(curl -s "$BASE_SB/health")
grep -q '"ok"' <<< "$H" && pass "health" || fail "health" "$H"

EXEC_BODY=$(jq -n --arg code 'console.log("hi"); return 42;' '{code: $code}')
E=$(curl -s -X POST "$BASE_SB/execute" -H 'content-type: application/json' -d "$EXEC_BODY")
grep -q '"result":42' <<< "$E" && pass "execute returns 42" || fail "execute" "$E"
grep -q '"stdout":"hi' <<< "$E" && pass "execute stdout" || fail "stdout" "$E"

TIMEOUT_BODY=$(jq -n --arg code 'while(true){}' --argjson timeoutMs 100 '{code: $code, timeoutMs: $timeoutMs}')
T=$(curl -s -X POST "$BASE_SB/execute" -H 'content-type: application/json' -d "$TIMEOUT_BODY")
grep -q '"timedOut":true' <<< "$T" && pass "execute timeout" || fail "timeout" "$T"

BUNDLE_BODY=$(jq -n --arg denoJson '{"imports":{},"compilerOptions":{"strict":false}}' --arg source 'function add(a, b) { return a + b; }' '{denoJson: $denoJson, source: $source}')
B=$(curl -s -X POST "$BASE_SB/bundle" -H 'content-type: application/json' -d "$BUNDLE_BODY")
grep -q "bundleJs" <<< "$B" && pass "bundle" || fail "bundle" "$B"

BJ=$(jq -r '.bundleJs' <<< "$B")
EXEC_BODY=$(jq -n --arg bundleJs "$BJ" '{bundleJs: $bundleJs}')
EB=$(curl -s -X POST "$BASE_SB/exec" -H 'content-type: application/json' -d "$EXEC_BODY")
grep -q '"exitCode":0' <<< "$EB" && pass "exec" || fail "exec" "$EB"

kill %1 2>/dev/null; wait 2>/dev/null; sleep 1

deno run --allow-env --allow-read --allow-write --allow-run --allow-net --unstable-worker-options hono-compute-deno/mod.ts --port "$CP" &
sleep 2

CH=$(curl -s "$BASE_CP/health")
grep -q '"ok"' <<< "$CH" && pass "compute health" || fail "compute health" "$CH"

DW=$(curl -s "$BASE_CP/.well-known/did.json")
grep -q '"did:web:' <<< "$DW" && pass "did:web doc" || fail "did:web" "$DW"
grep -q '"#gate_registry_worker_manifest_permissions"' <<< "$DW" && pass "gate service entry" || fail "gate service" "$DW"

kill %1 2>/dev/null; wait 2>/dev/null; sleep 1

deno run --allow-env --allow-read --allow-write --allow-run --allow-net --unstable-worker-options hono-compute-deno/mod.ts \
  --port "$CP2" --permission-mode by-policy --policy-handler-built-in allow-net &
sleep 2

KEY_HEX2=$(deno run --allow-read - <<EOF
import { loadOrCreateAttestationKeyHex } from "@publicdomainrelay/utils-attestation-key";
console.log(await loadOrCreateAttestationKeyHex("./attestation-key.jwk"));
EOF
)
JWT2=$(sign_jwt "$KEY_HEX2" "did:web:127.0.0.1" "com.publicdomainrelay.temp.compute.deno.gateRegistryWorkerManifestPermissions")

GATE_ALLOW_BODY=$(jq -n '{manifest: {lock: "{}", json: "{}", bundle: "self.onmessage = () => {}", permissions: {net: true}}}')
GAP2=$(curl -s -X POST "$BASE_CP2/xrpc/com.publicdomainrelay.temp.compute.deno.gateRegistryWorkerManifestPermissions" \
  -H 'content-type: application/json' -H "authorization: Bearer $JWT2" -H "host: 127.0.0.1:${CP2}" \
  -d "$GATE_ALLOW_BODY")
grep -q '"allow":true' <<< "$GAP2" && pass "by-policy gate allow" || fail "by-policy gate allow" "$GAP2"

GATE_DENY_BODY=$(jq -n '{manifest: {lock: "{}", json: "{}", bundle: "self.onmessage = () => {}", permissions: {read: true}}}')
GAP2D=$(curl -s -X POST "$BASE_CP2/xrpc/com.publicdomainrelay.temp.compute.deno.gateRegistryWorkerManifestPermissions" \
  -H 'content-type: application/json' -H "authorization: Bearer $JWT2" -H "host: 127.0.0.1:${CP2}" \
  -d "$GATE_DENY_BODY")
grep -q '"allow":false' <<< "$GAP2D" && pass "by-policy gate deny read" || fail "by-policy gate deny" "$GAP2D"

kill %1 2>/dev/null; wait 2>/dev/null

printf "Results: \033[32m%d passed\033[0m, \033[31m%d failed\033[0m\n" "$PASS" "$FAIL"
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
