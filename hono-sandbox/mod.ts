import { createSandboxFactory } from "@publicdomainrelay/hono-factory-sandbox-deno";
import { loadConfig } from "@publicdomainrelay/common";
import type { ArgDef } from "@publicdomainrelay/common";

const ARGS: Record<string, ArgDef> = {
  port: { type: "number", env: "PORT", default: 2584 },
  hostname: { type: "string", env: "HOSTNAME", default: "127.0.0.1" },
  timeoutMs: { type: "number", env: "SANDBOX_TIMEOUT_MS" },
};

const cfg = loadConfig(ARGS);

const port = cfg.port as number;
const hostname = cfg.hostname as string;
const timeoutMs = cfg.timeoutMs as number | undefined;

const factory = createSandboxFactory({ timeoutMs });

const server = Deno.serve({ port, hostname }, factory.app.fetch);
console.error(`Sandbox server on http://${hostname}:${port}/`);

function shutdown() {
  console.error("\nShutting down...");
  factory.sandbox.shutdown().then(() => {
    server.shutdown();
    Deno.exit(0);
  });
}

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
