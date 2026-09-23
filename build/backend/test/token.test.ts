import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { redact } from "../src/log";
import { readApiToken } from "../src/sn/token";
import { startHarness, TOKEN, TOKEN2, type Harness } from "./helpers";

let h: Harness;
before(async () => (h = await startHarness()));
after(async () => h.close());

const tokenFile = () => path.join(h.config.dataDir, "api-tokens.json");

test("the bearer token is injected upstream", async () => {
  await h.request("GET", "/api/sn/node/status");
  assert.equal(h.calls.at(-1)!.auth, `Bearer ${TOKEN}`);
});

test("the token is read at call time (a rotated token is used without restart)", async () => {
  await writeFile(tokenFile(), JSON.stringify({ tokens: [{ token: TOKEN2, scope: "write" }] }));
  await h.request("GET", "/api/sn/node/status");
  assert.equal(h.calls.at(-1)!.auth, `Bearer ${TOKEN2}`);
  await writeFile(tokenFile(), JSON.stringify({ tokens: [{ token: TOKEN, scope: "write" }] }));
});

test("a write-scope token is preferred over a read token", async () => {
  await writeFile(
    tokenFile(),
    JSON.stringify({ tokens: [{ token: TOKEN2, scope: "read" }, { token: TOKEN, scope: "write" }] }),
  );
  assert.equal(await readApiToken(h.config.dataDir), TOKEN);
  await writeFile(tokenFile(), JSON.stringify({ tokens: [{ token: TOKEN, scope: "write" }] }));
});

test("a browser-supplied Authorization header is not forwarded", async () => {
  await h.request("GET", "/api/sn/node/status", { headers: { Authorization: "Bearer rpsn_" + "00".repeat(32) } });
  assert.equal(h.calls.at(-1)!.auth, `Bearer ${TOKEN}`);
});

test("the token never appears in responses or logs, even if the upstream echoes it", async () => {
  h.setUpstream((call) => ({
    status: 500,
    headers: { "X-Echo": call.auth ?? "" },
    body: JSON.stringify({ status: "error", error: `bad token ${call.auth}` }),
  }));
  const r = await h.request("GET", "/api/sn/node/status");
  assert.equal(r.status, 500);
  assert.ok(!r.text.includes(TOKEN), "token in body");
  assert.ok(!JSON.stringify(r.headers).includes(TOKEN), "token in headers");
  assert.ok(!h.logs.join("\n").includes(TOKEN), "token in logs");
  h.setUpstream(() => ({ body: '{"status":"success","error":""}' }));
});

test("no token file yet -> 503 and nothing forwarded", async () => {
  await rm(tokenFile());
  const before = h.calls.length;
  const r = await h.request("GET", "/api/sn/node/status");
  assert.equal(r.status, 503);
  assert.equal(h.calls.length, before);
  await writeFile(tokenFile(), JSON.stringify({ tokens: [{ token: TOKEN, scope: "write" }] }));
});

test("the log redactor removes tokens, bearer values, key/value secrets and phrases", () => {
  const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";
  const out = redact(
    `token ${TOKEN} Authorization: Bearer abc.def password=hunter22 {"mnemonic":"x y z"} privateKey: 0xdeadbeef ${phrase}`,
  );
  for (const s of [TOKEN, "abc.def", "hunter22", "x y z", "0xdeadbeef", phrase]) assert.ok(!out.includes(s), s);
});
