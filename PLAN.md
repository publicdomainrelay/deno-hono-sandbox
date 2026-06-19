# PLAN: compute-deno next steps

What we built + what remains. Ordered by priority. Fan-out markers show
which items can run in parallel via subagents.

## P0 — Blockers: no external caller can use the service

All four P0 items independent. Can fan out 4 subagents in parallel once
PdsClient interface is finalized.

### P0.1 did:web endpoint
- Add `app.get("/.well-known/did.json", ...)` to factory
- Return `did:web:<hostname>` with service entry listing compute NSIDs
- Factory needs `hostname` option (add to `DenoComputeFactoryOptions`)
- Pattern: `hono-pds/lib/hono-factory-atproto-repo-deno/factory.ts` line ~60
- **Fan-out: independent. No deps.**

### P0.2 Service auth verification
- Verify inbound service-auth JWT on 3 XRPC routes
- Check `aud` (did:web of server), `lxm` (NSID), `exp`, signature
- Add `getServiceAuth` endpoint to issue tokens to callers
- Pattern: `did-key-relay/lib/common/did-key-relay/mod.ts` `verifyServiceAuthExt`
- Reuse `SigningKey` interface already in ABC; wrap as JWT signer
- Need keypair for signing tokens. CLI loads from `--attestation-key-path`
- **Fan-out: independent of P0.3/P0.4. Depends on P0.1 for aud value.**

### P0.3 Wire attestation key in CLI
- `cli-args-env.json` already defines `--attestation-key-path`
- `mod.ts` never reads it → signingKey plumbing is dead code
- Load JWK via `loadOrCreateAttestationKeyHex` from `typescript-helpers/lib/utils-attestation-key/`
- Create `SigningKey` impl wrapping `Secp256k1Keypair` from `@atproto/crypto`
- Pass to `manifestStore.register()`, `instanceStore.register()`, factory
- **Fan-out: independent. No deps on P0.1/P0.2/P0.4.**

### P0.4 Wire remote PDS in CLI
- `cli-args-env.json` already has `--pds-url`, `--atproto-handle`, `--atproto-password`
- `mod.ts` always uses in-memory mock PDS
- Add `createRemotePdsClient(pdsUrl, handle, password): PdsClient` in compute-deno-atproto
- Map `createRecord` → `POST /xrpc/com.atproto.repo.createRecord`
- Map `getRecord` → `GET /xrpc/com.atproto.repo.getRecord`
- Use `@atproto/api` Agent for auth session
- Fall back to in-memory when no `--pds-url`
- **Fan-out: independent. No deps on P0.1/P0.2/P0.3.**

---

## P1 — Production integration

### P1.1 Relay subscriber (--relay flag)
- Use existing `createSubscriber` + `createSubscriberFactory` from did-key-relay
- Wrap factory app via `createSubscriberFactory({ app: factory.app })`
- Register with relay dispatcher → service reachable through relay tunnel
- Need cross-repo import: add `../did-key-relay/lib/...` to deno.json imports
- **Fan-out: depends on P0.1 + P0.2. Can run parallel with P0.3/P0.4.**

### P1.2 Publish lexicons
- Run `goat lex publish` from deno-worker-sandbox/
- 7 lexicons ready, all parse + lint passed
- Need `goat account login` on account with authority over `com.publicdomainrelay`
- **Fan-out: independent. Single command. Can run anytime.**

---

## P2 — Cleanup bugs in code we wrote

All P2 items independent. Can fan out 3 subagents in parallel.

### P2.1 parseAtUri dedup
- Same regex+function in `manifest-store.ts` and `instance-store.ts`
- Move to `lib/common/compute-deno-common/types.ts` or new `utils.ts`
- Export, import in both stores
- **Fan-out: trivial. Independent.**

### P2.2 Execute timeout hang
- `instance-runner.ts` execute(): no timeoutMs → Promise hangs forever
- Worker crash without postMessage → Promise hangs forever
- Fix: always race against timeout (default 30s), also listen for worker error
- **Fan-out: small. Independent.**

### P2.3 Shutdown cleanup
- No SIGTERM/SIGINT handler → running workers orphaned on server stop
- Add signal handler in CLI that calls `runner.stopAll()` or iterates workers map
- runner needs `stopAll()` method or expose `list()` to iterate
- **Fan-out: small. Independent.**

### P2.4 config.json
- Current: `{ "description": "..." }` — description string, not config keys
- Replace with flat keys matching `cli-args-env.json` option names
- **Fan-out: trivial. Independent.**

---

## P3 — Test gaps

### P3.1 Execute timeout test
- Test: worker never calls postMessage → execute rejects with WorkerTimeout
- Can use MockRunner or real runner with broken worker script
- **Fan-out: depends on P2.2. Small.**

### P3.2 Service auth rejection test
- Test: request without valid JWT → 401
- Test: request with valid JWT → 200
- **Fan-out: depends on P0.2. Medium.**

### P3.3 Signing key round-trip test
- Test: create manifest with real SigningKey → record.signatures has valid entry
- Verify signature structure: `$type`, key, cid, signature fields present
- **Fan-out: depends on P0.3. Small.**

### P3.4 Remote PDS client test
- Test: HTTP mock server as remote PDS → PdsClient.createRecord/getRecord work
- **Fan-out: depends on P0.4. Medium.**

---

## Fan-out summary

```
Wave 1 (all parallel, 5 agents):
  P0.1  did:web endpoint
  P0.3  attestation key wiring
  P0.4  remote PDS client
  P1.2  lexicon publish
  P2.1+2.3+2.4  cleanup batch (single agent for 3 trivial items)

Wave 2 (parallel, 2 agents):
  P0.2  service auth (needs P0.1)
  P2.2  execute timeout fix

Wave 3 (parallel, 2 agents):
  P1.1  relay subscriber (needs P0.1 + P0.2)
  P3.1+3.3  timeout + signing tests (needs P0.3 + P2.2)

Wave 4 (parallel, 2 agents):
  P3.2  service auth test (needs P0.2)
  P3.4  remote PDS test (needs P0.4)
```

Total: ~14 tasks across 4 waves. 5 agents in wave 1 (heaviest fan-out).
Each agent scoped to single file or small file set.
