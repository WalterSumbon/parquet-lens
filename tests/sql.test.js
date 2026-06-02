const assert = require("node:assert");
const test = require("node:test");
const { applyLimit, assertReadOnlyQuery, countQuery } = require("../out/sql");

test("applies default-style limit by wrapping a read-only query", () => {
  const sql = applyLimit("SELECT * FROM data", { mode: "limited", value: 100 });
  assert.equal(sql, "SELECT * FROM (SELECT * FROM data) AS parquet_lens_query LIMIT 100");
});

test("supports no limit without wrapping", () => {
  const sql = applyLimit("SELECT * FROM data;", { mode: "none", value: 100 });
  assert.equal(sql, "SELECT * FROM data");
});

test("rejects mutating SQL", () => {
  assert.throws(() => assertReadOnlyQuery("DELETE FROM data"), /Only SELECT or WITH/);
  assert.throws(() => assertReadOnlyQuery("SELECT * FROM data; DROP TABLE data"), /Multiple SQL/);
  assert.throws(() => assertReadOnlyQuery("WITH x AS (UPDATE data SET a = 1) SELECT * FROM data"), /read-only/);
});

test("builds count query separately from preview limit", () => {
  assert.equal(
    countQuery("SELECT a FROM data WHERE a > 1"),
    "SELECT COUNT(*) AS row_count FROM (SELECT a FROM data WHERE a > 1) AS parquet_lens_count"
  );
});

test("rejects invalid limit values", () => {
  assert.throws(() => applyLimit("SELECT * FROM data", { mode: "limited", value: -1 }), /Limit/);
  assert.throws(() => applyLimit("SELECT * FROM data", { mode: "limited", value: 1.5 }), /Limit/);
});
