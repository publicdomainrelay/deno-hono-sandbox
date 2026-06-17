import { Hono } from "jsr:@hono/hono@^4";
import { cors } from "jsr:@hono/hono@^4/cors";
import type {
  Bundler,
  BundleRequest,
  BundleResponse,
  BundleTarRequest,
  BundleTarResponse,
  ExecRequest,
  Sandbox,
  SandboxResponse,
} from "jsr:@publicdomainrelay/sandbox-abc@0.0.0";
import { SandboxError } from "jsr:@publicdomainrelay/sandbox-common@0.0.0";
import { createDenoBundler, createDenoSandbox } from "jsr:@publicdomainrelay/sandbox-deno@0.0.0";

export interface SandboxFactoryOptions {
  timeoutMs?: number;
}

export interface SandboxFactory {
  app: Hono;
  sandbox: Sandbox;
  bundler: Bundler;
}

export function createSandboxFactory(opts: SandboxFactoryOptions = {}): SandboxFactory {
  const sandbox = createDenoSandbox();
  const bundler = createDenoBundler();

  const app = new Hono();

  app.use("*", cors());

  app.onError((err) => {
    if (err instanceof SandboxError) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: err.status,
        headers: { "content-type": "application/json" },
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  });

  app.get("/health", (c) => {
    return c.json({ status: "ok" });
  });

  app.post("/execute", async (c) => {
    let body: { code?: string; timeoutMs?: number };
    try {
      body = await c.req.json();
    } catch {
      throw new SandboxError("invalid JSON body", 400);
    }

    if (!body.code || typeof body.code !== "string") {
      throw new SandboxError('"code" field is required', 400);
    }

    const result: SandboxResponse = await sandbox.execute({
      code: body.code,
      timeoutMs: body.timeoutMs ?? opts.timeoutMs,
    });

    return c.json(result);
  });

  app.post("/bundle", async (c) => {
    let body: { denoJson?: string; denoLock?: string; source?: string };
    try {
      body = await c.req.json();
    } catch {
      throw new SandboxError("invalid JSON body", 400);
    }

    if (!body.denoJson || typeof body.denoJson !== "string") {
      throw new SandboxError('"denoJson" field is required', 400);
    }

    if (!body.source || typeof body.source !== "string") {
      throw new SandboxError('"source" field is required', 400);
    }

    try {
      JSON.parse(body.denoJson);
    } catch {
      throw new SandboxError('"denoJson" is not valid JSON', 400);
    }

    if (body.denoLock) {
      try {
        JSON.parse(body.denoLock);
      } catch {
        throw new SandboxError('"denoLock" is not valid JSON', 400);
      }
    }

    const req: BundleRequest = {
      denoJson: body.denoJson,
      denoLock: body.denoLock,
      source: body.source,
    };

    const result: BundleResponse = await bundler.bundle(req);

    if (!result.bundleJs && result.stderr) {
      return c.json({ error: "bundle failed", ...result }, 400);
    }

    return c.json(result);
  });

  app.post("/bundleTar", async (c) => {
    let body: { tarBase64?: string };
    try {
      body = await c.req.json();
    } catch {
      throw new SandboxError("invalid JSON body", 400);
    }

    if (!body.tarBase64 || typeof body.tarBase64 !== "string") {
      throw new SandboxError('"tarBase64" field is required', 400);
    }

    const req: BundleTarRequest = { tarBase64: body.tarBase64 };

    const result: BundleTarResponse = await bundler.bundleTar(req);

    if (!result.bundleJs && result.stderr) {
      return c.json({ error: "bundle failed", ...result }, 400);
    }

    return c.json(result);
  });

  app.post("/exec", async (c) => {
    let body: { bundleJs?: string; denoJson?: string; denoLock?: string; timeoutMs?: number };
    try {
      body = await c.req.json();
    } catch {
      throw new SandboxError("invalid JSON body", 400);
    }

    if (!body.bundleJs || typeof body.bundleJs !== "string") {
      throw new SandboxError('"bundleJs" field is required', 400);
    }

    const execReq: ExecRequest = {
      bundleJs: body.bundleJs,
      denoJson: body.denoJson,
      denoLock: body.denoLock,
      timeoutMs: body.timeoutMs ?? opts.timeoutMs,
    };

    const result: SandboxResponse = await sandbox.execute({
      code: execReq.bundleJs,
      timeoutMs: execReq.timeoutMs,
    });

    return c.json(result);
  });

  return { app, sandbox, bundler };
}
