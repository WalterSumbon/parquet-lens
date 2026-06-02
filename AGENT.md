Project decisions for Parquet Lens.

- This repository implements a production VS Code extension for viewing, querying, and editing Parquet files.
- UI text must be English.
- Core Parquet access uses DuckDB. Preview and SQL queries run against a `data` view backed by the active Parquet file.
- SQL/NL2SQL execution is read-only: only SELECT/WITH queries are accepted for preview execution.
- Preview limit defaults to 100. Users can change it or choose no limit.
- Editing is not in-place Parquet mutation. The first edit materializes the file into a temporary DuckDB table, edits update that table, and save atomically rewrites the Parquet file.
- Tests live under `tests/`.
- Release packages are built with `npm run package`; sample Parquet files live under `samples/` and are excluded from VSIX packages.
- Values sent to the webview must be JSON/structured-clone safe. DuckDB can return BigInt values, including generated row ids, so rows are serialized before `webview.postMessage`.
- SQL and NL input text are kept separately in the webview. NL2SQL configuration is editable in the webview and saved back to VS Code settings.
- Query results can be exported as standalone Parquet files through the webview; export uses the active SQL/NL query and current limit setting.
- Display cells mark NULL, empty strings, whitespace-only strings, and long-value suffixes with muted italic styling; these special values must not render as blank cells.
- Editable query detection is intentionally broader than `SELECT * FROM data`: simple single-table `SELECT` queries with `WHERE`, `ORDER BY`, and `LIMIT` remain editable by injecting an internal row id. Aggregations, DISTINCT, joins, unions, grouped queries, and expression columns stay read-only.
- Do not add a standalone README unless the user explicitly asks for one.
