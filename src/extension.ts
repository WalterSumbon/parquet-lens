import * as path from "node:path";
import * as vscode from "vscode";
import { DuckDbParquetService, editRowIdColumn } from "./duckdbService";
import { requestNl2Sql, Nl2SqlConfig } from "./nl2sql";
import { columnsFromSchema, serializeRowForWebview } from "./serialization";
import { assertReadOnlyQuery, LimitSelection } from "./sql";

interface WebviewQueryRequest {
  readonly command: "query";
  readonly requestId: string;
  readonly mode: "sql" | "nl";
  readonly text: string;
  readonly limit: LimitSelection;
}

interface WebviewEditRequest {
  readonly command: "editCell";
  readonly requestId: string;
  readonly rowId: number;
  readonly columnName: string;
  readonly previousValue: unknown;
  readonly value: unknown;
}

type WebviewRequest = WebviewQueryRequest | WebviewEditRequest | {
  readonly command: "ready" | "schema" | "revert";
  readonly requestId?: string;
} | {
  readonly command: "updateNl2sqlConfig";
  readonly requestId?: string;
  readonly config: Partial<Nl2SqlConfig>;
} | {
  readonly command: "exportResult";
  readonly requestId: string;
  readonly mode: "sql" | "nl";
  readonly text: string;
  readonly limit: LimitSelection;
} | {
  readonly command: "deleteRows";
  readonly requestId: string;
  readonly rowIds: number[];
} | {
  readonly command: "insertRow";
  readonly requestId: string;
  readonly anchorRowId: number | null;
  readonly position: "above" | "below" | "end";
} | {
  readonly command: "deleteColumns";
  readonly requestId: string;
  readonly columnNames: string[];
} | {
  readonly command: "insertColumn";
  readonly requestId: string;
  readonly anchorColumnName: string | null;
  readonly position: "left" | "right" | "end";
  readonly columnName?: string;
  readonly suggestedColumnName?: string;
};

class ParquetLensDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;
  readonly service: DuckDbParquetService;

  constructor(uri: vscode.Uri, service: DuckDbParquetService) {
    this.uri = uri;
    this.service = service;
  }

  dispose(): void {
    this.service.close();
  }
}

class ParquetLensEdit implements vscode.CustomDocumentEditEvent<ParquetLensDocument> {
  readonly label: string;
  readonly document: ParquetLensDocument;
  private readonly undoEdit: () => Thenable<void> | Promise<void>;
  private readonly redoEdit: () => Thenable<void> | Promise<void>;

  constructor(document: ParquetLensDocument, label: string, undoEdit: () => Promise<void>, redoEdit: () => Promise<void>) {
    this.document = document;
    this.label = label;
    this.undoEdit = undoEdit;
    this.redoEdit = redoEdit;
  }

  undo(): Thenable<void> | Promise<void> {
    return this.undoEdit();
  }

  redo(): Thenable<void> | Promise<void> {
    return this.redoEdit();
  }
}

class ParquetLensProvider implements vscode.CustomEditorProvider<ParquetLensDocument> {
  private readonly context: vscode.ExtensionContext;
  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ParquetLensDocument>>();

  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  async openCustomDocument(uri: vscode.Uri): Promise<ParquetLensDocument> {
    const service = new DuckDbParquetService(uri.fsPath);
    await service.initialize();
    return new ParquetLensDocument(uri, service);
  }

  async resolveCustomEditor(document: ParquetLensDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, "media"))
      ]
    };
    webviewPanel.webview.html = this.html(webviewPanel.webview);

    webviewPanel.webview.onDidReceiveMessage(async (message: WebviewRequest) => {
      try {
        await this.handleMessage(document, webviewPanel.webview, message);
      } catch (error) {
        const generatedSql = error instanceof QueryExecutionError ? error.sql : undefined;
        webviewPanel.webview.postMessage({
          command: "error",
          requestId: "requestId" in message ? message.requestId : undefined,
          sql: generatedSql,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  async saveCustomDocument(document: ParquetLensDocument): Promise<void> {
    await document.service.save();
  }

  async saveCustomDocumentAs(document: ParquetLensDocument, destination: vscode.Uri): Promise<void> {
    await document.service.save();
    await vscode.workspace.fs.copy(document.uri, destination, { overwrite: true });
  }

  async revertCustomDocument(document: ParquetLensDocument): Promise<void> {
    await document.service.revert();
  }

  async backupCustomDocument(document: ParquetLensDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    await document.service.save();
    return {
      id: context.destination.toString(),
      delete: () => undefined
    };
  }

  private async handleMessage(document: ParquetLensDocument, webview: vscode.Webview, message: WebviewRequest): Promise<void> {
    if (message.command === "ready") {
      await this.postInitialState(document, webview);
      return;
    }

    if (message.command === "schema") {
      const schema = await document.service.schema();
      webview.postMessage({ command: "schema", requestId: message.requestId, schema });
      return;
    }

    if (message.command === "query") {
      const sql = message.mode === "nl"
        ? await this.sqlFromNaturalLanguage(document, message.text)
        : message.text;
      try {
        const readonlySql = assertReadOnlyQuery(sql);
        const result = await this.runQueryWithSqlError(readonlySql, message.limit, document);
        webview.postMessage({
          command: "queryResult",
          requestId: message.requestId,
          sql: readonlySql,
          columns: result.columns.length > 0 ? result.columns : columnsFromSchema(await document.service.schema()),
          rows: result.rows.map((row) => serializeRowForWebview(row)),
          rowCount: result.rowCount,
          columnCount: result.columnCount,
          editable: result.editable,
          editRowIdColumn
        });
      } catch (error) {
        if (error instanceof QueryExecutionError) {
          throw error;
        }
        throw new QueryExecutionError(sql, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (message.command === "exportResult") {
      const sql = message.mode === "nl"
        ? await this.sqlFromNaturalLanguage(document, message.text)
        : message.text;
      const readonlySql = assertReadOnlyQuery(sql);
      const destination = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), `${path.basename(document.uri.fsPath, path.extname(document.uri.fsPath))}-result.parquet`)),
        filters: {
          "Parquet files": ["parquet"]
        },
        saveLabel: "Export Result"
      });
      if (!destination) {
        webview.postMessage({ command: "exportCancelled", requestId: message.requestId });
        return;
      }
      await document.service.exportQuery(readonlySql, message.limit, destination.fsPath);
      webview.postMessage({ command: "exported", requestId: message.requestId, path: destination.fsPath });
      return;
    }

    if (message.command === "editCell") {
      await document.service.editCell(message.rowId, message.columnName, message.value);
      this.changeEmitter.fire(new ParquetLensEdit(
        document,
        `Edit ${message.columnName}`,
        async () => {
          await document.service.editCell(message.rowId, message.columnName, message.previousValue);
        },
        async () => {
          await document.service.editCell(message.rowId, message.columnName, message.value);
        }
      ));
      webview.postMessage({ command: "editApplied", requestId: message.requestId });
      return;
    }

    if (message.command === "deleteRows") {
      await this.applyStructuralEdit(document, "Delete rows", () => document.service.deleteRows(message.rowIds));
      await this.postDefaultRefresh(document, webview, message.requestId);
      return;
    }

    if (message.command === "insertRow") {
      await this.applyStructuralEdit(document, "Insert row", () => document.service.insertRow(message.anchorRowId, message.position));
      await this.postDefaultRefresh(document, webview, message.requestId);
      return;
    }

    if (message.command === "deleteColumns") {
      await this.applyStructuralEdit(document, "Delete columns", () => document.service.deleteColumns(message.columnNames));
      await this.postDefaultRefresh(document, webview, message.requestId);
      return;
    }

    if (message.command === "insertColumn") {
      const columnName = message.columnName ?? await this.promptColumnName(document, message.suggestedColumnName);
      if (!columnName) {
        return;
      }
      await this.applyStructuralEdit(document, "Insert column", () => document.service.insertColumn(message.anchorColumnName, message.position, columnName));
      await this.postDefaultRefresh(document, webview, message.requestId);
      return;
    }

    if (message.command === "updateNl2sqlConfig") {
      await this.updateNl2SqlConfig(message.config);
      webview.postMessage({
        command: "nl2sqlConfigSaved",
        requestId: message.requestId,
        nl2sql: this.nl2SqlConfig()
      });
    }
  }

  private async postInitialState(document: ParquetLensDocument, webview: vscode.Webview): Promise<void> {
    const schema = await document.service.schema();
    const result = await document.service.query("SELECT * FROM data", { mode: "limited", value: 100 });
    webview.postMessage({
      command: "initialState",
      defaultSql: "SELECT * FROM data",
      schema,
      columns: result.columns.length > 0 ? result.columns : columnsFromSchema(schema),
      rows: result.rows.map((row) => serializeRowForWebview(row)),
      rowCount: result.rowCount,
      columnCount: result.columnCount,
      editable: result.editable,
      editRowIdColumn,
      nl2sql: this.nl2SqlConfig()
    });
  }

  private async postDefaultRefresh(document: ParquetLensDocument, webview: vscode.Webview, requestId: string): Promise<void> {
    const schema = await document.service.schema();
    const result = await document.service.query("SELECT * FROM data", { mode: "limited", value: 100 });
    webview.postMessage({
      command: "structuralEditApplied",
      requestId,
      sql: "SELECT * FROM data",
      schema,
      columns: result.columns.length > 0 ? result.columns : columnsFromSchema(schema),
      rows: result.rows.map((row) => serializeRowForWebview(row)),
      rowCount: result.rowCount,
      columnCount: result.columnCount,
      editable: result.editable,
      editRowIdColumn
    });
  }

  private async applyStructuralEdit(document: ParquetLensDocument, label: string, operation: () => Promise<void>): Promise<void> {
    const before = await document.service.createEditSnapshot();
    await operation();
    const after = await document.service.createEditSnapshot();
    this.changeEmitter.fire(new ParquetLensEdit(
      document,
      label,
      async () => {
        await document.service.restoreEditSnapshot(before);
      },
      async () => {
        await document.service.restoreEditSnapshot(after);
      }
    ));
  }

  private async promptColumnName(document: ParquetLensDocument, suggestedColumnName?: string): Promise<string | undefined> {
    const schema = await document.service.schema();
    const existing = new Set(schema.map((field) => field.name));
    return vscode.window.showInputBox({
      title: "Insert Column",
      prompt: "Enter a new column name.",
      value: suggestedColumnName ?? this.nextColumnName(schema.map((field) => field.name)),
      validateInput: (value) => {
        const normalized = value.trim();
        if (normalized.length === 0) {
          return "Column name is required.";
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized)) {
          return "Column name must start with a letter or underscore and contain only letters, numbers, and underscores.";
        }
        if (existing.has(normalized)) {
          return `Column already exists: ${normalized}`;
        }
        return undefined;
      }
    }).then((value) => value?.trim());
  }

  private nextColumnName(columnNames: string[]): string {
    let index = 1;
    const existing = new Set(columnNames);
    while (existing.has(`new_column_${index}`)) {
      index += 1;
    }
    return `new_column_${index}`;
  }

  private async sqlFromNaturalLanguage(document: ParquetLensDocument, nl: string): Promise<string> {
    const schema = await document.service.schema();
    const schemaText = schema.map((field) => `${field.name}: ${field.type}`).join("\n");
    return requestNl2Sql(this.nl2SqlConfig(), nl, schemaText);
  }

  private async runQueryWithSqlError(sql: string, limit: LimitSelection, document: ParquetLensDocument) {
    try {
      return await document.service.query(sql, limit);
    } catch (error) {
      throw new QueryExecutionError(sql, error instanceof Error ? error.message : String(error));
    }
  }

  private nl2SqlConfig(): Nl2SqlConfig {
    const config = vscode.workspace.getConfiguration("parquetLens.nl2sql");
    return {
      baseUrl: config.get<string>("baseUrl", "https://api.openai.com/v1"),
      apiKey: config.get<string>("apiKey", ""),
      model: config.get<string>("model", "gpt-4.1-mini"),
      promptTemplate: config.get<string>("promptTemplate", "Given this table schema:\n{{schema}}\n\nWrite a read-only DuckDB SQL query against the table named data for this request:\n{{nl}}\n\nReturn only SQL."),
      timeoutMs: config.get<number>("timeoutMs", 30000),
      headers: config.get<Record<string, string>>("headers", {})
    };
  }

  private async updateNl2SqlConfig(config: Partial<Nl2SqlConfig>): Promise<void> {
    const workspaceConfig = vscode.workspace.getConfiguration("parquetLens.nl2sql");
    const target = vscode.ConfigurationTarget.Global;
    const allowedKeys: Array<keyof Nl2SqlConfig> = ["baseUrl", "apiKey", "model", "promptTemplate", "timeoutMs", "headers"];
    for (const key of allowedKeys) {
      if (!(key in config)) {
        continue;
      }
      const value = config[key];
      if (key === "headers" && typeof value === "string") {
        await workspaceConfig.update(key, JSON.parse(value), target);
      } else {
        await workspaceConfig.update(key, value, target);
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", "app.js")));
    const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", "app.css")));
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Parquet Lens</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(
    "parquetLens.editor",
    new ParquetLensProvider(context),
    {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    }
  ));
}

export function deactivate(): void {
}

class QueryExecutionError extends Error {
  readonly sql: string;

  constructor(sql: string, message: string) {
    super(message);
    this.sql = sql;
  }
}
