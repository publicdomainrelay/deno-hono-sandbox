import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import type { Sandbox, SandboxResponse } from "@publicdomainrelay/sandbox-abc";
import { SandboxError } from "@publicdomainrelay/common";
import { createDenoSandbox } from "@publicdomainrelay/sandbox-deno";

export interface SandboxFactoryOptions {
  timeoutMs?: number;
}

export interface SandboxFactory {
  app: Hono;
  sandbox: Sandbox;
}

export function createSandboxFactory(opts: SandboxFactoryOptions = {}): SandboxFactory {
  const sandbox = createDenoSandbox();

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

  return { app, sandbox };
}
