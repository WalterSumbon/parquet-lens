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

const editRowIdColumn = "__parquet_lens_row_id";
const editTableName = "parquet_lens_edit";

export class DuckDbParquetService {
  private readonly db: duckdb.Database;
  private readonly conn: duckdb.Connection;
  private readonly parquetPath: string;
  private isEditing = false;

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
      columns: columns.filter((column) => column.name !== editRowIdColumn),
      rows,
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
    const resultSql = applyLimit(sql, limit);
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
    await this.run(`CREATE TABLE ${editTableName} AS SELECT row_number() OVER () - 1 AS ${quoteIdentifier(editRowIdColumn)}, * FROM read_parquet(${quoteString(this.parquetPath)}, binary_as_string = true)`);
    await this.run(`CREATE OR REPLACE VIEW data AS SELECT * EXCLUDE (${quoteIdentifier(editRowIdColumn)}) FROM ${editTableName}`);
    this.isEditing = true;
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

export { editRowIdColumn };
