# deno-worker-sandbox

Deno execution sandbox. Isolated Workers. Hono HTTP wrapper. ABC-layered.

## Start

```sh
deno task dev
# → http://127.0.0.1:2584
```

Custom port:

```sh
PORT=3000 deno task dev
```

## Routes

### Health

```sh
curl http://127.0.0.1:2584/health
# → {"status":"ok"}
```

### Execute code

Run arbitrary JS in isolated Worker. Console output captured. Return value
returned.

```sh
curl -s -X POST http://127.0.0.1:2584/execute \
  -H 'content-type: application/json' \
  -d '{"code":"console.log(\"hello\"); return 42;"}'
```

```json
{
  "stdout": "hello\n",
  "stderr": "",
  "exitCode": 0,
  "timedOut": false,
  "result": 42
}
```

Timeouts kill Worker and recreate:

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
  -d '{
    "denoJson": "{\"imports\":{}}",
    "source": "console.log(\"validated\");"
  }'
```

```json
{
  "bundleJs": "console.log(\"validated\");",
  "stdout": "",
  "stderr": ""
}
```

With deno.lock:

```sh
curl -s -X POST http://127.0.0.1:2584/bundle \
  -H 'content-type: application/json' \
  -d '{
    "denoJson": "{\"imports\":{\"@std/assert\":\"jsr:@std/assert@^1\"}}",
    "denoLock": "...",
    "source": "import { assertEquals } from \"@std/assert\"; assertEquals(1, 1);"
  }'
```

### Bundle tar

Upload base64-encoded tar archive of full project. Must have `deno.json` at
root. Auto-detects entrypoint (`exports` → `main.ts` → `mod.ts` → `index.ts`).
Validates entire project with `deno check`.

```sh
# Create project
mkdir /tmp/myproject
echo '{"imports":{}}' > /tmp/myproject/deno.json
echo 'console.log("from tar");' > /tmp/myproject/main.ts

# Tar + base64
tar cf - -C /tmp/myproject . | base64 -w0 > /tmp/project.b64

# Send
curl -s -X POST http://127.0.0.1:2584/bundleTar \
  -H 'content-type: application/json' \
  -d "{\"tarBase64\":\"$(cat /tmp/project.b64)\"}"
```

```json
{
  "bundleJs": "console.log(\"from tar\");",
  "stdout": "",
  "stderr": ""
}
```

### Exec bundle

Run pre-bundled JS from `/bundle` or `/bundleTar` in sandbox.

```sh
# Bundle first
BUNDLE=$(curl -s -X POST http://127.0.0.1:2584/bundle \
  -H 'content-type: application/json' \
  -d '{"denoJson":"{\"imports\":{}}","source":"return 99;"}')

BUNDLE_JS=$(echo "$BUNDLE" | python3 -c "import sys,json; print(json.load(sys.stdin)['bundleJs'])")

# Exec
curl -s -X POST http://127.0.0.1:2584/exec \
  -H 'content-type: application/json' \
  -d "{\"bundleJs\":$(echo "$BUNDLE_JS" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")}"
```

```json
{
  "stdout": "",
  "stderr": "",
  "exitCode": 0,
  "timedOut": false,
  "result": 99
}
```

Piped one-liner (jq):

```sh
curl -s -X POST http://127.0.0.1:2584/bundle \
  -H 'content-type: application/json' \
  -d '{"denoJson":"{\"imports\":{}}","source":"return 99;"}' \
  | jq -r '.bundleJs' \
  | xargs -0 -I{} curl -s -X POST http://127.0.0.1:2584/exec \
    -H 'content-type: application/json' \
    -d "{\"bundleJs\":{}}"
```

## Errors

All routes return JSON error on failure:

```json
{"error": "\"code\" field is required"}
```

Bundle routes on invalid source:

```json
{"error": "bundle failed", "bundleJs": "", "stdout": "", "stderr": "..."}
```

HTTP status: 400 (client error), 500 (server/internal).

## Run tests

```sh
deno task test
# 24 tests
```

## Structure

```
lib/common/          leaf utilities
lib/abc/sandbox/     interfaces + pure state
lib/sandbox-deno/    Deno Worker impl + bundler
lib/hono-factory-sandbox-deno/  Hono routes
hono-sandbox/        CLI entrypoint
```

ABC-layered. Dependency flow: `common ← abc ← impl ← factory ← CLI`.

## Requirements

Deno >= 2. Permissions: `--allow-env --allow-read --allow-write --allow-run
--allow-net --unstable-worker-options`.
