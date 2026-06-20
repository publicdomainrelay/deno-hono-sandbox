# deno-worker-sandbox

Two concepts: **sandbox** (ephemeral Deno Worker execution) and **compute-deno**
(AT Protocol XRPC service for persistent worker lifecycle). Both ABC-layered.

## Architecture

```
lib/common/sandbox-common/     shared types, SandboxPermissions, SandboxError
lib/common/compute-deno-common/ NSIDs, wire types, DenoComputeError
lib/abc/sandbox/               Sandbox, Bundler, PersistentWorker interfaces
lib/abc/compute-deno/          SigningKey, stores, runner, PermissionPolicyHandler
lib/sandbox-deno/              Deno Worker impl, bundler, persistent worker
lib/compute-deno-atproto/      PDS-backed stores, DAG-CBOR attestation, policy handlers
lib/hono-factory-sandbox-deno/ Hono routes for /execute, /bundle, /bundleTar, /exec
lib/hono-factory-compute-deno-atproto/ Hono routes for XRPC procedures, gate endpoint
hono-sandbox/                  CLI: ephemeral sandbox server
hono-compute-deno/             CLI: compute XRPC server
```

Deps: `common ← abc ← impl ← factory ← CLI`. No cycles.

## Quick start

### Sandbox server (ephemeral workers)

```sh
deno task dev
# → http://127.0.0.1:2584
```

Custom port:

```sh
PORT=3000 deno task dev
```

### Compute server (AT Protocol XRPC)

```sh
deno task dev:compute
# → http://127.0.0.1:2585
```

## Sandbox API

All routes return JSON. Errors return `{ error, message, status }`.

### Health

```sh
curl http://127.0.0.1:2584/health
# → {"status":"ok"}
```

### Execute code

Run JS in isolated Worker. Console captured. Return value returned.

```sh
curl -s -X POST http://127.0.0.1:2584/execute \
  -H 'content-type: application/json' \
  -d '{"code":"console.log(\"hello\"); return 42;"}'
```

```json
{"stdout":"hello\n","stderr":"","exitCode":0,"timedOut":false,"result":42}
```

Timeout kills Worker:

```sh
curl -s -X POST http://127.0.0.1:2584/execute \
  -H 'content-type: application/json' \
  -d '{"code":"while(true){}","timeoutMs":100}'
# → {"stdout":"","stderr":"execution timed out","exitCode":1,"timedOut":true}
```

### Bundle source

Validate source + deno.json with `deno check`. Returns validated source as
`bundleJs`.

```sh
curl -s -X POST http://127.0.0.1:2584/bundle \
  -H 'content-type: application/json' \
  -d '{"denoJson":"{\"imports\":{}}","source":"console.log(\"validated\");"}'
```

```json
{"bundleJs":"console.log(\"validated\");","stdout":"","stderr":""}
```

With deno.lock:

```sh
curl -s -X POST http://127.0.0.1:2584/bundle \
  -H 'content-type: application/json' \
  -d '{"denoJson":"{\"imports\":{\"@std/assert\":\"jsr:@std/assert@^1\"}}","denoLock":"...","source":"import { assertEquals } from \"@std/assert\"; assertEquals(1, 1);"}'
```

### Bundle tar

Upload base64-encoded tar archive. Must have `deno.json` at root. Auto-detects
entrypoint (`exports` → `main.ts` → `mod.ts` → `index.ts`). Validates with
`deno check`.

```sh
mkdir /tmp/myproject
echo '{"imports":{}}' > /tmp/myproject/deno.json
echo 'console.log("from tar");' > /tmp/myproject/main.ts
tar cf - -C /tmp/myproject . | base64 -w0 > /tmp/project.b64

curl -s -X POST http://127.0.0.1:2584/bundleTar \
  -H 'content-type: application/json' \
  -d "{\"tarBase64\":\"$(cat /tmp/project.b64)\"}"
```

```json
{"bundleJs":"console.log(\"from tar\");","stdout":"","stderr":""}
```

### Exec bundle

Run pre-bundled JS in sandbox. Chain with `/bundle`:

```sh
curl -s -X POST http://127.0.0.1:2584/bundle \
  -H 'content-type: application/json' \
  -d '{"denoJson":"{\"imports\":{}}","source":"return 99;"}' \
  | jq -r '.bundleJs' \
  | xargs -I{} curl -s -X POST http://127.0.0.1:2584/exec \
    -H 'content-type: application/json' \
    -d "{\"bundleJs\":\"{}\"}"
```

```json
{"stdout":"","stderr":"","exitCode":0,"timedOut":false,"result":99}
```

## Compute XRPC API

All procedures at `/xrpc/<NSID>`. Service auth required unless `strictAuth: false`.

NSIDs:
- `com.publicdomainrelay.temp.compute.deno.registerWorkerManifest`
- `com.publicdomainrelay.temp.compute.deno.runPersistentWorkerInstance`
- `com.publicdomainrelay.temp.compute.deno.executeWorkerInstance`
- `com.publicdomainrelay.temp.compute.deno.gateRegistryWorkerManifestPermissions`

### Register worker manifest

Bundles source, creates signed manifest + instance on PDS. Returns instance ref.

```sh
curl -s -X POST http://127.0.0.1:2585/xrpc/com.publicdomainrelay.temp.compute.deno.registerWorkerManifest \
  -H 'content-type: application/json' \
  -d '{
    "source": "export function handle(e) { return { status: 200, headers: {}, body: e }; }",
    "denoJson": "{\"exports\":\"./mod.ts\"}"
  }'
```

```json
{
  "instance": {"$type":"com.atproto.repo.strongRef","uri":"at://did:plc:local/...","cid":"bafyrei..."},
  "bundle": "export function handle(e) { return { status: 200, headers: {}, body: e }; }"
}
```

Register with persistent worker (starts immediately):

```sh
curl -s -X POST http://127.0.0.1:2585/xrpc/com.publicdomainrelay.temp.compute.deno.registerWorkerManifest \
  -H 'content-type: application/json' \
  -d '{
    "source": "export function handle(e) { return { status: 200, headers: {}, body: e }; }",
    "denoJson": "{\"exports\":\"./mod.ts\"}",
    "persistent": true
  }'
```

### Run persistent worker instance

Start existing manifest as persistent worker:

```sh
curl -s -X POST http://127.0.0.1:2585/xrpc/com.publicdomainrelay.temp.compute.deno.runPersistentWorkerInstance \
  -H 'content-type: application/json' \
  -d '{
    "manifest": {
      "uri": "at://did:plc:local/com.publicdomainrelay.temp.compute.deno.workerManifest/r00000001",
      "cid": "bafyrei..."
    }
  }'
```

```json
{
  "instance": {"$type":"com.atproto.repo.strongRef","uri":"at://...","cid":"bafyrei..."}
}
```

### Execute worker instance

Send request to running persistent worker:

```sh
curl -s -X POST http://127.0.0.1:2585/xrpc/com.publicdomainrelay.temp.compute.deno.executeWorkerInstance \
  -H 'content-type: application/json' \
  -d '{
    "instance": {"uri":"at://...", "cid":"bafyrei..."},
    "request": {"method":"GET", "path":"/echo"}
  }'
```

```json
{"status":200,"headers":{},"body":{}}
```

## Permissions

Worker manifests declare Deno permissions. Three modes:

| Mode | Description |
|------|-------------|
| `deny-all` | Strip all permissions (default) |
| `allow-all` | Pass all declared permissions through |
| `by-policy` | Evaluate via policy handler |

Worker manifest `permissions` field matches Deno's `PermissionOptionsObject`:

```json
{
  "permissions": {
    "net": true,
    "read": ["./data"],
    "env": ["API_KEY"]
  }
}
```

### Built-in policy handler: allow-net

Only `net` permission permitted. All others denied.

```sh
deno task dev:compute -- \
  --permission-mode by-policy \
  --policy-handler-built-in allow-net
```

Worker IPC (default, no HTTP overhead):

```sh
deno task dev:compute -- \
  --permission-mode by-policy \
  --policy-handler-built-in allow-net
```

Loopback HTTP (ephemeral service on random port):

```sh
deno task dev:compute -- \
  --permission-mode by-policy \
  --policy-handler-built-in allow-net \
  --policy-handler-loopback
```

### Remote policy handler (AT Protocol service proxying)

Call external gate service via service auth JWT:

```sh
deno task dev:compute -- \
  --permission-mode by-policy \
  --policy-handler-service did:web:policy.example.com#gatePermissions \
  --attestation-key-path ./key.jwk
```

### Policy rejected response

When `by-policy` denies registration → 403:

```json
{
  "error": "PermissionDenied",
  "message": "Permission policy denied registration",
  "violations": [
    {
      "service": "com.publicdomainrelay.temp.compute.deno.workerManifest",
      "scope": "com.publicdomainrelay.temp.compute.deno.registerWorkerManifest",
      "policyId": "allow-net-only",
      "msg": "Permission \"read\" not allowed; only net is permitted by built-in policy"
    }
  ]
}
```

## Gate endpoint

Exposes policy evaluation for other services:

```sh
curl -s -X POST http://127.0.0.1:2585/xrpc/com.publicdomainrelay.temp.compute.deno.gateRegistryWorkerManifestPermissions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <service-auth-jwt>' \
  -d '{
    "manifest": {
      "lock": "{}",
      "json": "{}",
      "bundle": "self.onmessage = () => {}",
      "permissions": {"net": true, "read": true}
    }
  }'
```

```json
{
  "allow": false,
  "violations": [
    {
      "service": "com.publicdomainrelay.temp.compute.deno.workerManifest",
      "scope": "com.publicdomainrelay.temp.compute.deno.registerWorkerManifest",
      "policyId": "allow-net-only",
      "msg": "Permission \"read\" not allowed; only net is permitted by built-in policy"
    }
  ]
}
```

## Attestation

Manifest and instance records carry DAG-CBOR badge.blue attestations. Attestation
key auto-generated at `./attestation-key.jwk`. Signatures stored in record
`signatures[]` field. CID computed via DAG-CBOR encode → SHA-256 → CIDv1 (codec
0x71). Interoperable with `network.attested.*` verifiers.

## Run tests

```sh
deno task test
```

Subset:

```sh
deno task test:sandbox       # sandbox tests only
deno task test:compute       # compute-deno tests only (35 tests)
deno task test:integration   # integration smoke test
```

## CLI options

### hono-sandbox

```
PORT=2584                     port
HOSTNAME=127.0.0.1            bind hostname
TIMEOUT_MS                    default execution timeout
```

### hono-compute-deno

```
PORT=2585                     port
HOSTNAME=127.0.0.1            bind hostname
UNIX_SOCKET                   unix socket path (overrides port)
PDS_URL                       remote PDS base URL
ATPROTO_HANDLE                PDS auth handle
ATPROTO_PASSWORD              PDS auth password
ATTESTATION_KEY_PATH          secp256k1 JWK path (default: ./attestation-key.jwk)
COMPUTE_DENO_TIMEOUT_MS       default execution timeout
RELAY                         enable relay subscriber mode
RELAY_DISPATCHER_HOST         relay dispatcher hostname
PERMISSION_MODE               deny-all | allow-all | by-policy (default: deny-all)
POLICY_HANDLER_BUILT_IN       built-in handler name (e.g., allow-net)
POLICY_HANDLER_LOOPBACK       run built-in handler as loopback HTTP
POLICY_HANDLER_SERVICE        remote handler: did:web:<host>#<serviceId>
```

## Requirements

Deno >= 2. Permissions: `--allow-env --allow-read --allow-write --allow-run
--allow-net --unstable-worker-options`.
