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
  assert.equal(cell.kind, "binary-error");
  assert.match(cell.error, /could not be decoded/);
});

test("formats null values explicitly for display", () => {
  const cell = formatCell(null);
  assert.equal(cell.display, "NULL");
  assert.equal(cell.kind, "null");
  assert.equal(cell.truncated, false);
});

test("formats empty strings explicitly for display", () => {
  const cell = formatCell("");
  assert.equal(cell.display, "EMPTY STRING");
  assert.equal(cell.kind, "empty-string");
  assert.equal(cell.fullLength, 0);
});

test("formats whitespace-only strings explicitly for display", () => {
  const cell = formatCell("  \n\t");
  assert.equal(cell.display, "WHITESPACE (4 chars)");
  assert.equal(cell.kind, "blank-string");
  assert.equal(cell.fullLength, 4);
});
