import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import net from "node:net";
import { after, before, test } from "node:test";
import { MAX_READ_BYTES } from "../src/avado/logs";
import { startHarness, type Harness } from "./helpers";

let h: Harness;
let release: () => void = () => {};
let gate = new Promise<void>((r) => (release = r));

before(async () => {
  h = await startHarness({ LONG_REQUEST_LIMIT: "2" });
  h.setUpstream(async (call) => {
    if (call.path === "/api/wait") await gate;
    return { body: '{"status":"success","error":""}' };
  });
});
after(async () => {
  release();
  await h.close();
});

const settle = () => new Promise((r) => setTimeout(r, 100));

test("concurrent /api/wait requests are capped; slots free up afterwards", async () => {
  const w1 = h.request("GET", "/api/sn/wait?txHash=0x1");
  const w2 = h.request("GET", "/api/sn/wait?txHash=0x2");
  await settle();
  const w3 = await h.request("GET", "/api/sn/wait?txHash=0x3");
  assert.equal(w3.status, 429);
  // short routes are not affected by the cap
  assert.equal((await h.request("GET", "/api/sn/node/status")).status, 200);
  release();
  assert.equal((await w1).status, 200);
  assert.equal((await w2).status, 200);
  gate = Promise.resolve();
  assert.equal((await h.request("GET", "/api/sn/wait?txHash=0x4")).status, 200);
  assert.equal(h.calls.filter((c) => c.path === "/api/wait").length, 3);
});

test("a wait slot is freed when the browser disconnects", async () => {
  gate = new Promise<void>((r) => (release = r));
  const port = Number(new URL(h.base).port);
  const sockets = [0, 1].map(() => {
    const s = net.connect(port, "127.0.0.1", () =>
      s.write(`GET /api/sn/wait?txHash=0x5 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`),
    );
    s.on("error", () => {});
    return s;
  });
  await settle();
  assert.equal((await h.request("GET", "/api/sn/wait?txHash=0x6")).status, 429);
  sockets.forEach((s) => s.destroy());
  await settle();
  release();
  gate = Promise.resolve();
  assert.equal((await h.request("GET", "/api/sn/wait?txHash=0x7")).status, 200);
});

test("log reads are bounded in bytes", async () => {
  const pad = "x".repeat(400);
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i} ${pad}`);
  await writeFile(h.config.daemonLogFile, lines.join("\n") + "\n");
  const r = await h.request("GET", "/api/avado/logs?tail=2000");
  assert.equal(r.status, 200);
  const got: string[] = r.json.lines;
  assert.ok(got.length < 2000, `${got.length} lines`);
  assert.ok(got.join("\n").length <= MAX_READ_BYTES);
  assert.equal(got.at(-1), `line 2999 ${pad}`);
  for (const l of got) assert.match(l, /^line \d+ x{400}$/); // no cut first line
});

test("a client that disconnects mid-body causes no 500 and no ERROR log", async () => {
  const port = Number(new URL(h.base).port);
  await new Promise<void>((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(
        `POST /api/sn/node/set-smoothing-pool-status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Avado-Request: 1\r\n` +
          `Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"status":`,
      );
      setTimeout(() => {
        s.destroy();
        resolve();
      }, 50);
    });
    s.on("error", () => {});
  });
  await settle();
  const logs = h.logs.join("\n");
  assert.ok(!/ ERROR /.test(logs), logs);
  assert.ok(!/set-smoothing-pool-status 500/.test(logs), logs);
  assert.equal(h.calls.filter((c) => c.path === "/api/node/set-smoothing-pool-status").length, 0);
});
