import { Hono } from "@hono/hono";

const app = new Hono();
app.get("/health", (c) => c.json({ status: "ok", level: 2 }));

let count = 0;

self.onmessage = async (e) => {
  count++;
  const msg = e.data;
  const req = new Request(`http://localhost${msg.path || "/"}`, {
    method: msg.method || "GET",
    body: msg.body ? JSON.stringify(msg.body) : undefined,
  });
  const res = await app.fetch(req);
  const body = await res.json();
  self.postMessage({ status: res.status, headers: {}, body: { ...body, count } });
};
