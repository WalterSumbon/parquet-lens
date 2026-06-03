const assert = require("node:assert");
const test = require("node:test");
const { serializeRowForWebview } = require("../out/serialization");
const { editRowIdColumn } = require("../out/duckdbService");

test("serializes BigInt row ids and cell values into webview-safe values", () => {
  const row = serializeRowForWebview({
    [editRowIdColumn]: 12n,
    id: 9223372036854775807n,
    name: "alpha"
  });

  assert.equal(row[editRowIdColumn], "12");
  assert.equal(row.id.value, "9223372036854775807");
  assert.equal(row.id.display, "9223372036854775807");
  assert.doesNotThrow(() => JSON.stringify(row));
});

test("drops legacy internal-looking columns from webview payloads", () => {
  const row = serializeRowForWebview({
    [editRowIdColumn]: 1n,
    __parquet_lens_row_id: 2,
    __parquet_lens_row_id_1: 3,
    name: "alpha"
  });

  assert.equal(row[editRowIdColumn], "1");
  assert.equal(row.__parquet_lens_row_id, undefined);
  assert.equal(row.__parquet_lens_row_id_1, undefined);
  assert.equal(row.name.display, "alpha");
});
