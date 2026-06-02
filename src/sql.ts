export interface LimitSelection {
  readonly mode: "limited" | "none";
  readonly value: number;
}

const destructiveTokens = /\b(ALTER|ATTACH|CALL|COPY|CREATE|DELETE|DETACH|DROP|EXPORT|IMPORT|INSERT|INSTALL|LOAD|MERGE|PRAGMA|SET|TRUNCATE|UPDATE|VACUUM)\b/i;

export function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+$/u, "").trim();
}

export function assertReadOnlyQuery(sql: string): string {
  const normalized = stripTrailingSemicolon(sql);
  if (normalized.length === 0) {
    throw new Error("SQL query is empty.");
  }

  if (normalized.includes(";")) {
    throw new Error("Multiple SQL statements are not allowed.");
  }

  if (!/^(SELECT|WITH)\b/i.test(normalized)) {
    throw new Error("Only SELECT or WITH queries are allowed.");
  }

  if (destructiveTokens.test(normalized)) {
    throw new Error("Only read-only SQL queries are allowed.");
  }

  return normalized;
}

export function applyLimit(sql: string, limit: LimitSelection): string {
  const readonlySql = assertReadOnlyQuery(sql);
  if (limit.mode === "none") {
    return readonlySql;
  }

  if (!Number.isInteger(limit.value) || limit.value < 0) {
    throw new Error("Limit must be a non-negative integer.");
  }

  return `SELECT * FROM (${readonlySql}) AS parquet_lens_query LIMIT ${limit.value}`;
}

export function countQuery(sql: string): string {
  const readonlySql = assertReadOnlyQuery(sql);
  return `SELECT COUNT(*) AS row_count FROM (${readonlySql}) AS parquet_lens_count`;
}
