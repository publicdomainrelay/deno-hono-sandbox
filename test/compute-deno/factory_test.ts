import { assertEquals, assertExists } from "@std/assert";
import { createDenoComputeFactory } from "@publicdomainrelay/hono-factory-compute-deno-atproto";
import { signComputeServiceAuth, signerFromPrivateKeyHex } from "@publicdomainrelay/compute-deno-atproto";
import type {
  WorkerManifestStore,
  WorkerInstanceStore,
  WorkerInstanceRunner,
} from "@publicdomainrelay/compute-deno-abc";
import type {
  StrongRef,
  WorkerManifestRecord,
  WorkerInstanceRecord,
  WorkerRequest,
  WorkerResponse,
} from "@publicdomainrelay/compute-deno-common";
import { DenoComputeError } from "@publicdomainrelay/compute-deno-common";
import {
  REGISTER_WORKER_MANIFEST_NSID,
  RUN_PERSISTENT_WORKER_INSTANCE_NSID,
  EXECUTE_WORKER_INSTANCE_NSID,
} from "@publicdomainrelay/compute-deno-common";
import { createDenoBundler } from "@publicdomainrelay/sandbox-deno";

function createRequest(path: string, method = "GET", body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return new Request(`http://127.0.0.1/${path}`, init);
}

class InMemoryManifestStore implements WorkerManifestStore {
  #records = new Map<string, WorkerManifestRecord>();
  #seq = 0;

  async register(record: WorkerManifestRecord): Promise<StrongRef> {
    const rkey = `r${(++this.#seq).toString(16).padStart(8, "0")}`;
    const uri = `at://did:plc:test/com.publicdomainrelay.temp.compute.deno.workerManifest/${rkey}`;
    const cid = `bafyrei${rkey}`;
    this.#records.set(uri, record);
    return { $type: "com.atproto.repo.strongRef", uri, cid };
  }

  async get(uri: string): Promise<WorkerManifestRecord | null> {
    return this.#records.get(uri) ?? null;
  }
}

class InMemoryInstanceStore implements WorkerInstanceStore {
  #records = new Map<string, WorkerInstanceRecord>();
  #seq = 0;

  async register(record: WorkerInstanceRecord): Promise<StrongRef> {
    const rkey = `r${(++this.#seq).toString(16).padStart(8, "0")}`;
    const uri = `at://did:plc:test/com.publicdomainrelay.temp.compute.deno.workerInstance/${rkey}`;
    const cid = `bafyrei${rkey}`;
    this.#records.set(uri, record);
    return { $type: "com.atproto.repo.strongRef", uri, cid };
  }

  async get(uri: string): Promise<WorkerInstanceRecord | null> {
    return this.#records.get(uri) ?? null;
  }

  async delete(_uri: string): Promise<void> {}
}

class MockRunner implements WorkerInstanceRunner {
  running = new Map<string, boolean>();
  responses = new Map<string, WorkerResponse>();

  async start(instanceRef: StrongRef, _manifestRef: StrongRef): Promise<void> {
    this.running.set(instanceRef.uri, true);
  }

  async execute(instanceRef: StrongRef, _request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.running.has(instanceRef.uri)) {
      throw new DenoComputeError("Instance not running", 404, "InstanceNotRunning");
    }
    return this.responses.get(instanceRef.uri) ?? { status: 200, headers: {}, body: { ok: true } };
  }

  async stop(instanceRef: StrongRef): Promise<void> {
    this.running.delete(instanceRef.uri);
  }

  async stopAll(): Promise<void> {
    this.running.clear();
  }

  isRunning(instanceRef: StrongRef): boolean {
    return this.running.has(instanceRef.uri);
  }
}

Deno.test("GET /health returns ok", async () => {
  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore(),
    instanceStore: new InMemoryInstanceStore(),
    hostname: "test.local",
    strictAuth: false,
    runner: new MockRunner(),
  });

  const req = createRequest("health");
  const res = await factory.app.fetch(req);
  assertEquals(res.status, 200);
  const data = await res.json() as { status: string };
  assertEquals(data.status, "ok");
});

Deno.test("POST /xrpc/registerWorkerManifest bundles and returns strongRef", async () => {
  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore(),
    instanceStore: new InMemoryInstanceStore(),
    hostname: "test.local",
    strictAuth: false,
    runner: new MockRunner(),
  });

  const source = "export default { fetch: (req: Request) => new Response('ok') };";
  const denoJson = JSON.stringify({ exports: "./mod.ts" });

  const req = createRequest(
    `xrpc/${REGISTER_WORKER_MANIFEST_NSID}`,
    "POST",
    { source, denoJson },
  );
  const res = await factory.app.fetch(req);
  assertEquals(res.status, 200);
  const data = await res.json() as { manifest: { uri: string; cid: string }; bundle: string };
  assertExists(data.manifest.uri);
  assertExists(data.manifest.cid);
  assertEquals(typeof data.bundle, "string");
});

Deno.test("POST /xrpc/registerWorkerManifest rejects missing source", async () => {
  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore(),
    instanceStore: new InMemoryInstanceStore(),
    hostname: "test.local",
    strictAuth: false,
    runner: new MockRunner(),
  });

  const req = createRequest(
    `xrpc/${REGISTER_WORKER_MANIFEST_NSID}`,
    "POST",
    { denoJson: "{}" },
  );
  const res = await factory.app.fetch(req);
  assertEquals(res.status, 400);
});

Deno.test("POST /xrpc/registerWorkerManifest rejects missing denoJson", async () => {
  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore(),
    instanceStore: new InMemoryInstanceStore(),
    hostname: "test.local",
    strictAuth: false,
    runner: new MockRunner(),
  });

  const req = createRequest(
    `xrpc/${REGISTER_WORKER_MANIFEST_NSID}`,
    "POST",
    { source: "const x = 1;" },
  );
  const res = await factory.app.fetch(req);
  assertEquals(res.status, 400);
});

Deno.test("POST /xrpc/registerWorkerManifest rejects non-JSON body", async () => {
  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore(),
    instanceStore: new InMemoryInstanceStore(),
    hostname: "test.local",
    strictAuth: false,
    runner: new MockRunner(),
  });

  const req = new Request(
    `http://127.0.0.1/xrpc/${REGISTER_WORKER_MANIFEST_NSID}`,
    { method: "POST", body: "not json", headers: { "content-type": "text/plain" } },
  );
  const res = await factory.app.fetch(req);
  assertEquals(res.status, 400);
});

Deno.test("POST /xrpc/runPersistentWorkerInstance creates instance", async () => {
  const manifestStore = new InMemoryManifestStore();
  const instanceStore = new InMemoryInstanceStore();
  const runner = new MockRunner();

  const factory = createDenoComputeFactory({
    manifestStore,
    instanceStore,
    hostname: "test.local",
    strictAuth: false,
    runner,
  });

  const manifest = await manifestStore.register({
    lock: "{}",
    json: "{}",
    bundle: "export default { fetch: () => new Response('ok') };",
  });

  const req = createRequest(
    `xrpc/${RUN_PERSISTENT_WORKER_INSTANCE_NSID}`,
    "POST",
    { manifest: { uri: manifest.uri, cid: manifest.cid } },
  );
  const res = await factory.app.fetch(req);
  assertEquals(res.status, 200);
  const data = await res.json() as { instance: { uri: string; cid: string } };
  assertExists(data.instance.uri);
  assertExists(data.instance.cid);
  const instanceRef = { ...data.instance, $type: "com.atproto.repo.strongRef" as const };
  assertEquals(runner.isRunning(instanceRef), true);
});

Deno.test("POST /xrpc/runPersistentWorkerInstance rejects missing manifest", async () => {
  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore(),
    instanceStore: new InMemoryInstanceStore(),
    hostname: "test.local",
    strictAuth: false,
    runner: new MockRunner(),
  });

  const req = createRequest(
    `xrpc/${RUN_PERSISTENT_WORKER_INSTANCE_NSID}`,
    "POST",
    {},
  );
  const res = await factory.app.fetch(req);
  assertEquals(res.status, 400);
});

Deno.test("POST /xrpc/executeWorkerInstance forwards request to runner", async () => {
  const manifestStore = new InMemoryManifestStore();
  const instanceStore = new InMemoryInstanceStore();
  const runner = new MockRunner();

  const factory = createDenoComputeFactory({
    manifestStore,
    instanceStore,
    hostname: "test.local",
    strictAuth: false,
    runner,
  });

  const manifest = await manifestStore.register({
    lock: "{}",
    json: "{}",
    bundle: "export default { fetch: () => new Response('ok') };",
  });
  const instance = await instanceStore.register({ manifest });
  runner.running.set(instance.uri, true);

  const req = createRequest(
    `xrpc/${EXECUTE_WORKER_INSTANCE_NSID}`,
    "POST",
    {
      instance: { uri: instance.uri, cid: instance.cid },
      request: { method: "GET", path: "/echo" },
    },
  );
  const res = await factory.app.fetch(req);
  assertEquals(res.status, 200);
  const data = await res.json() as { status: number; body: unknown };
  assertEquals(data.status, 200);
});

Deno.test("POST /xrpc/executeWorkerInstance rejects missing instance", async () => {
  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore(),
    instanceStore: new InMemoryInstanceStore(),
    hostname: "test.local",
    strictAuth: false,
    runner: new MockRunner(),
  });

  const req = createRequest(
    `xrpc/${EXECUTE_WORKER_INSTANCE_NSID}`,
    "POST",
    { request: { method: "GET", path: "/" } },
  );
  const res = await factory.app.fetch(req);
  assertEquals(res.status, 400);
});

Deno.test("POST /xrpc/executeWorkerInstance rejects missing request", async () => {
  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore(),
    instanceStore: new InMemoryInstanceStore(),
    hostname: "test.local",
    strictAuth: false,
    runner: new MockRunner(),
  });

  const req = createRequest(
    `xrpc/${EXECUTE_WORKER_INSTANCE_NSID}`,
    "POST",
    { instance: { uri: "at://did:plc:test/x/y", cid: "bafyreiabc" } },
  );
  const res = await factory.app.fetch(req);
  assertEquals(res.status, 400);
});

Deno.test("POST /xrpc/registerWorkerManifest returns 401 without auth header when strictAuth", async () => {
  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore(),
    instanceStore: new InMemoryInstanceStore(),
    hostname: "localhost",
    strictAuth: true,
    runner: new MockRunner(),
  });

  const req = createRequest(
    `xrpc/${REGISTER_WORKER_MANIFEST_NSID}`,
    "POST",
    { source: "export function handle(e) { return { status: 200, headers: {}, body: e }; }", denoJson: "{}" },
  );
  const res = await factory.app.fetch(req);
  assertEquals(res.status, 401);
  const data = await res.json() as { error: string };
  assertEquals(data.error, "AuthRequired");
});

Deno.test("POST /xrpc/registerWorkerManifest returns 401 with expired JWT", async () => {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  const sk = await signerFromPrivateKeyHex(hex);

  const expiredToken = await signComputeServiceAuth(
    sk,
    "did:web:localhost",
    REGISTER_WORKER_MANIFEST_NSID,
    -60,
  );

  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore(),
    instanceStore: new InMemoryInstanceStore(),
    hostname: "localhost",
    strictAuth: true,
    runner: new MockRunner(),
  });

  const req = new Request(
    `http://localhost/xrpc/${REGISTER_WORKER_MANIFEST_NSID}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${expiredToken}`,
      },
      body: JSON.stringify({ source: "export function handle(e) { return { status: 200, headers: {}, body: e }; }", denoJson: "{}" }),
    },
  );
  const res = await factory.app.fetch(req);
  assertEquals(res.status, 401);
  const data = await res.json() as { error: string };
  assertEquals(data.error, "AuthRequired");
});

Deno.test("POST /xrpc/registerWorkerManifest returns 200 with valid JWT when strictAuth localhost", async () => {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  const sk = await signerFromPrivateKeyHex(hex);

  const token = await signComputeServiceAuth(
    sk,
    "did:web:localhost",
    REGISTER_WORKER_MANIFEST_NSID,
  );

  const mockBundler = {
    async bundle() {
      return { bundleJs: "self.onmessage = () => { self.postMessage({ status: 200, headers: {}, body: {} }); };", stdout: "", stderr: "" };
    },
    async bundleTar() {
      return { bundleJs: "self.onmessage = () => {};", stdout: "", stderr: "" };
    },
  };

  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore(),
    instanceStore: new InMemoryInstanceStore(),
    hostname: "localhost",
    strictAuth: true,
    bundler: mockBundler,
    runner: new MockRunner(),
  });

  const req = new Request(
    `http://localhost/xrpc/${REGISTER_WORKER_MANIFEST_NSID}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "host": "localhost",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ source: "self.onmessage = () => { self.postMessage({ status: 200, headers: {}, body: {} }); };", denoJson: "{}" }),
    },
  );
  const res = await factory.app.fetch(req);
  assertEquals(res.status, 200);
});
