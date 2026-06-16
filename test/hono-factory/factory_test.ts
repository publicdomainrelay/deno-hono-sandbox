import { assertEquals, assertExists } from "@std/assert";
import { createSandboxFactory } from "@publicdomainrelay/hono-factory-sandbox-deno";

function createTestRequest(path: string, method = "GET", body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return new Request(`http://127.0.0.1/${path}`, init);
}

Deno.test("Factory GET /health returns ok", async () => {
  const factory = createSandboxFactory();
  const req = createTestRequest("health");
  const res = await factory.app.fetch(req);

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.status, "ok");

  await factory.sandbox.shutdown();
});

Deno.test("Factory POST /execute runs code", async () => {
  const factory = createSandboxFactory();
  const req = createTestRequest("execute", "POST", { code: "return 42;" });
  const res = await factory.app.fetch(req);

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.exitCode, 0);
  assertEquals(data.result, 42);

  await factory.sandbox.shutdown();
});

Deno.test("Factory POST /execute rejects missing code", async () => {
  const factory = createSandboxFactory();
  const req = createTestRequest("execute", "POST", {});
  const res = await factory.app.fetch(req);

  assertEquals(res.status, 400);
  const data = await res.json();
  assertExists(data.error);

  await factory.sandbox.shutdown();
});

Deno.test("Factory POST /execute rejects non-JSON body", async () => {
  const factory = createSandboxFactory();
  const req = new Request("http://127.0.0.1/execute", {
    method: "POST",
    body: "not json",
    headers: { "content-type": "text/plain" },
  });
  const res = await factory.app.fetch(req);

  assertEquals(res.status, 400);

  await factory.sandbox.shutdown();
});

Deno.test("Factory POST /execute returns timeout", async () => {
  const factory = createSandboxFactory({ timeoutMs: 10 });
  const req = createTestRequest("execute", "POST", {
    code: "while(true) {}",
  });
  const res = await factory.app.fetch(req);

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.timedOut, true);

  await factory.sandbox.shutdown();
});
