import { assertEquals } from "@std/assert";
import { createSandboxFactory } from "@publicdomainrelay/hono-factory-sandbox-deno";

const VALID_DENO_JSON = JSON.stringify({
  imports: {},
  fmt: { lineWidth: 100 },
});

const VALID_SOURCE = 'console.log("hello from bundle");';

function req(path: string, method = "GET", body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return new Request(`http://127.0.0.1/${path}`, init);
}

Deno.test("POST /bundle produces bundle.js", async () => {
  const factory = createSandboxFactory();
  const r = req("bundle", "POST", {
    denoJson: VALID_DENO_JSON,
    source: VALID_SOURCE,
  });
  const res = await factory.app.fetch(r);

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(typeof data.bundleJs, "string");
  assertEquals(data.bundleJs.length > 0, true);

  await factory.sandbox.shutdown();
});

Deno.test("POST /bundle rejects missing denoJson", async () => {
  const factory = createSandboxFactory();
  const r = req("bundle", "POST", { source: VALID_SOURCE });
  const res = await factory.app.fetch(r);

  assertEquals(res.status, 400);

  await factory.sandbox.shutdown();
});

Deno.test("POST /bundle rejects invalid denoJson JSON", async () => {
  const factory = createSandboxFactory();
  const r = req("bundle", "POST", {
    denoJson: "not json",
    source: VALID_SOURCE,
  });
  const res = await factory.app.fetch(r);

  assertEquals(res.status, 400);

  await factory.sandbox.shutdown();
});

Deno.test("POST /bundle rejects invalid source", async () => {
  const factory = createSandboxFactory();
  const r = req("bundle", "POST", {
    denoJson: VALID_DENO_JSON,
    source: "}{ invalid",
  });
  const res = await factory.app.fetch(r);

  assertEquals(res.status, 400);
  const data = await res.json();
  assertEquals(typeof data.error, "string");

  await factory.sandbox.shutdown();
});

Deno.test("POST /exec runs bundle.js", async () => {
  const factory = createSandboxFactory();
  const r = req("exec", "POST", {
    bundleJs: 'console.log("hello from exec"); return 42;',
  });
  const res = await factory.app.fetch(r);

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.exitCode, 0);
  assertEquals(data.result, 42);
  assertEquals(data.stdout.includes("hello from exec"), true);

  await factory.sandbox.shutdown();
});

Deno.test("POST /exec rejects missing bundleJs", async () => {
  const factory = createSandboxFactory();
  const r = req("exec", "POST", {});
  const res = await factory.app.fetch(r);

  assertEquals(res.status, 400);

  await factory.sandbox.shutdown();
});
