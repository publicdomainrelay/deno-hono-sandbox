import { assertEquals } from "@std/assert";
import { createSandboxFactory } from "@publicdomainrelay/hono-factory-sandbox-deno";

function req(path: string, body?: unknown): Request {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return new Request(`http://127.0.0.1/${path}`, init);
}

async function createTar(dir: string): Promise<Uint8Array> {
  const cmd = new Deno.Command("tar", {
    args: ["cf", "-", "."],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return output.stdout;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

Deno.test("POST /bundleTar bundles valid project tar", async () => {
  const projectDir = await Deno.makeTempDir({ prefix: "bundleTar-test-" });
  try {
    const denoJson = JSON.stringify({ imports: {}, fmt: { lineWidth: 100 } });
    await Deno.writeTextFile(`${projectDir}/deno.json`, denoJson);
    await Deno.writeTextFile(`${projectDir}/main.ts`, 'console.log("hello from tar");');

    const tarBytes = await createTar(projectDir);
    const tarBase64 = bytesToBase64(tarBytes);

    const factory = createSandboxFactory();
    const r = req("bundleTar", { tarBase64 });
    const res = await factory.app.fetch(r);

    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(typeof data.bundleJs, "string");
    assertEquals(data.bundleJs.includes("hello from tar"), true);

    await factory.sandbox.shutdown();
  } finally {
    try {
      await Deno.remove(projectDir, { recursive: true });
    } catch { }
  }
});

Deno.test("POST /bundleTar rejects missing tarBase64", async () => {
  const factory = createSandboxFactory();
  const r = req("bundleTar", {});
  const res = await factory.app.fetch(r);

  assertEquals(res.status, 400);

  await factory.sandbox.shutdown();
});

Deno.test("POST /bundleTar rejects tar without deno.json", async () => {
  const projectDir = await Deno.makeTempDir({ prefix: "bundleTar-nojson-" });
  try {
    await Deno.writeTextFile(`${projectDir}/main.ts`, 'console.log("hi");');

    const tarBytes = await createTar(projectDir);
    const tarBase64 = bytesToBase64(tarBytes);

    const factory = createSandboxFactory();
    const r = req("bundleTar", { tarBase64 });
    const res = await factory.app.fetch(r);

    assertEquals(res.status, 400);
    const data = await res.json();
    assertEquals(typeof data.error, "string");
    assertEquals(data.stderr.includes("deno.json"), true);

    await factory.sandbox.shutdown();
  } finally {
    try {
      await Deno.remove(projectDir, { recursive: true });
    } catch { }
  }
});

Deno.test("POST /bundleTar rejects invalid base64", async () => {
  const factory = createSandboxFactory();
  const r = req("bundleTar", { tarBase64: "!!!not valid base64!!!" });
  const res = await factory.app.fetch(r);

  assertEquals(res.status, 400);

  await factory.sandbox.shutdown();
});
