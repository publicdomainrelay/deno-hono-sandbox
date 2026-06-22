import { Command } from "@publicdomainrelay/cli-args-env";
import { createLogger } from "@publicdomainrelay/logger";
import { createServe } from "@publicdomainrelay/serve";
import { createDenoComputeFactory } from "@publicdomainrelay/hono-factory-compute-deno-atproto";
import {
  createDenoComputeManifestStore,
  createDenoComputeInstanceStore,
  createDenoComputeInstanceRunner,
  signerFromPrivateKeyHex,
  createRemotePdsClient,
  signComputeServiceAuth,
  createWorkerPolicyHandler,
  createLoopbackPolicyHandler,
  createRemotePermissionPolicyHandler,
} from "@publicdomainrelay/compute-deno-atproto";
import type { SigningKey, PdsClient } from "@publicdomainrelay/compute-deno-atproto";
import type { PermissionPolicyHandler } from "@publicdomainrelay/compute-deno-abc";
import { createDenoBundler, createPersistentDenoWorker } from "@publicdomainrelay/sandbox-deno";
import { loadOrCreateAttestationKeyHex } from "@publicdomainrelay/utils-attestation-key";
import { createSubscriber } from "@publicdomainrelay/did-key-relay-subscriber-xrpc";
import { createSubscriberFactory } from "@publicdomainrelay/hono-factory-did-key-relay-subscriber-xrpc";
import cliArgsEnv from "./cli-args-env.json" with { type: "json" };

let runtimeConfig: Record<string, unknown> | null = null;
try {
  const mod = await import("./config.json", { with: { type: "json" } });
  runtimeConfig = mod.default as Record<string, unknown>;
} catch { }

const { options } = await new Command(
  "CONFIG_PATH_HONO_COMPUTE_DENO",
  cliArgsEnv,
  runtimeConfig,
).resolve();

const log = createLogger({ serviceName: "hono-compute-deno" });

const hostname = options.hostname as string;
const port = options.port as number;
const unixSocket = options.unixSocket as string | undefined;
const pdsUrl = options.pdsUrl as string | undefined;
const handle = options.atprotoHandle as string | undefined;
const password = options.atprotoPassword as string | undefined;
const attestationKeyPath = options.attestationKeyPath as string | undefined;

let signingKey: SigningKey | undefined;
if (attestationKeyPath) {
  const hex = await loadOrCreateAttestationKeyHex(attestationKeyPath);
  signingKey = await signerFromPrivateKeyHex(hex);
}

let pdsClient: PdsClient;
let pdsDid: string;

if (pdsUrl) {
  if (!handle || !password) {
    log.error("missing credentials", {});
    Deno.exit(1);
  }
  const remote = await createRemotePdsClient(pdsUrl, handle, password);
  pdsClient = remote.client;
  pdsDid = remote.did;
} else {
  pdsDid = "did:plc:local";
  const records = new Map<string, Map<string, { uri: string; cid: string; value: Record<string, unknown> }>>();
  records.set(pdsDid, new Map());

  let recordSeq = 0;
  function nextRkey(): string {
    recordSeq++;
    return `r${recordSeq.toString(16).padStart(8, "0")}`;
  }

  pdsClient = {
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
}

const bundler = createDenoBundler();
const manifestStore = createDenoComputeManifestStore(pdsClient, pdsDid);
const instanceStore = createDenoComputeInstanceStore(pdsClient, pdsDid);
const runner = createDenoComputeInstanceRunner({
  manifestStore,
  instanceStore,
  bundler,
  createWorker: createPersistentDenoWorker,
  timeoutMs: options.timeoutMs as number | undefined,
});

let permissionPolicyHandler: PermissionPolicyHandler | undefined;
let policyServerShutdown: (() => void) | undefined;

if (options.permissionMode === "by-policy") {
  if (options.policyHandlerService) {
    if (!signingKey) {
      log.error("policy-handler-service requires attestation-key-path", {});
      Deno.exit(1);
    }
    const ref = options.policyHandlerService as string;
    const m = ref.match(/^did:web:(.+)#(.+)$/);
    if (!m) {
      log.error("policy-handler-service must be did:web:<host>#<serviceId>", { ref });
      Deno.exit(1);
    }
    const svcHost = m[1];
    permissionPolicyHandler = createRemotePermissionPolicyHandler({
      serviceEndpoint: `https://${svcHost}`,
      signingKey,
      issuerDid: `did:web:${hostname}`,
    });
  } else if (options.policyHandlerBuiltIn) {
    const name = options.policyHandlerBuiltIn as string;
    if (options.policyHandlerLoopback) {
      const loopback = await createLoopbackPolicyHandler(name);
      permissionPolicyHandler = loopback.handler;
      policyServerShutdown = loopback.server.shutdown;
      log.info("policy handler loopback started", { url: loopback.url, handler: name });
    } else {
      const workerHandler = createWorkerPolicyHandler(name, createPersistentDenoWorker);
      permissionPolicyHandler = workerHandler.handler;
      policyServerShutdown = () => workerHandler.worker.shutdown();
      log.info("policy handler worker started", { handler: name });
    }
  } else {
    log.error("permission-mode by-policy requires --policy-handler-built-in or --policy-handler-service", {});
    Deno.exit(1);
  }
}

const factory = createDenoComputeFactory({
  manifestStore,
  instanceStore,
  runner,
  bundler,
  hostname,
  signingKey,
  permissionPolicyHandler,
  defaultPermissionMode: options.permissionMode as "deny-all" | "allow-all" | "by-policy" ?? "deny-all",
});

const relay = options.relay as boolean | undefined;
const relayDispatcherHost = options.relayDispatcherHost as string | undefined;

if (relay) {
  if (!signingKey) {
    log.error("relay mode requires attestation-key-path", {});
    Deno.exit(1);
  }
  if (!relayDispatcherHost) {
    log.error("relay mode requires relay-dispatcher-host", {});
    Deno.exit(1);
  }

  const subscriberFactory = createSubscriberFactory({ app: factory.app });

  const getServiceAuthToken = async (nsid: string): Promise<string> => {
    const origin = `https://${relayDispatcherHost}`;
    return signComputeServiceAuth(signingKey, `did:web:${relayDispatcherHost}`, nsid);
  };

  const handle = await createSubscriber({
    keypair: signingKey,
    getServiceAuthToken,
    dispatcherHost: relayDispatcherHost,
    handleRequest: (req) => subscriberFactory.handleRequest(req),
    label: "compute-deno",
  });

  log.info("relay subscriber registered", {
    proxyRef: handle.proxyRef,
    subdomain: handle.subdomain,
  });
}

const serve = createServe({
  logger: log,
  unix: unixSocket ? { socketPath: unixSocket } : undefined,
  tcp: unixSocket ? undefined : { addr: hostname, port },
});
serve.app.route("/", factory.app as never);

function shutdown() {
  log.info("shutting down");
  runner.stopAll().then(() => {
    if (policyServerShutdown) policyServerShutdown();
    serve.shutdown();
    Deno.exit(0);
  });
}

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

await serve.beginServe();
