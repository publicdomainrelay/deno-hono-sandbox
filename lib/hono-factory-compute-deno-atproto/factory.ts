import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { registerErrorMiddleware } from "@publicdomainrelay/hono-error-middleware";
import { createLogger } from "@publicdomainrelay/logger";
import type {
  WorkerManifestStore,
  WorkerInstanceStore,
  WorkerInstanceRunner,
  SigningKey,
  PermissionPolicyHandler,
} from "@publicdomainrelay/compute-deno-abc";
import type { StrongRef } from "@publicdomainrelay/compute-deno-common";
import {
  REGISTER_WORKER_MANIFEST_NSID,
  RUN_PERSISTENT_WORKER_INSTANCE_NSID,
  EXECUTE_WORKER_INSTANCE_NSID,
  GATE_REGISTRY_WORKER_MANIFEST_PERMISSIONS_NSID,
  DenoComputeError,
} from "@publicdomainrelay/compute-deno-common";
import type { WorkerRequest } from "@publicdomainrelay/compute-deno-common";
import type { Bundler } from "@publicdomainrelay/sandbox-abc";
import { verifyComputeServiceAuth } from "@publicdomainrelay/compute-deno-atproto";

export interface DenoComputeFactoryOptions {
  manifestStore: WorkerManifestStore;
  instanceStore: WorkerInstanceStore;
  runner: WorkerInstanceRunner;
  hostname: string;
  bundler: Bundler;
  signingKey?: SigningKey;
  strictAuth?: boolean;
  permissionPolicyHandler?: PermissionPolicyHandler;
  defaultPermissionMode?: "deny-all" | "allow-all" | "by-policy";
}

export interface DenoComputeFactory {
  app: Hono;
}

export function createDenoComputeFactory(
  opts: DenoComputeFactoryOptions,
): DenoComputeFactory {
  const bundler = opts.bundler;
  const log = createLogger("compute-deno");
  const strictAuth = opts.strictAuth ?? true;
  const app = new Hono();

  function requireAuth(lxm: string) {
    return async (c: { req: { header: (name: string) => string | undefined } }, next: () => Promise<void>) => {
      if (!strictAuth) {
        await next();
        return;
      }
      const host = (c.req.header("host") ?? "").split(":")[0];
      const authHeader = c.req.header("authorization");
      try {
        await verifyComputeServiceAuth(authHeader, host, lxm, strictAuth);
      } catch (err) {
        if (err instanceof DenoComputeError) {
          return new Response(JSON.stringify(err.toJSON()), {
            status: err.status,
            headers: { "content-type": "application/json" },
          });
        }
        throw err;
      }
      await next();
    };
  }

  app.use("*", cors());
  registerErrorMiddleware(app, log);

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/.well-known/did.json", (c) => {
    const host = (c.req.header("host") ?? "").split(":")[0];
    if (!host) throw new DenoComputeError("missing Host header", 400, "InvalidRequest");
    return c.json({
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: `did:web:${host}`,
      service: [
        {
          id: "#register_worker_manifest",
          type: "ComputeDenoService",
          serviceEndpoint: `https://${host}`,
        },
        {
          id: "#run_persistent_worker_instance",
          type: "ComputeDenoService",
          serviceEndpoint: `https://${host}`,
        },
        {
          id: "#execute_worker_instance",
          type: "ComputeDenoService",
          serviceEndpoint: `https://${host}`,
        },
        {
          id: "#gate_registry_worker_manifest_permissions",
          type: "ComputeDenoService",
          serviceEndpoint: `https://${host}`,
        },
      ],
    });
  });

  app.post(`/xrpc/${REGISTER_WORKER_MANIFEST_NSID}`, requireAuth(REGISTER_WORKER_MANIFEST_NSID), async (c) => {
    let body: { source?: string; denoJson?: string; denoLock?: string; persistent?: boolean; permissionMode?: "deny-all" | "allow-all" | "by-policy" };
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

    const mode = body.permissionMode ?? opts.defaultPermissionMode ?? "deny-all";

    const manifestRecord = {
      lock: body.denoLock ?? "{}",
      json: body.denoJson,
      bundle: bundleResult.bundleJs,
      persistent: body.persistent,
    } as import("@publicdomainrelay/compute-deno-common").WorkerManifestRecord;

    if (mode === "by-policy") {
      if (!opts.permissionPolicyHandler) {
        throw new DenoComputeError("Policy handler not configured for by-policy mode", 500, "InternalError");
      }
      const result = await opts.permissionPolicyHandler.evaluate(manifestRecord);
      if (!result.allow) {
        return c.json({
          error: "PermissionDenied",
          message: "Permission policy denied registration",
          violations: result.violations,
        }, 403);
      }
    } else if (mode === "deny-all") {
      delete manifestRecord.permissions;
    }

    const manifestRef = await opts.manifestStore.register(
      manifestRecord,
      opts.signingKey,
    );

    const instanceRecord = { manifest: manifestRef };
    const instanceRef = await opts.instanceStore.register(
      instanceRecord,
      opts.signingKey,
    );

    if (body.persistent) {
      await opts.runner.start(instanceRef, manifestRef);
    }

    return c.json({ instance: instanceRef, bundle: bundleResult.bundleJs });
  });

  app.post(`/xrpc/${RUN_PERSISTENT_WORKER_INSTANCE_NSID}`, requireAuth(RUN_PERSISTENT_WORKER_INSTANCE_NSID), async (c) => {
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

  app.post(`/xrpc/${EXECUTE_WORKER_INSTANCE_NSID}`, requireAuth(EXECUTE_WORKER_INSTANCE_NSID), async (c) => {
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

  app.post(`/xrpc/${GATE_REGISTRY_WORKER_MANIFEST_PERMISSIONS_NSID}`, requireAuth(GATE_REGISTRY_WORKER_MANIFEST_PERMISSIONS_NSID), async (c) => {
    let body: { manifest?: import("@publicdomainrelay/compute-deno-common").WorkerManifestRecord };
    try {
      body = await c.req.json();
    } catch {
      throw new DenoComputeError("Invalid JSON body", 400, "InvalidRequest");
    }
    if (!body.manifest) {
      throw new DenoComputeError("manifest is required", 400, "InvalidRequest");
    }
    if (!opts.permissionPolicyHandler) {
      throw new DenoComputeError("No permission policy handler configured", 500, "InternalError");
    }
    const result = await opts.permissionPolicyHandler.evaluate(body.manifest);
    return c.json(result);
  });

  return { app };
}
