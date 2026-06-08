import * as fs from "node:fs/promises";
import * as path from "node:path";
import duckdb from "duckdb";
import { applyLimit, assertReadOnlyQuery, countQuery, LimitSelection } from "./sql";

export interface QueryColumn {
  readonly name: string;
  readonly type?: string;
}

export interface QueryResult {
  readonly columns: QueryColumn[];
  readonly rows: Array<Record<string, unknown>>;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly editable: boolean;
}

interface EditableQuery {
  readonly sql: string;
}

export interface SchemaField {
  readonly name: string;
  readonly type: string;
  readonly nullable: string | null;
}

const editRowIdColumn = "__parquet_lens_internal_row_id__9f6f0f79";
const editTableName = "parquet_lens_edit";
const legacyInternalColumnPattern = /^__parquet_lens_row_id(?:_\d+)?$/u;
const currentInternalColumnPattern = /^__parquet_lens_internal_row_id__9f6f0f79(?:_\d+)?$/u;
const insertColumnTypeOptions = ["VARCHAR", "BIGINT", "DOUBLE", "BOOLEAN", "TIMESTAMP", "DATE", "INTEGER", "DECIMAL(18,2)", "FLOAT", "BLOB"] as const;
type InsertColumnType = typeof insertColumnTypeOptions[number];

export class DuckDbParquetService {
  private readonly db: duckdb.Database;
  private readonly conn: duckdb.Connection;
  private readonly parquetPath: string;
  private isEditing = false;
  private snapshotCounter = 0;

  constructor(parquetPath: string) {
    this.parquetPath = parquetPath;
    this.db = new duckdb.Database(":memory:");
    this.conn = this.db.connect();
  }

  async initialize(): Promise<void> {
    await this.loadParquetExtension();
    await this.createReadOnlyView();
  }

  close(): void {
    this.conn.close();
  }

  async query(sql: string, limit: LimitSelection): Promise<QueryResult> {
    const readonlySql = assertReadOnlyQuery(sql);
    const editableQuery = this.toEditableQuery(readonlySql);
    const editable = editableQuery !== undefined;
    const resultSql = editableQuery ? applyLimit(editableQuery.sql, limit) : applyLimit(readonlySql, limit);
    const rows = await this.all(resultSql);
    const columns = rows.length > 0 ? inferColumns(rows) : await this.getColumns(readonlySql);
    const countRows = await this.all(countQuery(readonlySql)) as Array<{ row_count: number | bigint }>;
    const rowCount = Number(countRows[0]?.row_count ?? rows.length);
    const columnCount = await this.getColumnCount(readonlySql, columns.length);

    return {
      columns: columns.filter((column) => !isInternalColumn(column.name)),
      rows: rows.map((row) => filterInternalColumns(row, { keepRowId: true })),
      rowCount,
      columnCount,
      editable
    };
  }

  async schema(): Promise<SchemaField[]> {
    const rows = await this.all("DESCRIBE SELECT * FROM data") as Array<{
      column_name: string;
      column_type: string;
      null: string | null;
    }>;

    return rows.map((row) => ({
      name: row.column_name,
      type: row.column_type,
      nullable: row.null
    }));
  }

  async editCell(rowId: number, columnName: string, value: unknown): Promise<void> {
    await this.ensureEditableTable();
    if (columnName === editRowIdColumn) {
      throw new Error("Internal row id column cannot be edited.");
    }

    const schema = await this.schema();
    if (!schema.some((field) => field.name === columnName)) {
      throw new Error(`Column does not exist: ${columnName}`);
    }

    await this.run(
      `UPDATE ${editTableName} SET ${quoteIdentifier(columnName)} = ? WHERE ${quoteIdentifier(editRowIdColumn)} = ?`,
      value,
      rowId
    );
  }

  async createEditSnapshot(): Promise<string> {
    await this.ensureEditableTable();
    const snapshotName = `parquet_lens_snapshot_${++this.snapshotCounter}`;
    await this.run(`CREATE TEMP TABLE ${quoteIdentifier(snapshotName)} AS SELECT * FROM ${editTableName}`);
    return snapshotName;
  }

  async restoreEditSnapshot(snapshotName: string): Promise<void> {
    await this.run(`DROP TABLE IF EXISTS ${editTableName}`);
    await this.run(`CREATE TABLE ${editTableName} AS SELECT * FROM ${quoteIdentifier(snapshotName)}`);
    await this.createEditableView();
    this.isEditing = true;
  }

  async deleteRows(rowIds: number[]): Promise<void> {
    await this.ensureEditableTable();
    const uniqueIds = [...new Set(rowIds)];
    if (uniqueIds.length === 0) {
      return;
    }

    await this.run(
      `DELETE FROM ${editTableName} WHERE ${quoteIdentifier(editRowIdColumn)} IN (${uniqueIds.map(() => "?").join(", ")})`,
      ...uniqueIds
    );
  }

  async insertRow(anchorRowId: number | null, position: "above" | "below" | "end"): Promise<void> {
    await this.ensureEditableTable();
    const schema = await this.schema();
    if (schema.length === 0) {
      throw new Error("Add a column before adding rows.");
    }

    const rowId = await this.newRowId(anchorRowId, position);
    const columns = [editRowIdColumn, ...schema.map((field) => field.name)];
    const placeholders = columns.map(() => "?").join(", ");
    await this.run(
      `INSERT INTO ${editTableName} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders})`,
      rowId,
      ...schema.map(() => null)
    );
  }

  async deleteColumns(columnNames: string[]): Promise<void> {
    await this.ensureEditableTable();
    const schema = await this.schema();
    const existing = new Set(schema.map((field) => field.name));
    const toDelete = [...new Set(columnNames)].filter((columnName) => existing.has(columnName));
    if (toDelete.length === 0) {
      return;
    }
    if (toDelete.length >= schema.length) {
      throw new Error("Cannot delete all columns. Add another column first.");
    }

    const nextColumns = schema
      .map((field) => field.name)
      .filter((columnName) => !toDelete.includes(columnName));
    await this.rebuildEditTable(nextColumns);
  }

  async insertColumn(anchorColumnName: string | null, position: "left" | "right" | "end", columnName: string, columnType = "VARCHAR"): Promise<void> {
    await this.ensureEditableTable();
    const normalized = columnName.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized)) {
      throw new Error("Column name must start with a letter or underscore and contain only letters, numbers, and underscores.");
    }
    const normalizedType = normalizeInsertColumnType(columnType);

    const schema = await this.schema();
    if (schema.some((field) => field.name === normalized)) {
      throw new Error(`Column already exists: ${normalized}`);
    }

    const currentColumns = schema.map((field) => field.name);
    const anchorIndex = anchorColumnName ? currentColumns.indexOf(anchorColumnName) : -1;
    const insertIndex = anchorIndex < 0 || position === "end"
      ? currentColumns.length
      : position === "left"
        ? anchorIndex
        : anchorIndex + 1;
    const nextColumns = [
      ...currentColumns.slice(0, insertIndex),
      normalized,
      ...currentColumns.slice(insertIndex)
    ];
    await this.rebuildEditTable(nextColumns, normalized, normalizedType);
  }

  async save(): Promise<void> {
    if (!this.isEditing) {
      return;
    }

    const tempDir = await fs.mkdtemp(path.join(path.dirname(this.parquetPath), ".parquet-lens-"));
    const tempPath = path.join(tempDir, path.basename(this.parquetPath));
    const tempSqlPath = quoteString(tempPath);
    const originalPath = this.parquetPath;

    try {
      await this.run(`COPY (SELECT * EXCLUDE (${quoteIdentifier(editRowIdColumn)}) FROM ${editTableName} ORDER BY ${quoteIdentifier(editRowIdColumn)}) TO ${tempSqlPath} (FORMAT PARQUET)`);
      await fs.rename(tempPath, originalPath);
      await fs.rm(tempDir, { recursive: true, force: true });
      await this.createReadOnlyView();
      this.isEditing = false;
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  async exportQuery(sql: string, limit: LimitSelection, destinationPath: string): Promise<void> {
    const readonlySql = assertReadOnlyQuery(sql);
    const editableQuery = this.toEditableQuery(readonlySql);
    const baseSql = editableQuery ? stripInternalColumnsQuery(editableQuery.sql) : readonlySql;
    const resultSql = applyLimit(baseSql, limit);
    await this.run(`COPY (${resultSql}) TO ${quoteString(destinationPath)} (FORMAT PARQUET)`);
  }

  async revert(): Promise<void> {
    await this.run(`DROP TABLE IF EXISTS ${editTableName}`);
    this.isEditing = false;
    await this.createReadOnlyView();
  }

  private async ensureEditableTable(): Promise<void> {
    if (this.isEditing) {
      return;
    }

    await this.run(`DROP TABLE IF EXISTS ${editTableName}`);
    await this.run(`CREATE TABLE ${editTableName} AS SELECT (row_number() OVER () - 1)::DOUBLE AS ${quoteIdentifier(editRowIdColumn)}, * FROM read_parquet(${quoteString(this.parquetPath)}, binary_as_string = true)`);
    await this.createEditableView();
    this.isEditing = true;
  }

  private async createEditableView(): Promise<void> {
    await this.run(`CREATE OR REPLACE VIEW data AS SELECT * EXCLUDE (${quoteIdentifier(editRowIdColumn)}) FROM ${editTableName}`);
  }

  private async loadParquetExtension(): Promise<void> {
    try {
      await this.run("LOAD parquet");
    } catch {
      await this.run("INSTALL parquet");
      await this.run("LOAD parquet");
    }
  }

  private async createReadOnlyView(): Promise<void> {
    await this.run(`DROP VIEW IF EXISTS data`);
    await this.run(`CREATE VIEW data AS SELECT * FROM read_parquet(${quoteString(this.parquetPath)}, binary_as_string = true)`);
  }

  private async newRowId(anchorRowId: number | null, position: "above" | "below" | "end"): Promise<number> {
    const rows = await this.all(`SELECT ${quoteIdentifier(editRowIdColumn)} AS row_id FROM ${editTableName} ORDER BY ${quoteIdentifier(editRowIdColumn)}`) as Array<{ row_id: number }>;
    if (rows.length === 0 || anchorRowId === null || position === "end") {
      const maxRows = await this.all(`SELECT MAX(${quoteIdentifier(editRowIdColumn)}) AS max_id FROM ${editTableName}`) as Array<{ max_id: number | null }>;
      return Number(maxRows[0]?.max_id ?? -1) + 1;
    }

    const ids = rows.map((row) => Number(row.row_id));
    const index = ids.findIndex((id) => id === anchorRowId);
    if (index < 0) {
      return ids[ids.length - 1] + 1;
    }

    if (position === "above") {
      const previous = index > 0 ? ids[index - 1] : ids[index] - 1;
      return (previous + ids[index]) / 2;
    }

    const next = index < ids.length - 1 ? ids[index + 1] : ids[index] + 1;
    return (ids[index] + next) / 2;
  }

  private async rebuildEditTable(orderedUserColumns: string[], insertedColumnName?: string, insertedColumnType: InsertColumnType = "VARCHAR"): Promise<void> {
    const tempName = `parquet_lens_rebuild_${++this.snapshotCounter}`;
    const selectParts = [
      quoteIdentifier(editRowIdColumn),
      ...orderedUserColumns.map((columnName) => {
        if (columnName === insertedColumnName) {
          return `NULL::${insertedColumnType} AS ${quoteIdentifier(columnName)}`;
        }
        return quoteIdentifier(columnName);
      })
    ];
    await this.run(`CREATE TABLE ${quoteIdentifier(tempName)} AS SELECT ${selectParts.join(", ")} FROM ${editTableName}`);
    await this.run(`DROP TABLE ${editTableName}`);
    await this.run(`CREATE TABLE ${editTableName} AS SELECT * FROM ${quoteIdentifier(tempName)}`);
    await this.run(`DROP TABLE ${quoteIdentifier(tempName)}`);
    await this.createEditableView();
  }

  private editablePreviewSql(limit: LimitSelection): string {
    const source = `SELECT * FROM ${this.editableSource()} ORDER BY ${quoteIdentifier(editRowIdColumn)}`;

    if (limit.mode === "none") {
      return source;
    }

    return `SELECT * FROM (${source}) AS parquet_lens_editable_preview LIMIT ${limit.value}`;
  }

  private toEditableQuery(sql: string): EditableQuery | undefined {
    const match = sql.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+data\b([\s\S]*)$/iu);
    if (!match) {
      return undefined;
    }

    const selectList = match[1]?.trim();
    const tail = match[2]?.trim() ?? "";
    if (!selectList || !isEditableSelectList(selectList) || !isEditableTail(tail)) {
      return undefined;
    }

    const prefix = tail.length > 0 ? ` ${tail}` : "";
    return {
      sql: `SELECT ${quoteIdentifier(editRowIdColumn)}, ${selectList} FROM ${this.editableSource()}${prefix}`
    };
  }

  private editableSource(): string {
    if (this.isEditing) {
      return `(SELECT * FROM ${editTableName}) AS data`;
    }

    return `(SELECT row_number() OVER () - 1 AS ${quoteIdentifier(editRowIdColumn)}, * FROM read_parquet(${quoteString(this.parquetPath)}, binary_as_string = true)) AS data`;
  }

  private async getColumnCount(sql: string, fallback: number): Promise<number> {
    try {
      const rows = await this.all(`DESCRIBE ${assertReadOnlyQuery(sql)}`) as Array<unknown>;
      return rows.length;
    } catch {
      return fallback;
    }
  }

  private async getColumns(sql: string): Promise<QueryColumn[]> {
    const rows = await this.all(`DESCRIBE ${assertReadOnlyQuery(sql)}`) as Array<{
      column_name: string;
      column_type: string;
    }>;
    return rows.map((row) => ({
      name: row.column_name,
      type: row.column_type
    }));
  }

  private run(sql: string, ...params: unknown[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const callback = (error: Error | null) => error ? reject(error) : resolve();
      if (params.length === 0) {
        this.conn.run(sql, callback);
      } else {
        this.conn.run(sql, ...params, callback);
      }
    });
  }

  private all(sql: string, ...params: unknown[]): Promise<Array<Record<string, unknown>>> {
    return new Promise((resolve, reject) => {
      const callback = (error: Error | null, rows: Array<Record<string, unknown>>) => error ? reject(error) : resolve(rows);
      if (params.length === 0) {
        this.conn.all(sql, callback);
      } else {
        this.conn.all(sql, ...params, callback);
      }
    });
  }
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

export function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function isInternalColumn(columnName: string): boolean {
  return currentInternalColumnPattern.test(columnName) || legacyInternalColumnPattern.test(columnName);
}

function filterInternalColumns(row: Record<string, unknown>, options: { keepRowId: boolean }): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === editRowIdColumn && options.keepRowId) {
      filtered[key] = value;
      continue;
    }
    if (!isInternalColumn(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function stripInternalColumnsQuery(sql: string): string {
  return `SELECT * EXCLUDE (${quoteIdentifier(editRowIdColumn)}) FROM (${sql}) AS parquet_lens_export`;
}

function inferColumns(rows: Array<Record<string, unknown>>): QueryColumn[] {
  const first = rows[0];
  if (!first) {
    return [];
  }

  return Object.keys(first).map((name) => ({ name }));
}

function isEditableSelectList(selectList: string): boolean {
  if (/\bDISTINCT\b/iu.test(selectList) || /\*/u.test(selectList) && selectList.trim() !== "*") {
    return false;
  }
  if (/\b(COUNT|SUM|AVG|MIN|MAX|MEDIAN|MODE|STRING_AGG|ARRAY_AGG|LIST|FIRST|LAST)\s*\(/iu.test(selectList)) {
    return false;
  }
  if (/[()+*/]/u.test(selectList) && selectList.trim() !== "*") {
    return false;
  }
  if (selectList.trim() === "*") {
    return true;
  }

  return selectList.split(",").every((part) => {
    const column = part.trim();
    return /^("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)$/u.test(column);
  });
}

function isEditableTail(tail: string): boolean {
  return !/\b(JOIN|UNION|INTERSECT|EXCEPT|GROUP\s+BY|HAVING|PIVOT|UNPIVOT)\b/iu.test(tail);
}

function normalizeInsertColumnType(columnType: string): InsertColumnType {
  const normalized = columnType.trim().toUpperCase();
  if ((insertColumnTypeOptions as readonly string[]).includes(normalized)) {
    return normalized as InsertColumnType;
  }
  throw new Error(`Unsupported column type: ${columnType}`);
}

export { editRowIdColumn, insertColumnTypeOptions };
