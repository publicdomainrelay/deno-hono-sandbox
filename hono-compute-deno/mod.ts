import { Command } from "@publicdomainrelay/cli-args-env";
import { createStructuredLogger } from "@publicdomainrelay/logger";
import { createDenoComputeFactory } from "@publicdomainrelay/hono-factory-compute-deno-atproto";
import {
  createDenoComputeManifestStore,
  createDenoComputeInstanceStore,
  createDenoComputeInstanceRunner,
} from "@publicdomainrelay/compute-deno-atproto";
import { createDenoBundler } from "@publicdomainrelay/sandbox-deno";
import cliArgsEnv from "./cli-args-env.json" with { type: "json" };

let runtimeConfig = null;
try {
  const mod = await import("./config.json", { with: { type: "json" } });
  runtimeConfig = mod.default;
} catch {
  /* optional */
}

const { options } = await new Command(
  "CONFIG_PATH_HONO_COMPUTE_DENO",
  cliArgsEnv,
  runtimeConfig,
).resolve();

const log = createStructuredLogger("hono-compute-deno", "info");

const pdsUrl = options.pdsUrl as string | undefined;
const handle = options.atprotoHandle as string | undefined;
const password = options.atprotoPassword as string | undefined;

let pdsDid = "did:plc:local";
const records = new Map<string, Map<string, { uri: string; cid: string; value: Record<string, unknown> }>>();
records.set(pdsDid, new Map());

let recordSeq = 0;
function nextRkey(): string {
  recordSeq++;
  return `r${recordSeq.toString(16).padStart(8, "0")}`;
}

const pdsClient = {
  async createRecord(
    did: string,
    collection: string,
    record: Record<string, unknown>,
    _rkey?: string,
  ): Promise<{ uri: string; cid: string }> {
    const rkey = _rkey ?? nextRkey();
    const uri = `at://${did}/${collection}/${rkey}`;
    const hash = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(record)),
      ),
    );
    const cidHex = Array.from(hash.slice(0, 16), (b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
    const cid = `bafyrei${cidHex}`;
    if (!records.has(did)) records.set(did, new Map());
    records.get(did)!.set(uri, { uri, cid, value: record });
    return { uri, cid };
  },
  async getRecord(
    did: string,
    _collection: string,
    _rkey: string,
  ): Promise<{ uri: string; cid: string; value: Record<string, unknown> } | null> {
    const didRecords = records.get(did);
    if (!didRecords) return null;
    const uri = `at://${did}/${_collection}/${_rkey}`;
    return didRecords.get(uri) ?? null;
  },
};

const bundler = createDenoBundler();
const manifestStore = createDenoComputeManifestStore(pdsClient, pdsDid);
const instanceStore = createDenoComputeInstanceStore(pdsClient, pdsDid);
const runner = createDenoComputeInstanceRunner({
  manifestStore,
  instanceStore,
  bundler,
  timeoutMs: options.timeoutMs as number | undefined,
});

const factory = createDenoComputeFactory({
  manifestStore,
  instanceStore,
  runner,
  bundler,
});

const port = options.port as number;
const hostname = options.hostname as string;
const unixSocket = options.unixSocket as string | undefined;

if (unixSocket) {
  try {
    await Deno.remove(unixSocket);
  } catch {
    /* stale socket */
  }
  Deno.serve(
    { path: unixSocket, onListen: () => log.info("listening", { unixSocket }) },
    factory.app.fetch,
  );
} else {
  Deno.serve(
    { port, hostname, onListen: () => log.info("listening", { port, hostname }) },
    factory.app.fetch,
  );
}
