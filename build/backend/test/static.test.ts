import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { resolveStaticPath } from "../src/static";
import { startHarness, type Harness } from "./helpers";

let h: Harness;
before(async () => {
  h = await startHarness();
  await writeFile(path.join(h.root, "secret.txt"), "outside");
  await writeFile(path.join(h.config.uiDir, ".env"), "dot");
  await symlink(path.join(h.root, "secret.txt"), path.join(h.config.uiDir, "link.txt"));
  await mkdir(path.join(h.config.uiDir, "sub"));
  await writeFile(path.join(h.config.uiDir, "sub", "index.html"), "sub-index");
});
after(async () => h.close());

test("/ serves index.html with no-cache", async () => {
  const r = await h.request("GET", "/");
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>RP<\/title>/);
  assert.equal(r.headers["cache-control"], "no-cache");
  assert.match(r.headers["content-type"]!, /text\/html/);
});

test("/assets/* is served with a long immutable cache", async () => {
  const r = await h.request("GET", "/assets/app-123.js");
  assert.equal(r.status, 200);
  assert.equal(r.text, "console.log(1)");
  assert.equal(r.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.match(r.headers["content-type"]!, /javascript/);
});

test("other files get a short cache", async () => {
  const r = await h.request("GET", "/favicon.svg");
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "public, max-age=3600");
});

test("client-side routes fall back to index.html", async () => {
  for (const p of ["/minipools", "/wallet/export", "/setup/step-2"]) {
    const r = await h.request("GET", p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /<title>RP<\/title>/);
    assert.equal(r.headers["cache-control"], "no-cache");
  }
});

test("missing files with an extension, and missing assets, are 404", async () => {
  assert.equal((await h.request("GET", "/nope.js")).status, 404);
  assert.equal((await h.request("GET", "/assets/gone")).status, 404);
});

test("path traversal is refused", async () => {
  for (const p of [
    "/..%2fsecret.txt",
    "/%2e%2e/secret.txt",
    "/assets/..%2f..%2fsecret.txt",
    "/..%5csecret.txt",
    "/%00index.html",
    "/%E0%A4%A",
  ]) {
    const r = await h.request("GET", p);
    assert.notEqual(r.text, "outside", p);
    assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
  }
  // raw ../ in the request line (clients normally normalise this away)
  const raw = await new Promise<string>((resolve) => {
    const port = Number(new URL(h.base).port);
    const s = net.connect(port, "127.0.0.1", () => s.write("GET /../secret.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    let data = "";
    s.on("data", (c) => (data += c));
    s.on("end", () => resolve(data));
  });
  assert.ok(!raw.includes("outside"));
});

test("dotfiles and symlinks leaving the UI dir are 404", async () => {
  assert.equal((await h.request("GET", "/.env")).status, 404);
  const r = await h.request("GET", "/link.txt");
  assert.equal(r.status, 404);
  assert.notEqual(r.text, "outside");
});

test("a directory serves its index.html", async () => {
  const r = await h.request("GET", "/sub/");
  assert.equal(r.text, "sub-index");
});

test("HEAD works, other methods on static paths are 405", async () => {
  const head = await h.request("HEAD", "/");
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
  const post = await h.request("POST", "/", { headers: { "X-Avado-Request": "1" } });
  assert.equal(post.status, 405);
});

test("resolveStaticPath never leaves the root", () => {
  assert.equal(resolveStaticPath("/srv/ui", "/../../etc/passwd"), "/srv/ui/etc/passwd");
  assert.equal(resolveStaticPath("/srv/ui", "/%2e%2e/%2e%2e/etc/passwd"), "/srv/ui/etc/passwd");
  assert.equal(resolveStaticPath("/srv/ui", "/a/..%2f..%2f..%2fetc"), "/srv/ui/etc");
  assert.equal(resolveStaticPath("/srv/ui", "/a/%00"), null);
});
