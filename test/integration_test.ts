import { assertEquals, assertExists } from "@std/assert";
import { createSandboxFactory } from "@publicdomainrelay/hono-factory-sandbox-deno";

Deno.test("[integration] GET /health over HTTP", async () => {
  const factory = createSandboxFactory();
  const controller = new AbortController();
  const { promise: portReady, resolve: resolvePort } = Promise.withResolvers<number>();
  const server = Deno.serve({ port: 0, signal: controller.signal, onListen: (addr) => resolvePort((addr as Deno.NetAddr).port) }, factory.app.fetch);
  const port = await portReady;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.status, "ok");
  } finally {
    controller.abort();
    await server.finished;
    await factory.sandbox.shutdown();
  }
});

Deno.test("[integration] POST /execute over HTTP", async () => {
  const factory = createSandboxFactory();
  const controller = new AbortController();
  const { promise: portReady, resolve: resolvePort } = Promise.withResolvers<number>();
  const server = Deno.serve({ port: 0, signal: controller.signal, onListen: (addr) => resolvePort((addr as Deno.NetAddr).port) }, factory.app.fetch);
  const port = await portReady;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "return 42;" }),
    });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.result);
  } finally {
    controller.abort();
    await server.finished;
    await factory.sandbox.shutdown();
  }
});
