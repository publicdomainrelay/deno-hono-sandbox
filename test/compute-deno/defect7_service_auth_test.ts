import { assert, assertEquals } from "@std/assert";
import {
  verifyComputeServiceAuth,
} from "@publicdomainrelay/compute-deno-atproto";
import { createDenoComputeFactory } from "@publicdomainrelay/hono-factory-compute-deno-atproto";
import type {
  WorkerInstanceRunner,
  WorkerInstanceStore,
  WorkerManifestStore,
} from "@publicdomainrelay/compute-deno-abc";
import type {
  StrongRef,
  WorkerInstanceRecord,
  WorkerManifestRecord,
  WorkerRequest,
  WorkerResponse,
} from "@publicdomainrelay/compute-deno-common";
import { REGISTER_WORKER_MANIFEST_NSID } from "@publicdomainrelay/compute-deno-common";

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function forgedToken(iss: string, aud: string, lxm: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url(JSON.stringify({ alg: "ES256K", typ: "JWT" }))}.${
    b64url(
      JSON.stringify({
        iss,
        aud,
        lxm,
        iat: now,
        exp: now + 3600,
        jti: "defect7",
      }),
    )
  }.not-a-signature`;
}

// verifySignatureUtf8 must never be reached on either arm, so "not-a-signature"
// is never the reason these pass.
Deno.test("defect7: the signature check must not be skippable from the request", async () => {
  const lxm = REGISTER_WORKER_MANIFEST_NSID;

  let byIssuer = "accepted";
  try {
    const r = await verifyComputeServiceAuth(
      `Bearer ${forgedToken("did:plc:local", "did:web:compute.example", lxm)}`,
      "compute.example",
      lxm,
      true,
    );
    byIssuer = JSON.stringify(r);
  } catch (err) {
    byIssuer = `rejected: ${String(err)}`;
  }
  console.log("[defect7] iss=did:plc:local, Host=compute.example ->", byIssuer);

  let byHost = "accepted";
  try {
    const r = await verifyComputeServiceAuth(
      `Bearer ${forgedToken("did:key:zNotAKey", "did:web:localhost", lxm)}`,
      "localhost",
      lxm,
      true,
    );
    byHost = JSON.stringify(r);
  } catch (err) {
    byHost = `rejected: ${String(err)}`;
  }
  console.log("[defect7] iss=did:key:zNotAKey, Host=localhost ->", byHost);

  assertEquals(
    byIssuer.startsWith("rejected"),
    true,
    "an unsigned token whose iss is the literal did:plc:local was accepted, so " +
      "the caller chose both the identity AND whether it is verified",
  );
  assertEquals(
    byHost.startsWith("rejected"),
    true,
    "an unsigned token was accepted because the request Host header was " +
      "localhost, so the caller chose whether the signature is checked",
  );
});

// ── reachability: the unverified iss reaches a route ────────────────────────

const mockBundler = {
  async bundle() {
    return { bundleJs: "self.onmessage = () => {};", stdout: "", stderr: "" };
  },
  async bundleTar() {
    return { bundleJs: "self.onmessage = () => {};", stdout: "", stderr: "" };
  },
};

class InMemoryManifestStore implements WorkerManifestStore {
  #records = new Map<string, WorkerManifestRecord>();
  #seq = 0;
  async register(record: WorkerManifestRecord): Promise<StrongRef> {
    const rkey = `r${(++this.#seq).toString(16).padStart(8, "0")}`;
    const uri = `at://did:plc:test/com.publicdomainrelay.temp.compute.deno.workerManifest/${rkey}`;
    this.#records.set(uri, record);
    return { $type: "com.atproto.repo.strongRef", uri, cid: `bafyrei${rkey}` };
  }
  async get(uri: string): Promise<WorkerManifestRecord | null> {
    return this.#records.get(uri) ?? null;
  }
}

class InMemoryInstanceStore implements WorkerInstanceStore {
  async register(_record: WorkerInstanceRecord): Promise<StrongRef> {
    return { $type: "com.atproto.repo.strongRef", uri: "at://x/y", cid: "b" };
  }
  async get(_uri: string): Promise<WorkerInstanceRecord | null> {
    return null;
  }
  async delete(_uri: string): Promise<void> {}
}

class MockRunner implements WorkerInstanceRunner {
  async start(_i: StrongRef, _m: StrongRef): Promise<void> {}
  async execute(_i: StrongRef, _r: WorkerRequest): Promise<WorkerResponse> {
    return { status: 200, headers: {}, body: { ok: true } };
  }
  async stop(_i: StrongRef): Promise<void> {}
  async stopAll(): Promise<void> {}
  isRunning(_i: StrongRef): boolean {
    return false;
  }
}

Deno.test("defect7: an unsigned token must not register a worker manifest", async () => {
  const factory = createDenoComputeFactory({
    manifestStore: new InMemoryManifestStore(),
    instanceStore: new InMemoryInstanceStore(),
    hostname: "compute.example",
    strictAuth: true,
    bundler: mockBundler,
    runner: new MockRunner(),
  });

  const res = await factory.app.request(
    `/xrpc/${REGISTER_WORKER_MANIFEST_NSID}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "compute.example",
        authorization:
          `Bearer ${forgedToken("did:plc:local", "did:web:compute.example", REGISTER_WORKER_MANIFEST_NSID)}`,
      },
      body: JSON.stringify({ source: "self.onmessage = () => {};", denoJson: "{}" }),
    },
  );
  const body = await res.text();
  console.log("[defect7] register manifest with an unsigned token ->", res.status, body);

  assertEquals(res.status, 401, "an unsigned service-auth token reached the handler");
  assert(true);
});
