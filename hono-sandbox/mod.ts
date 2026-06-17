import { Command } from "@publicdomainrelay/cli-args-env";
import { createSandboxFactory } from "@publicdomainrelay/hono-factory-sandbox-deno";
import cliArgsEnv from "./cli-args-env.json" with { type: "json" };

let runtimeConfig: Record<string, unknown> | null = null;
try {
  const mod = await import("./config.json", { with: { type: "json" } });
  runtimeConfig = mod.default as Record<string, unknown>;
} catch { /* optional */ }

const cmd = await new Command("CONFIG_PATH_HONO_SANDBOX", cliArgsEnv, runtimeConfig)
  .resolve();

const port = cmd.options.port as number;
const hostname = cmd.options.hostname as string;
const timeoutMs = cmd.options.timeoutMs as number | undefined;

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
