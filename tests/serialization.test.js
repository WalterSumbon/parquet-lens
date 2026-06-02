const assert = require("node:assert");
const test = require("node:test");
const { serializeRowForWebview } = require("../out/serialization");

test("serializes BigInt row ids and cell values into webview-safe values", () => {
  const row = serializeRowForWebview({
    __parquet_lens_row_id: 12n,
    id: 9223372036854775807n,
    name: "alpha"
  });

  assert.equal(row.__parquet_lens_row_id, "12");
  assert.equal(row.id.value, "9223372036854775807");
  assert.equal(row.id.display, "9223372036854775807");
  assert.doesNotThrow(() => JSON.stringify(row));
});
