import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBigJson, quoteBigNumbers } from "../src/sn/bigjson";

test("numbers above 2^53 become exact strings; safe numbers stay numbers", () => {
  const out = parseBigJson(
    '{"wei":1000000000000000000000,"neg":-123456789012345678901,"safe":9007199254740991,"unsafe":9007199254740992,"small":42,"f":0.5,"arr":[1,18446744073709551615]}',
  ) as Record<string, unknown>;
  assert.equal(out.wei, "1000000000000000000000");
  assert.equal(out.neg, "-123456789012345678901");
  assert.equal(out.safe, 9007199254740991);
  assert.equal(out.unsafe, "9007199254740992");
  assert.equal(out.small, 42);
  assert.equal(out.f, 0.5);
  assert.deepEqual(out.arr, [1, "18446744073709551615"]);
});

test("digits inside strings (with escapes) are left alone", () => {
  const text = '{"s":"a \\"1000000000000000000000\\" b","t":"12345678901234567890","n":12345678901234567890}';
  const out = parseBigJson(text) as Record<string, unknown>;
  assert.equal(out.s, 'a "1000000000000000000000" b');
  assert.equal(out.t, "12345678901234567890");
  assert.equal(out.n, "12345678901234567890");
});

test("large exponent floats are kept as their original text", () => {
  const out = parseBigJson('{"x":1.5e+21,"y":1e-7}') as Record<string, unknown>;
  assert.equal(out.x, "1.5e+21");
  assert.equal(out.y, 1e-7);
});

test("text without big numbers is unchanged", () => {
  const text = '{"a":[1,2,{"b":"c"}],"d":true,"e":null}';
  assert.equal(quoteBigNumbers(text), text);
});

test("invalid JSON still throws", () => {
  assert.throws(() => parseBigJson("{not json"));
});
