const assert = require("node:assert");
const test = require("node:test");
const { formatCell } = require("../out/cells");

test("truncates long strings and reports full length", () => {
  const cell = formatCell("abcdefghijklmnopqrstuvwxyz", 16);
  assert.equal(cell.truncated, true);
  assert.equal(cell.fullLength, 26);
  assert.match(cell.display, /\(26 chars\)$/);
});

test("decodes valid utf8 binary values", () => {
  const cell = formatCell(Buffer.from("hello", "utf8"));
  assert.equal(cell.display, "hello");
  assert.equal(cell.error, undefined);
});

test("reports undecodable binary values explicitly", () => {
  const cell = formatCell(Buffer.from([0xff, 0xfe, 0xfd]));
  assert.equal(cell.display, "[binary data]");
  assert.match(cell.error, /could not be decoded/);
});
