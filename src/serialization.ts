import { formatCell, DisplayCell } from "./cells";
import { editRowIdColumn, QueryColumn, SchemaField } from "./duckdbService";

export type WebviewCellValue = string | number | boolean | null;

export interface WebviewDisplayCell extends Omit<DisplayCell, "value"> {
  readonly value: WebviewCellValue;
}

export function serializeRowForWebview(row: Record<string, unknown>): Record<string, unknown> {
  const serialized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === editRowIdColumn) {
      serialized[key] = serializeScalar(value);
      continue;
    }

    const cell = formatCell(value);
    serialized[key] = {
      ...cell,
      value: serializeScalar(cell.value)
    } satisfies WebviewDisplayCell;
  }
  return serialized;
}

export function columnsFromSchema(schema: SchemaField[]): QueryColumn[] {
  return schema.map((field) => ({
    name: field.name,
    type: field.type
  }));
}

export function serializeScalar(value: unknown): WebviewCellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  return String(value);
}
