# Parquet Lens

Parquet Lens is a VS Code extension for viewing, querying, editing, and exporting Parquet files directly inside VS Code.

It is designed for large local Parquet files, SQL-driven inspection, and practical data-cleaning workflows where you need to locate rows, inspect long values, and safely persist edits.

## Highlights

- Open `.parquet` and `.parq` files in a custom VS Code editor.
- Query files with DuckDB SQL.
- Default preview limit is enabled at `100` rows; clear the Limit checkbox to return all rows.
- Show total result rows and column count for the active query.
- Show schema in a collapsed panel by default.
- Edit cells from editable query results and save changes back to the Parquet file.
- Export the current query result as a standalone Parquet file.
- Show a collapsible row number column with 0-based and 1-based display modes.
- Truncate long values in the grid while showing their full character length.
- Mark `NULL`, empty strings, and whitespace-only strings explicitly with muted italic styling.
- Use an Excel-like value editor above the grid for previewing and editing the selected cell.
- Run queries quickly with `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows/Linux.
- Show clear running feedback on query execution, with a stop action that ignores a pending result.
- Reset query and view state back to the default preview without discarding unsaved edits.
- Generate SQL from natural language with OpenAI-compatible `/chat/completions` APIs.

## Install

### Install from a VSIX file

Download the latest `.vsix` from the GitHub Releases page, then install it with:

```bash
code --install-extension parquet-lens-0.1.0.vsix --force
```

Reload VS Code after installation:

1. Open the Command Palette.
2. Run `Developer: Reload Window`.

### Build and install locally

```bash
npm install
npm test
npm run package
code --install-extension parquet-lens-0.1.0.vsix --force
```

## Usage

1. Open a `.parquet` or `.parq` file in VS Code.
2. Use SQL mode to query the table named `data`.
3. Keep Limit enabled for fast previews, or clear it to return the full result.
4. Expand Schema when you need column names and types.
5. Select a cell to preview its full value in the editor above the grid.
6. Edit cells in editable query results and save the editor to rewrite the Parquet file.
7. Use Export to save the current query result as a separate Parquet file.
8. Use `Cmd+Enter` or `Ctrl+Enter` in the SQL/NL input to run the query.
9. Left-click the row number header to collapse or expand row numbers; right-click it to switch between 0-based and 1-based numbering.
10. Use Reset to return to the default SQL preview, default limit, row numbering, and cleared selection. Reset does not discard unsaved data edits.

Editable queries include simple single-table `SELECT` queries against `data`, including `WHERE`, `ORDER BY`, and `LIMIT`. Aggregations, `DISTINCT`, joins, unions, grouped queries, and expression columns are read-only to avoid unsafe writes.

Parquet Lens uses an internal row id to support reliable editing, but that internal field is hidden from the grid and removed from exported query results.

## NL2SQL

Switch to NL mode to generate SQL from natural language. Configure the OpenAI-compatible API in the collapsed NL2SQL configuration panel or in VS Code settings:

- `parquetLens.nl2sql.baseUrl`
- `parquetLens.nl2sql.apiKey`
- `parquetLens.nl2sql.model`
- `parquetLens.nl2sql.promptTemplate`
- `parquetLens.nl2sql.timeoutMs`
- `parquetLens.nl2sql.headers`

The prompt template must include `{{nl}}`. It may also include `{{schema}}`.

## Development

```bash
npm install
npm test
npm run package
```

The extension uses DuckDB for Parquet reading, SQL execution, schema inspection, result export, and Parquet rewrites on save.

## License

MIT
