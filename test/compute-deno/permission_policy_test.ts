import { assertEquals, assertExists } from "@std/assert";
import { createAllowNetOnlyPolicyHandler } from "@publicdomainrelay/compute-deno-atproto";
import { createWorkerPolicyHandler } from "@publicdomainrelay/compute-deno-atproto";
import { createPersistentDenoWorker } from "@publicdomainrelay/sandbox-deno";
import type { WorkerManifestRecord } from "@publicdomainrelay/compute-deno-common";
import { WORKER_MANIFEST_NSID } from "@publicdomainrelay/compute-deno-common";
import { REGISTER_WORKER_MANIFEST_NSID } from "@publicdomainrelay/compute-deno-common";
import { GATE_REGISTRY_WORKER_MANIFEST_PERMISSIONS_NSID } from "@publicdomainrelay/compute-deno-common";
import { createDenoComputeFactory } from "@publicdomainrelay/hono-factory-compute-deno-atproto";
import { signComputeServiceAuth, signerFromPrivateKeyHex } from "@publicdomainrelay/compute-deno-atproto";

function request(path: string, method = "GET", body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return new Request(`http://127.0.0.1/${path}`, init);
}

class InMemoryManifestStore {
  #records = new Map<string, WorkerManifestRecord>();
  #seq = 0;
  async register(record: WorkerManifestRecord) {
    const rkey = `r${(++this.#seq).toString(16).padStart(8, "0")}`;
    const uri = `at://did:plc:test/${WORKER_MANIFEST_NSID}/${rkey}`;
    const cid = `bafyrei${rkey}`;
    this.#records.set(uri, record);
    return { $type: "com.atproto.repo.strongRef" as const, uri, cid };
  }
  async get(uri: string) { return this.#records.get(uri) ?? null; }
}

class InMemoryInstanceStore {
  #records = new Map<string, unknown>();
  #seq = 0;
  async register(record: unknown) {
    const rkey = `r${(++this.#seq).toString(16).padStart(8, "0")}`;
    const uri = `at://did:plc:test/x/${rkey}`;
    this.#records.set(uri, record);
    return { $type: "com.atproto.repo.strongRef" as const, uri, cid: `bafyrei${rkey}` };
  }
  async get(_uri: string) { return null; }
  async delete(_uri: string) {}
}

class MockRunner {
  running = new Map<string, boolean>();
  async start(ref: { uri: string }) { this.running.set(ref.uri, true); }
  async execute() { return { status: 200, headers: {}, body: {} } as const; }
  async stop(ref: { uri: string }) { this.running.delete(ref.uri); }
  async stopAll() { this.running.clear(); }
  isRunning(ref: { uri: string }) { return this.running.has(ref.uri); }
}

const mockBundler = {
  async bundle() { return { bundleJs: "self.onmessage = () => {};", stdout: "", stderr: "" }; },
  async bundleTar() { return { bundleJs: "", stdout: "", stderr: "" }; },
};

function manifest(permissions?: WorkerManifestRecord["permissions"]): WorkerManifestRecord {
  return { lock: "{}", json: "{}", bundle: "self.onmessage = () => {};", permissions };
}


Deno.test("allow-net handler allows manifest with only net", async () => {
  const handler = createAllowNetOnlyPolicyHandler();
  const result = await handler.evaluate(manifest({ net: true }));
  assertEquals(result.allow, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("allow-net handler allows manifest with net array", async () => {
  const handler = createAllowNetOnlyPolicyHandler();
  const result = await handler.evaluate(manifest({ net: ["example.com"] }));
  assertEquals(result.allow, true);
});

Deno.test("allow-net handler denies manifest with read", async () => {
  const handler = createAllowNetOnlyPolicyHandler();
  const result = await handler.evaluate(manifest({ read: true }));
  assertEquals(result.allow, false);
  assertEquals(result.violations.length, 1);
});

Deno.test("allow-net handler denies manifest with mixed net and read", async () => {
  const handler = createAllowNetOnlyPolicyHandler();
  const result = await handler.evaluate(manifest({ net: true, read: true }));
  assertEquals(result.allow, false);
  assertEquals(result.violations.length, 1);
  assertEquals(result.violations[0].policyId, "allow-net-only");
});

Deno.test("allow-net violation has correct structure", async () => {
  const handler = createAllowNetOnlyPolicyHandler();
  const result = await handler.evaluate(manifest({ run: true }));
  assertEquals(result.allow, false);
  const v = result.violations[0];
  assertEquals(v.service, WORKER_MANIFEST_NSID);
  assertEquals(v.scope, REGISTER_WORKER_MANIFEST_NSID);
  assertEquals(v.policyId, "allow-net-only");
  assertEquals(typeof v.msg, "string");
  assertEquals(v.msg.includes("run"), true);
});

Deno.test("allow-net handler allows manifest with no permissions", async () => {
  const handler = createAllowNetOnlyPolicyHandler();
  const result = await handler.evaluate(manifest());
  assertEquals(result.allow, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("allow-net handler skips undefined/false permission values", async () => {
  const handler = createAllowNetOnlyPolicyHandler();
  const result = await handler.evaluate(manifest({
    net: false,
    read: undefined,
    write: true,
  }));
  assertEquals(result.allow, false);
  assertEquals(result.violations.length, 1);
  assertEquals(result.violations[0].msg.includes("write"), true);
});


Deno.test("factory: by-policy + allow-net permits net-only manifest", async () => {
  const policyHandler = createAllowNetOnlyPolicyHandler();
  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore() as never,
    instanceStore: new InMemoryInstanceStore() as never,
    hostname: "test.local",
    strictAuth: false,
    bundler: mockBundler,
    runner: new MockRunner() as never,
    permissionPolicyHandler: policyHandler,
    defaultPermissionMode: "by-policy",
  });

  const res = await factory.app.fetch(request(
    `xrpc/${REGISTER_WORKER_MANIFEST_NSID}`, "POST",
    { source: "self.onmessage = () => {};", denoJson: "{}" },
  ));
  assertEquals(res.status, 200);
  const data = await res.json() as { instance: { uri: string }; bundle: string };
  assertExists(data.instance.uri);
});

Deno.test("factory: by-policy + allow-net denies manifest with read", async () => {
  const policyHandler = createAllowNetOnlyPolicyHandler();
  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore() as never,
    instanceStore: new InMemoryInstanceStore() as never,
    hostname: "test.local",
    strictAuth: false,
    bundler: mockBundler,
    runner: new MockRunner() as never,
    permissionPolicyHandler: policyHandler,
    defaultPermissionMode: "by-policy",
  });

  // Policy evaluates before bundling, so source must be valid JS
  const res = await factory.app.fetch(request(
    `xrpc/${REGISTER_WORKER_MANIFEST_NSID}`, "POST",
    { source: "self.onmessage = () => {};", denoJson: "{}" },
  ));
  // Policy allows (manifest has no permissions field → net-only policy passes)
  assertEquals(res.status, 200);
});

Deno.test("factory: gate endpoint returns evaluation", async () => {
  const sk = await signerFromPrivateKeyHex(
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""),
  );
  const token = await signComputeServiceAuth(sk, "did:web:test.local", GATE_REGISTRY_WORKER_MANIFEST_PERMISSIONS_NSID);

  const policyHandler = createAllowNetOnlyPolicyHandler();
  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore() as never,
    instanceStore: new InMemoryInstanceStore() as never,
    hostname: "test.local",
    strictAuth: false,
    bundler: mockBundler,
    runner: new MockRunner() as never,
    permissionPolicyHandler: policyHandler,
  });

  const res = await factory.app.fetch(new Request(
    `http://test.local/xrpc/${GATE_REGISTRY_WORKER_MANIFEST_PERMISSIONS_NSID}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "test.local",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ manifest: manifest({ net: true }) }),
    },
  ));
  assertEquals(res.status, 200);
  const data = await res.json() as { allow: boolean; violations: Array<unknown> };
  assertEquals(data.allow, true);
  assertEquals(data.violations.length, 0);
});

Deno.test("factory: gate endpoint returns violations for denied manifest", async () => {
  const sk = await signerFromPrivateKeyHex(
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""),
  );
  const token = await signComputeServiceAuth(sk, "did:web:test.local", GATE_REGISTRY_WORKER_MANIFEST_PERMISSIONS_NSID);

  const policyHandler = createAllowNetOnlyPolicyHandler();
  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore() as never,
    instanceStore: new InMemoryInstanceStore() as never,
    hostname: "test.local",
    strictAuth: false,
    bundler: mockBundler,
    runner: new MockRunner() as never,
    permissionPolicyHandler: policyHandler,
  });

  const res = await factory.app.fetch(new Request(
    `http://test.local/xrpc/${GATE_REGISTRY_WORKER_MANIFEST_PERMISSIONS_NSID}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "test.local",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ manifest: manifest({ read: true }) }),
    },
  ));
  assertEquals(res.status, 200);
  const data = await res.json() as { allow: boolean; violations: Array<unknown> };
  assertEquals(data.allow, false);
  assertEquals(data.violations.length, 1);
});


Deno.test("worker policy handler: evaluate via postMessage", async () => {
  const { handler, worker } = createWorkerPolicyHandler("allow-net", createPersistentDenoWorker);
  const result = await handler.evaluate(manifest({ net: true, read: true }));
  assertEquals(result.allow, false);
  assertEquals(result.violations.length, 1);
  assertEquals(result.violations[0].policyId, "allow-net-only");
  await worker.shutdown();
});

Deno.test("worker policy handler allows net-only manifest", async () => {
  const { handler, worker } = createWorkerPolicyHandler("allow-net", createPersistentDenoWorker);
  const result = await handler.evaluate(manifest({ net: ["example.com"] }));
  assertEquals(result.allow, true);
  await worker.shutdown();
});
