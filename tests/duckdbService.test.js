const assert = require("node:assert");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const duckdb = require("duckdb");
const { DuckDbParquetService, editRowIdColumn } = require("../out/duckdbService");

test("queries schema, applies limit, counts full result, edits, saves, and reloads parquet", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parquet-lens-test-"));
  const parquetPath = path.join(dir, "fixture.parquet");
  await createFixture(parquetPath);

  const service = new DuckDbParquetService(parquetPath);
  await service.initialize();

  const schema = await service.schema();
  assert.deepEqual(schema.map((field) => [field.name, field.type]), [
    ["id", "INTEGER"],
    ["name", "VARCHAR"],
    ["note", "VARCHAR"]
  ]);

  const limited = await service.query("SELECT * FROM data", { mode: "limited", value: 2 });
  assert.equal(limited.rows.length, 2);
  assert.equal(limited.rowCount, 3);
  assert.equal(limited.columnCount, 3);
  assert.equal(limited.editable, true);

  const filtered = await service.query("SELECT id, name FROM data WHERE id > 1", { mode: "none", value: 0 });
  assert.equal(filtered.rows.length, 2);
  assert.equal(filtered.rowCount, 2);
  assert.equal(filtered.columnCount, 2);
  assert.equal(filtered.editable, true);
  assert.notEqual(filtered.rows[0][editRowIdColumn], undefined);

  const firstRowId = Number(limited.rows[0][editRowIdColumn]);
  await service.editCell(firstRowId, "name", "changed");
  await service.save();
  const leftovers = await fs.readdir(dir);
  assert.equal(leftovers.some((entry) => entry.startsWith(".parquet-lens-")), false);
  service.close();

  const verify = new DuckDbParquetService(parquetPath);
  await verify.initialize();
  const saved = await verify.query("SELECT * FROM data WHERE id = 1", { mode: "none", value: 0 });
  assert.equal(saved.rows[0].name, "changed");
  verify.close();

  await fs.rm(dir, { recursive: true, force: true });
});

test("keeps aggregation results read-only", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parquet-lens-test-"));
  const parquetPath = path.join(dir, "fixture.parquet");
  await createFixture(parquetPath);

  const service = new DuckDbParquetService(parquetPath);
  await service.initialize();
  const result = await service.query("SELECT count(*) AS total FROM data", { mode: "none", value: 0 });
  assert.equal(result.editable, false);
  assert.equal(result.rows[0][editRowIdColumn], undefined);
  service.close();

  await fs.rm(dir, { recursive: true, force: true });
});

test("allows editing rows selected by a simple filtered query", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parquet-lens-test-"));
  const parquetPath = path.join(dir, "fixture.parquet");
  await createFixture(parquetPath);

  const service = new DuckDbParquetService(parquetPath);
  await service.initialize();
  const filtered = await service.query("SELECT id, name FROM data WHERE id = 2", { mode: "none", value: 0 });
  assert.equal(filtered.editable, true);
  await service.editCell(Number(filtered.rows[0][editRowIdColumn]), "name", "located");
  await service.save();
  service.close();

  const verify = new DuckDbParquetService(parquetPath);
  await verify.initialize();
  const saved = await verify.query("SELECT id, name FROM data WHERE id = 2", { mode: "none", value: 0 });
  assert.equal(saved.rows[0].name, "located");
  verify.close();

  await fs.rm(dir, { recursive: true, force: true });
});

test("revert drops unsaved edits", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parquet-lens-test-"));
  const parquetPath = path.join(dir, "fixture.parquet");
  await createFixture(parquetPath);

  const service = new DuckDbParquetService(parquetPath);
  await service.initialize();
  const result = await service.query("SELECT * FROM data", { mode: "limited", value: 1 });
  await service.editCell(Number(result.rows[0][editRowIdColumn]), "name", "unsaved");
  await service.revert();
  const reverted = await service.query("SELECT * FROM data WHERE id = 1", { mode: "none", value: 0 });
  assert.equal(reverted.rows[0].name, "alpha");
  service.close();

  await fs.rm(dir, { recursive: true, force: true });
});

test("does not expose legacy internal-looking user columns in UI or export results", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parquet-lens-test-"));
  const parquetPath = path.join(dir, "fixture.parquet");
  const exportPath = path.join(dir, "exported.parquet");
  await createFixtureWithLegacyInternalColumn(parquetPath);

  const service = new DuckDbParquetService(parquetPath);
  await service.initialize();
  const result = await service.query("SELECT * FROM data", { mode: "none", value: 0 });
  assert.equal(result.editable, true);
  assert.deepEqual(result.columns.map((column) => column.name), ["id", "name"]);
  assert.equal(Object.keys(result.rows[0]).includes("__parquet_lens_row_id"), false);
  assert.equal(Object.keys(result.rows[0]).includes("__parquet_lens_row_id_1"), false);
  assert.notEqual(result.rows[0][editRowIdColumn], undefined);

  await service.exportQuery("SELECT * FROM data", { mode: "none", value: 0 }, exportPath);
  service.close();

  const exported = new DuckDbParquetService(exportPath);
  await exported.initialize();
  const exportedResult = await exported.query("SELECT * FROM data", { mode: "none", value: 0 });
  assert.deepEqual(exportedResult.columns.map((column) => column.name), ["id", "name"]);
  exported.close();

  await fs.rm(dir, { recursive: true, force: true });
});

test("keeps result columns when a query returns zero rows", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parquet-lens-test-"));
  const parquetPath = path.join(dir, "fixture.parquet");
  await createFixture(parquetPath);

  const service = new DuckDbParquetService(parquetPath);
  await service.initialize();
  const result = await service.query("SELECT id, name FROM data WHERE id < 0", { mode: "none", value: 0 });
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.columns.map((column) => column.name), ["id", "name"]);
  assert.equal(result.columnCount, 2);
  service.close();

  await fs.rm(dir, { recursive: true, force: true });
});

test("exports the current query result to a standalone parquet file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parquet-lens-test-"));
  const parquetPath = path.join(dir, "fixture.parquet");
  const exportPath = path.join(dir, "exported.parquet");
  await createFixture(parquetPath);

  const service = new DuckDbParquetService(parquetPath);
  await service.initialize();
  await service.exportQuery("SELECT id, name FROM data ORDER BY id", { mode: "limited", value: 2 }, exportPath);
  service.close();

  const exported = new DuckDbParquetService(exportPath);
  await exported.initialize();
  const result = await exported.query("SELECT * FROM data", { mode: "none", value: 0 });
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.columns.map((column) => column.name), ["id", "name"]);
  assert.deepEqual(result.rows.map((row) => row.name), ["alpha", "beta"]);
  exported.close();

  await fs.rm(dir, { recursive: true, force: true });
});

async function createFixture(parquetPath) {
  const db = new duckdb.Database(":memory:");
  const conn = db.connect();
  await loadParquet(conn);
  await run(conn, "CREATE TABLE fixture(id INTEGER, name VARCHAR, note VARCHAR)");
  await run(conn, "INSERT INTO fixture VALUES (1, 'alpha', 'short'), (2, 'beta', NULL), (3, 'gamma', repeat('x', 240))");
  await run(conn, `COPY fixture TO '${parquetPath.replaceAll("'", "''")}' (FORMAT PARQUET)`);
  conn.close();
}

async function createFixtureWithLegacyInternalColumn(parquetPath) {
  const db = new duckdb.Database(":memory:");
  const conn = db.connect();
  await loadParquet(conn);
  await run(conn, "CREATE TABLE fixture(id INTEGER, name VARCHAR, __parquet_lens_row_id INTEGER)");
  await run(conn, "INSERT INTO fixture VALUES (1, 'alpha', 999)");
  await run(conn, `COPY fixture TO '${parquetPath.replaceAll("'", "''")}' (FORMAT PARQUET)`);
  conn.close();
}

async function loadParquet(conn) {
  try {
    await run(conn, "LOAD parquet");
  } catch {
    await run(conn, "INSTALL parquet");
    await run(conn, "LOAD parquet");
  }
}

function run(conn, sql) {
  return new Promise((resolve, reject) => {
    conn.run(sql, (error) => error ? reject(error) : resolve());
  });
}
