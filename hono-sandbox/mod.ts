import { createSandboxFactory } from "@publicdomainrelay/hono-factory-sandbox-deno";

function getPort(): number {
  const argPort = Deno.args[0];
  if (argPort) return parseInt(argPort);
  const envPort = Deno.env.get("PORT");
  if (envPort) return parseInt(envPort);
  return 2584;
}

function getHostname(): string {
  return Deno.env.get("HOSTNAME") ?? "127.0.0.1";
}

const port = getPort();
const hostname = getHostname();
const timeoutMs = Deno.env.get("SANDBOX_TIMEOUT_MS");

const factory = createSandboxFactory({
  timeoutMs: timeoutMs ? parseInt(timeoutMs) : undefined,
});

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
