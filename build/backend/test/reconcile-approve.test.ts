import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { addApprovedKeys, APPROVED_KEYS_FILE, readApprovedKeys } from "../src/reconcile/approved";
import { startHarness, type Harness } from "./helpers";

const pk = (c: string) => c.repeat(96);
const TX = "0x" + "ab".repeat(32);

// ---------- the approved list on disk ----------

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rp-approved-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("approved list: missing file is empty; add is append-only, deduplicated, 0600", async () => {
  assert.deepEqual(await readApprovedKeys(dir), { keys: new Set() });
  assert.equal(await addApprovedKeys(dir, [pk("1"), "0x" + pk("2").toUpperCase(), "junk", pk("1")], "deposit", new Date("2026-09-23T10:00:00Z")), 2);
  assert.equal(await addApprovedKeys(dir, [pk("1"), pk("3")], "owner", new Date("2026-09-24T10:00:00Z")), 1);
  const file = path.join(dir, APPROVED_KEYS_FILE);
  const data = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(data.keys[pk("1")], { source: "deposit", approvedAt: "2026-09-23T10:00:00.000Z" }, "an existing entry keeps its source");
  assert.equal(data.keys[pk("3")].source, "owner");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual([...(await readApprovedKeys(dir)).keys].sort(), [pk("1"), pk("2"), pk("3")]);
  assert.deepEqual((await readdir(dir)).sort(), [APPROVED_KEYS_FILE], "no temp files left");
});

test("approved list: concurrent adds are serialised and none is lost", async () => {
  await Promise.all([pk("1"), pk("2"), pk("3"), pk("4"), pk("5")].map((k) => addApprovedKeys(dir, [k], "owner")));
  assert.equal((await readApprovedKeys(dir)).keys.size, 5);
});

test("approved list: a corrupt file approves nothing and is kept aside, never deleted", async () => {
  const file = path.join(dir, APPROVED_KEYS_FILE);
  await writeFile(file, "{not json");
  const r = await readApprovedKeys(dir);
  assert.equal(r.keys.size, 0);
  assert.match(r.error!, /not valid/);
  await addApprovedKeys(dir, [pk("7")], "owner");
  const names = await readdir(dir);
  const aside = names.find((n) => n.startsWith(`${APPROVED_KEYS_FILE}.corrupt-`));
  assert.ok(aside, names.join(","));
  assert.equal(await readFile(path.join(dir, aside!), "utf8"), "{not json");
  assert.deepEqual([...(await readApprovedKeys(dir)).keys], [pk("7")]);
});

// ---------- HTTP: approve endpoint and the node/deposit hook ----------

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

const approvedFile = () => path.join(h.config.dataDir, APPROVED_KEYS_FILE);
const exists = (p: string) => stat(p).then(() => true, () => false);

async function reset() {
  await rm(approvedFile(), { force: true });
  await rm(h.config.reconcileTriggerFile, { force: true });
}

test("approve: needs the typed confirmation and valid pubkeys; nothing is written otherwise", async () => {
  await reset();
  for (const body of [
    { pubkeys: [pk("1")] },
    { pubkeys: [pk("1")], confirm: "load" },
    { pubkeys: [pk("1")], confirm: "YES" },
    { pubkeys: [], confirm: "LOAD" },
    { pubkeys: "0x" + pk("1"), confirm: "LOAD" },
    { pubkeys: [pk("1"), "0x1234"], confirm: "LOAD" },
    [pk("1")],
  ]) {
    const r = await h.post("/api/avado/reconcile/approve", body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await h.post("/api/avado/reconcile/approve", "{bad")).status, 400);
  assert.equal(
    (await h.post("/api/avado/reconcile/approve", "pubkeys=x&confirm=LOAD", { "Content-Type": "application/x-www-form-urlencoded" })).status,
    415,
  );
  assert.equal(await exists(approvedFile()), false);
  assert.equal(await exists(h.config.reconcileTriggerFile), false);
});

test("approve: CSRF and Host guards apply", async () => {
  await reset();
  const body = { pubkeys: [pk("1")], confirm: "LOAD" };
  assert.equal((await h.post("/api/avado/reconcile/approve", body, { "X-Avado-Request": "" })).status, 403);
  assert.equal((await h.post("/api/avado/reconcile/approve", body, { Origin: "http://evil.example" })).status, 403);
  assert.equal((await h.post("/api/avado/reconcile/approve", body, { Host: "evil.example" })).status, 421);
  assert.equal((await h.request("GET", "/api/avado/reconcile/approve")).status, 405);
  assert.equal(await exists(approvedFile()), false);
});

test("approve: appends the keys as owner-approved and asks for a run", async () => {
  await reset();
  const r = await h.post("/api/avado/reconcile/approve", { pubkeys: ["0x" + pk("1"), pk("2"), pk("1")], confirm: "LOAD" });
  assert.equal(r.status, 202);
  assert.deepEqual({ approved: r.json.approved, added: r.json.added, runRequested: r.json.runRequested }, { approved: 2, added: 2, runRequested: true });
  const data = JSON.parse(await readFile(approvedFile(), "utf8"));
  assert.deepEqual(Object.keys(data.keys).sort(), [pk("1"), pk("2")]);
  assert.equal(data.keys[pk("1")].source, "owner");
  assert.ok(await exists(h.config.reconcileTriggerFile));
});

test("node/deposit: a successful deposit approves the new keys; the answer is passed through unchanged", async () => {
  await reset();
  const answer = { status: "success", error: "", txHash: TX, validatorPubkeys: [pk("8"), pk("9")], scrubPeriod: 0 };
  h.setUpstream(() => ({ body: JSON.stringify(answer) }));
  const r = await h.post("/api/sn/node/deposit", { amountWei: "4000000000000000000", submit: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, answer);
  const data = JSON.parse(await readFile(approvedFile(), "utf8"));
  assert.deepEqual(Object.keys(data.keys).sort(), [pk("8"), pk("9")]);
  assert.equal(data.keys[pk("8")].source, "deposit");
  assert.ok(await exists(h.config.reconcileTriggerFile), "the loop is asked to load them");
});

test("node/deposit: errors, no transaction hash, or other routes approve nothing", async () => {
  await reset();
  const cases: Array<[string, unknown, number?]> = [
    ["node/deposit", { status: "error", error: "insufficient balance", validatorPubkeys: [pk("8")] }, 500],
    ["node/deposit", { status: "success", error: "", txHash: "0x" + "0".repeat(64), validatorPubkeys: [pk("8")] }],
    ["node/deposit", { status: "success", error: "", validatorPubkeys: [pk("8")] }],
    ["wallet/rebuild", { status: "success", error: "", txHash: TX, validatorPubkeys: [pk("8")], validatorKeys: [pk("8")] }],
  ];
  for (const [route, body, code] of cases) {
    h.setUpstream(() => ({ status: code ?? 200, body: JSON.stringify(body) }));
    await h.post(`/api/sn/${route}`, {});
  }
  assert.equal(await exists(approvedFile()), false);
  h.setUpstream(() => ({ body: '{"status":"success","error":""}' }));
});
