import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { registerErrorMiddleware } from "@publicdomainrelay/hono-error-middleware";
import { createLogger } from "@publicdomainrelay/logger";
import type {
  WorkerManifestStore,
  WorkerInstanceStore,
  WorkerInstanceRunner,
  SigningKey,
} from "@publicdomainrelay/compute-deno-abc";
import type { StrongRef } from "@publicdomainrelay/compute-deno-common";
import {
  REGISTER_WORKER_MANIFEST_NSID,
  RUN_PERSISTENT_WORKER_INSTANCE_NSID,
  EXECUTE_WORKER_INSTANCE_NSID,
  DenoComputeError,
} from "@publicdomainrelay/compute-deno-common";
import type { WorkerRequest } from "@publicdomainrelay/compute-deno-common";
import type { Bundler } from "@publicdomainrelay/sandbox-abc";
import { createDenoBundler } from "@publicdomainrelay/sandbox-deno";

export interface DenoComputeFactoryOptions {
  manifestStore: WorkerManifestStore;
  instanceStore: WorkerInstanceStore;
  runner: WorkerInstanceRunner;
  bundler?: Bundler;
  signingKey?: SigningKey;
}

export interface DenoComputeFactory {
  app: Hono;
}

export function createDenoComputeFactory(
  opts: DenoComputeFactoryOptions,
): DenoComputeFactory {
  const bundler = opts.bundler ?? createDenoBundler();
  const log = createLogger("compute-deno");
  const app = new Hono();

  app.use("*", cors());
  registerErrorMiddleware(app, log);

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.post(`/xrpc/${REGISTER_WORKER_MANIFEST_NSID}`, async (c) => {
    let body: { source?: string; denoJson?: string; denoLock?: string };
    try {
      body = await c.req.json();
    } catch {
      throw new DenoComputeError("Invalid JSON body", 400, "InvalidRequest");
    }
    if (!body.source || !body.denoJson) {
      throw new DenoComputeError(
        "source and denoJson are required",
        400,
        "InvalidRequest",
      );
    }

    const bundleResult = await bundler.bundle({
      denoJson: body.denoJson,
      denoLock: body.denoLock,
      source: body.source,
    });
    if (!bundleResult.bundleJs) {
      throw new DenoComputeError(
        `Bundle failed: ${bundleResult.stderr}`,
        400,
        "BundleFailed",
      );
    }

    const manifestRecord = {
      lock: body.denoLock ?? "{}",
      json: body.denoJson,
      bundle: bundleResult.bundleJs,
    };

    const manifest = await opts.manifestStore.register(
      manifestRecord,
      opts.signingKey,
    );
    return c.json({ manifest, bundle: bundleResult.bundleJs });
  });

  app.post(`/xrpc/${RUN_PERSISTENT_WORKER_INSTANCE_NSID}`, async (c) => {
    let body: { manifest?: { uri?: string; cid?: string } };
    try {
      body = await c.req.json();
    } catch {
      throw new DenoComputeError("Invalid JSON body", 400, "InvalidRequest");
    }
    if (!body.manifest?.uri || !body.manifest?.cid) {
      throw new DenoComputeError(
        "manifest (uri, cid) is required",
        400,
        "InvalidRequest",
      );
    }

    const manifestRef: StrongRef = {
      $type: "com.atproto.repo.strongRef",
      uri: body.manifest.uri,
      cid: body.manifest.cid,
    };

    const instanceRecord = { manifest: manifestRef };
    const instance = await opts.instanceStore.register(
      instanceRecord,
      opts.signingKey,
    );

    await opts.runner.start(instance, manifestRef);

    return c.json({ instance });
  });

  app.post(`/xrpc/${EXECUTE_WORKER_INSTANCE_NSID}`, async (c) => {
    let body: {
      instance?: { uri?: string; cid?: string };
      request?: WorkerRequest;
    };
    try {
      body = await c.req.json();
    } catch {
      throw new DenoComputeError("Invalid JSON body", 400, "InvalidRequest");
    }
    if (!body.instance?.uri || !body.instance?.cid) {
      throw new DenoComputeError(
        "instance (uri, cid) is required",
        400,
        "InvalidRequest",
      );
    }
    if (!body.request?.method || !body.request?.path) {
      throw new DenoComputeError(
        "request (method, path) is required",
        400,
        "InvalidRequest",
      );
    }

    const instanceRef: StrongRef = {
      $type: "com.atproto.repo.strongRef",
      uri: body.instance.uri,
      cid: body.instance.cid,
    };

    const response = await opts.runner.execute(instanceRef, body.request);
    return c.json(response);
  });

  return { app };
}
