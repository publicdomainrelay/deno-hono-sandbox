import { assertEquals, assertExists } from "@std/assert";
import { createSandboxFactory } from "@publicdomainrelay/hono-factory-sandbox-deno";

function allocatePort(): number {
  const listener = Deno.listen({ port: 0 });
  const port = listener.addr.port;
  try { listener.close(); } catch { /* ok */ }
  return port;
}

Deno.test("[integration] GET /health over HTTP", async () => {
  const factory = createSandboxFactory();
  const controller = new AbortController();
  const port = allocatePort();
  const server = Deno.serve({ port, signal: controller.signal }, factory.app.fetch);

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
  const port = allocatePort();
  const server = Deno.serve({ port, signal: controller.signal }, factory.app.fetch);

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
