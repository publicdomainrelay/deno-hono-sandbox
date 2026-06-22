import { Command } from "@publicdomainrelay/cli-args-env";
import { createSandboxFactory } from "@publicdomainrelay/hono-factory-sandbox-deno";
import { createLogger } from "@publicdomainrelay/logger";
import { createServe } from "@publicdomainrelay/serve";
import cliArgsEnv from "./cli-args-env.json" with { type: "json" };

let runtimeConfig: Record<string, unknown> | null = null;
try {
  const mod = await import("./config.json", { with: { type: "json" } });
  runtimeConfig = mod.default as Record<string, unknown>;
} catch {}

const cmd = await new Command("CONFIG_PATH_HONO_SANDBOX", cliArgsEnv, runtimeConfig)
  .resolve();

const port = cmd.options.port as number;
const hostname = cmd.options.hostname as string;
const timeoutMs = cmd.options.timeoutMs as number | undefined;

const logger = createLogger({ serviceName: "sandbox" });
const factory = createSandboxFactory({ timeoutMs });

const serve = createServe({ logger, tcp: { addr: hostname, port } });
serve.app.route("/", factory.app as never);

function shutdown() {
  factory.sandbox.shutdown().then(() => {
    serve.shutdown();
    Deno.exit(0);
  });
}

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

await serve.beginServe();
