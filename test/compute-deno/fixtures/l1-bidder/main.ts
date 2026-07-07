// @ts-nocheck
import {
  createDenoComputeManifestStore,
  createDenoComputeInstanceStore,
  createDenoComputeInstanceRunner,
} from "@publicdomainrelay/compute-deno-atproto";
import { createDenoBundler, createPersistentDenoWorker } from "@publicdomainrelay/sandbox-deno";

const did = "did:plc:l1";
const records = new Map();
records.set(did, new Map());
let seq = 0;

const pds = {
  async createRecord(repoDid, collection, record) {
    const rkey = "r" + (++seq).toString(16).padStart(8, "0");
    const uri = "at://" + repoDid + "/" + collection + "/" + rkey;
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(record))));
    const hex = Array.from(hash.slice(0, 16), b => b.toString(16).padStart(2, "0")).join("");
    const cid = "bafyrei" + hex;
    if (!records.has(repoDid)) records.set(repoDid, new Map());
    records.get(repoDid).set(uri, { uri, cid, value: record });
    return { uri, cid };
  },
  async getRecord(repoDid, collection, rkey) {
    const repoRecs = records.get(repoDid);
    if (!repoRecs) return null;
    const uri = "at://" + repoDid + "/" + collection + "/" + rkey;
    return repoRecs.get(uri) || null;
  },
};

const bundler = createDenoBundler();
const manifestStore = createDenoComputeManifestStore(pds, did);
const instanceStore = createDenoComputeInstanceStore(pds, did);
const runner = createDenoComputeInstanceRunner({
  manifestStore, instanceStore, bundler,
  createWorker: createPersistentDenoWorker,
  timeoutMs: 60000,
});

let l2InstanceRef = null;

self.onmessage = async (e) => {
  const msg = e.data;
  const body = msg.body || {};

  if (body.action === "register_l2") {
    // L2 already bundled by test, just store and start
    const manifestRef = await manifestStore.register({
      lock: "{}",
      json: body.l2DenoJson || "{}",
      bundle: body.l2Source || "",
      permissions: body.l2Permissions || {},
    });
    const instanceRef = await instanceStore.register({ manifest: manifestRef });
    await runner.start(instanceRef, manifestRef);
    l2InstanceRef = instanceRef;
    self.postMessage({ status: 200, headers: {}, body: { registered: true, instance: instanceRef } });
  } else if (body.action === "execute_l2") {
    if (!l2InstanceRef) {
      self.postMessage({ status: 404, headers: {}, body: { error: "no L2 instance registered" } });
      return;
    }
    const response = await runner.execute(l2InstanceRef, {
      method: body.method || "GET",
      path: body.path || "/health",
    });
    self.postMessage({ status: 200, headers: {}, body: response });
  } else {
    self.postMessage({ status: 200, headers: {}, body: { status: "ok", level: 1 } });
  }
};
