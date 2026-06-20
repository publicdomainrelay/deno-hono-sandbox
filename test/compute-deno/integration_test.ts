import { assertEquals, assertExists } from "@std/assert";
import { createDenoComputeFactory } from "@publicdomainrelay/hono-factory-compute-deno-atproto";
import {
  createDenoComputeManifestStore,
  createDenoComputeInstanceStore,
  createDenoComputeInstanceRunner,
  signerFromPrivateKeyHex,
} from "@publicdomainrelay/compute-deno-atproto";
import type { PdsClient } from "@publicdomainrelay/compute-deno-atproto";
import { createDenoBundler, createPersistentDenoWorker } from "@publicdomainrelay/sandbox-deno";
import {
  REGISTER_WORKER_MANIFEST_NSID,
} from "@publicdomainrelay/compute-deno-common";

function createRequest(path: string, method = "GET", body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return new Request(`http://127.0.0.1/${path}`, init);
}

Deno.test("[integration] full round-trip: register (persistent) → instance running → execute", async () => {
  const did = "did:plc:integration-test";
  const records = new Map<string, Map<string, { uri: string; cid: string; value: Record<string, unknown> }>>();
  records.set(did, new Map());
  let seq = 0;

  const pds: PdsClient = {
    async createRecord(
      repoDid: string,
      collection: string,
      record: Record<string, unknown>,
    ): Promise<{ uri: string; cid: string }> {
      const rkey = `r${(++seq).toString(16).padStart(8, "0")}`;
      const uri = `at://${repoDid}/${collection}/${rkey}`;
      const hash = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(record)),
        ),
      );
      const hex = Array.from(hash.slice(0, 16), (b) =>
        b.toString(16).padStart(2, "0")
      ).join("");
      const cid = `bafyrei${hex}`;
      if (!records.has(repoDid)) records.set(repoDid, new Map());
      records.get(repoDid)!.set(uri, { uri, cid, value: record });
      return { uri, cid };
    },

    async getRecord(
      repoDid: string,
      _collection: string,
      _rkey: string,
    ): Promise<{ uri: string; cid: string; value: Record<string, unknown> } | null> {
      const repoRecords = records.get(repoDid);
      if (!repoRecords) return null;
      const uri = `at://${repoDid}/${_collection}/${_rkey}`;
      return repoRecords.get(uri) ?? null;
    },
  };

  const bundler = createDenoBundler();
  const manifestStore = createDenoComputeManifestStore(pds, did);
  const instanceStore = createDenoComputeInstanceStore(pds, did);
  const runner = createDenoComputeInstanceRunner({
    manifestStore,
    instanceStore,
    bundler,
    createWorker: createPersistentDenoWorker,
    timeoutMs: 5000,
  });

  const factory = createDenoComputeFactory({
    manifestStore,
    instanceStore,
    runner,
    bundler,
    hostname: "localhost",
    strictAuth: false,
  });

  const source = "export function handle(e: unknown): unknown { return { status: 200, headers: {}, body: e }; }";
  const denoJson = JSON.stringify({ exports: "./mod.ts" });

  const regReq = createRequest(
    `xrpc/${REGISTER_WORKER_MANIFEST_NSID}`,
    "POST",
    { source, denoJson, persistent: true },
  );
  const regRes = await factory.app.fetch(regReq);
  assertEquals(regRes.status, 200);
  const regData = await regRes.json() as {
    instance: { uri: string; cid: string };
    bundle: string;
  };
  assertExists(regData.instance.uri);
  assertExists(regData.instance.cid);
  assertExists(regData.bundle);

  const instanceRef = { ...regData.instance, $type: "com.atproto.repo.strongRef" as const };
  assertEquals(runner.isRunning(instanceRef), true);

  await runner.stop(instanceRef);
  assertEquals(runner.isRunning(instanceRef), false);
});

Deno.test("[integration] manifest store round-trip", async () => {
  const did = "did:plc:store-test";
  const records = new Map<string, Map<string, { uri: string; cid: string; value: Record<string, unknown> }>>();
  records.set(did, new Map());
  let seq = 0;

  const pds: PdsClient = {
    async createRecord(
      repoDid: string,
      collection: string,
      record: Record<string, unknown>,
    ): Promise<{ uri: string; cid: string }> {
      const rkey = `s${(++seq).toString(16).padStart(8, "0")}`;
      const uri = `at://${repoDid}/${collection}/${rkey}`;
      const hash = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(record)),
        ),
      );
      const hex = Array.from(hash.slice(0, 16), (b) =>
        b.toString(16).padStart(2, "0")
      ).join("");
      const cid = `bafyrei${hex}`;
      if (!records.has(repoDid)) records.set(repoDid, new Map());
      records.get(repoDid)!.set(uri, { uri, cid, value: record });
      return { uri, cid };
    },
    async getRecord(
      repoDid: string,
      _collection: string,
      _rkey: string,
    ): Promise<{ uri: string; cid: string; value: Record<string, unknown> } | null> {
      const repoRecords = records.get(repoDid);
      if (!repoRecords) return null;
      const uri = `at://${repoDid}/${_collection}/${_rkey}`;
      return repoRecords.get(uri) ?? null;
    },
  };

  const manifestStore = createDenoComputeManifestStore(pds, did);

  const ref = await manifestStore.register({
    lock: "{}",
    json: "{}",
    bundle: "console.log('hello');",
  });

  assertExists(ref.uri);
  assertExists(ref.cid);

  const record = await manifestStore.get(ref.uri);
  assertExists(record);
  assertEquals(record!.bundle, "console.log('hello');");
  assertEquals(record!.lock, "{}");
  assertEquals(record!.json, "{}");
});

Deno.test("[integration] manifest register with signing key produces attestation signature", async () => {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  const signingKey = await signerFromPrivateKeyHex(hex);

  const did = "did:plc:sig-test";
  const records = new Map<string, Map<string, { uri: string; cid: string; value: Record<string, unknown> }>>();
  records.set(did, new Map());
  let seq = 0;

  const pds: PdsClient = {
    async createRecord(
      repoDid: string,
      collection: string,
      record: Record<string, unknown>,
    ): Promise<{ uri: string; cid: string }> {
      const rkey = `s${(++seq).toString(16).padStart(8, "0")}`;
      const uri = `at://${repoDid}/${collection}/${rkey}`;
      const hash = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(record)),
        ),
      );
      const hex2 = Array.from(hash.slice(0, 16), (b) =>
        b.toString(16).padStart(2, "0")
      ).join("");
      const cid = `bafyrei${hex2}`;
      if (!records.has(repoDid)) records.set(repoDid, new Map());
      records.get(repoDid)!.set(uri, { uri, cid, value: record });
      return { uri, cid };
    },
    async getRecord(
      repoDid: string,
      _collection: string,
      _rkey: string,
    ): Promise<{ uri: string; cid: string; value: Record<string, unknown> } | null> {
      const repoRecords = records.get(repoDid);
      if (!repoRecords) return null;
      const uri = `at://${repoDid}/${_collection}/${_rkey}`;
      return repoRecords.get(uri) ?? null;
    },
  };

  const manifestStore = createDenoComputeManifestStore(pds, did);
  const ref = await manifestStore.register(
    { lock: "{}", json: "{}", bundle: "console.log('signed');" },
    signingKey,
  );

  assertExists(ref.uri);
  assertExists(ref.cid);

  const record = await manifestStore.get(ref.uri);
  assertExists(record);
  assertExists(record!.signatures);
  assertEquals(Array.isArray(record!.signatures), true);
  assertEquals(record!.signatures!.length, 1);

  const sig = record!.signatures![0] as Record<string, unknown>;
  assertEquals(sig.$type, "network.attested.signature");
  assertEquals(typeof sig.key, "string");
  assertEquals(typeof sig.cid, "string");
  assertEquals(typeof (sig as Record<string, unknown>).signature, "object");
});
