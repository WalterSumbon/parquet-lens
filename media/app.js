(function () {
  const vscode = acquireVsCodeApi();
  const state = {
    mode: "sql",
    sqlText: "SELECT * FROM data",
    nlText: "",
    limitMode: "limited",
    limitValue: 100,
    schema: [],
    columns: [],
    rows: [],
    rowCount: 0,
    columnCount: 0,
    editable: false,
    selected: null,
    pending: new Map(),
    nl2sql: {}
  };

  const app = document.getElementById("app");
  let nl2sqlSaveTimer = undefined;

  function request(command, payload) {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vscode.postMessage({ command, requestId, ...payload });
    return requestId;
  }

  function render() {
    app.innerHTML = "";
    const shell = el("div", "shell");
    shell.append(toolbar(), nlConfig(), schemaPanel(), status(), editorBand(), grid());
    app.append(shell);
  }

  function toolbar() {
    const bar = el("div", "toolbar");
    const mode = el("div", "mode");
    const sqlButton = el("button", state.mode === "sql" ? "active" : "", "SQL");
    const nlButton = el("button", state.mode === "nl" ? "active" : "", "NL");
    sqlButton.onclick = () => {
      state.mode = "sql";
      render();
    };
    nlButton.onclick = () => {
      state.mode = "nl";
      render();
    };
    mode.append(sqlButton, nlButton);

    const query = el("textarea", "query");
    query.rows = 1;
    query.value = state.mode === "nl" ? state.nlText : state.sqlText;
    query.placeholder = state.mode === "nl" ? "Describe the query you want" : "SELECT * FROM data";
    query.oninput = () => {
      if (state.mode === "nl") {
        state.nlText = query.value;
      } else {
        state.sqlText = query.value;
      }
    };

    const limit = el("label", "limit");
    const enableLimit = el("input", "limit-toggle");
    enableLimit.type = "checkbox";
    enableLimit.title = "Enable row limit. Clear this checkbox to return all rows.";
    enableLimit.checked = state.limitMode === "limited";
    enableLimit.onchange = () => {
      state.limitMode = enableLimit.checked ? "limited" : "none";
      render();
    };
    const limitInput = el("input");
    limitInput.type = "number";
    limitInput.min = "0";
    limitInput.value = String(state.limitValue);
    limitInput.disabled = state.limitMode !== "limited";
    limitInput.oninput = () => {
      state.limitValue = Number.parseInt(limitInput.value || "0", 10);
    };
    limit.append(enableLimit, text("Limit"), limitInput);

    const run = el("button", "primary", "Run");
    run.onclick = () => runQuery();
    const exportButton = el("button", "secondary", "Export");
    exportButton.title = "Save the current query result as a Parquet file.";
    exportButton.onclick = () => exportResult();

    bar.append(mode, query, limit, run, exportButton);
    return bar;
  }

  function nlConfig() {
    const details = el("details", "nl-config");
    const summary = el("summary", "", "NL2SQL configuration");
    const form = el("div", "nl-form");
    form.append(
      labeledInput("Base URL", "baseUrl", state.nl2sql.baseUrl || ""),
      labeledInput("API Key", "apiKey", state.nl2sql.apiKey || "", "password"),
      labeledInput("Model", "model", state.nl2sql.model || ""),
      labeledInput("Timeout", "timeoutMs", String(state.nl2sql.timeoutMs || 30000), "number"),
      labeledTextArea("Prompt template", "promptTemplate", state.nl2sql.promptTemplate || ""),
      labeledTextArea("Headers JSON", "headers", JSON.stringify(state.nl2sql.headers || {}, null, 2))
    );
    details.append(summary, form);
    return details;
  }

  function labeledInput(label, key, value, type) {
    const wrap = el("label", "field");
    const caption = el("span", "", label);
    const input = el("input");
    input.type = type || "text";
    input.value = value;
    input.oninput = () => updateNlConfig(key, input.value);
    wrap.append(caption, input);
    return wrap;
  }

  function labeledTextArea(label, key, value) {
    const wrap = el("label", "field field-wide");
    const caption = el("span", "", label);
    const input = el("textarea");
    input.rows = key === "promptTemplate" ? 5 : 3;
    input.value = value;
    input.oninput = () => updateNlConfig(key, input.value);
    wrap.append(caption, input);
    return wrap;
  }

  function updateNlConfig(key, value) {
    if (key === "timeoutMs") {
      state.nl2sql[key] = Number.parseInt(value || "0", 10);
    } else if (key === "headers") {
      state.nl2sql[key] = parseHeaders(value);
      state.nl2sql.headersText = value;
    } else {
      state.nl2sql[key] = value;
    }

    window.clearTimeout(nl2sqlSaveTimer);
    nl2sqlSaveTimer = window.setTimeout(() => {
      const config = { ...state.nl2sql };
      delete config.headersText;
      request("updateNl2sqlConfig", { config });
    }, 400);
  }

  function parseHeaders(value) {
    try {
      return JSON.parse(value || "{}");
    } catch {
      return state.nl2sql.headers || {};
    }
  }

  function schemaPanel() {
    const details = el("details", "schema");
    const summary = el("summary", "", "Schema");
    const table = el("table", "schema-table");
    table.append(row(["Name", "Type", "Nullable"], "th"));
    for (const field of state.schema) {
      table.append(row([field.name, field.type, field.nullable || ""], "td"));
    }
    details.append(summary, table);
    return details;
  }

  function status() {
    const bar = el("div", "status");
    bar.append(
      el("span", "", `Rows: ${state.rowCount}`),
      el("span", "", `Columns: ${state.columnCount}`),
      el("span", state.editable ? "edit-badge editable-badge" : "edit-badge readonly-badge", state.editable ? "Editable result" : "Read-only result")
    );
    return bar;
  }

  function editorBand() {
    const wrap = el("div", "editor-band");
    const editor = el("textarea", "cell-editor");
    editor.rows = 1;
    editor.placeholder = "Select a cell to preview or edit its full value";
    if (state.selected) {
      editor.value = stringifyValue(state.selected.rawValue);
      editor.disabled = !state.editable;
      editor.onchange = () => applyCellEdit(editor.value);
    } else {
      editor.disabled = true;
    }
    wrap.append(editor);
    return wrap;
  }

  function grid() {
    const wrap = el("div", "grid-wrap");
    const table = el("table", "data-table");
    table.append(row(state.columns.map((column) => column.name), "th"));
    state.rows.forEach((dataRow, rowIndex) => {
      const tr = el("tr");
      for (const column of state.columns) {
        const cell = dataRow[column.name] || { display: "" };
        const td = el("td", state.editable ? "editable" : "");
        if (isSpecialCell(cell)) {
          td.classList.add("cell-special");
        }
        appendCellContent(td, cell);
        if (cell.error) {
          td.title = cell.error;
          td.classList.add("error");
        } else if (cell.fullLength !== undefined) {
          td.title = `${cell.fullLength} chars`;
        }
        td.onclick = () => {
          state.selected = {
            rowIndex,
            columnName: column.name,
            rowId: dataRow.__parquet_lens_row_id,
            rawValue: cell.value,
            display: cell.display
          };
          render();
        };
        if (state.selected && state.selected.rowIndex === rowIndex && state.selected.columnName === column.name) {
          td.classList.add("selected");
        }
        tr.append(td);
      }
      table.append(tr);
    });
    wrap.append(table);
    return wrap;
  }

  function runQuery() {
    request("query", {
      mode: state.mode,
      text: state.mode === "nl" ? state.nlText : state.sqlText,
      limit: {
        mode: state.limitMode,
        value: state.limitValue
      }
    });
  }

  function exportResult() {
    request("exportResult", {
      mode: state.mode,
      text: state.mode === "nl" ? state.nlText : state.sqlText,
      limit: {
        mode: state.limitMode,
        value: state.limitValue
      }
    });
  }

  function applyCellEdit(value) {
    if (!state.selected || !state.editable || state.selected.rowId === undefined) {
      return;
    }
    request("editCell", {
      rowId: Number(state.selected.rowId),
      columnName: state.selected.columnName,
      previousValue: state.selected.rawValue,
      value
    });
    state.selected.rawValue = value;
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.command === "initialState" || message.command === "queryResult") {
      if (message.sql) {
        state.sqlText = message.sql;
      } else if (message.defaultSql) {
        state.sqlText = message.defaultSql;
      }
      state.schema = message.schema || state.schema;
      state.columns = message.columns || [];
      state.rows = message.rows || [];
      state.rowCount = message.rowCount || 0;
      state.columnCount = message.columnCount || 0;
      state.editable = Boolean(message.editable);
      state.selected = null;
      state.nl2sql = message.nl2sql || state.nl2sql;
      render();
      return;
    }

    if (message.command === "schema") {
      state.schema = message.schema || [];
      render();
      return;
    }

    if (message.command === "editApplied") {
      runQuery();
      return;
    }

    if (message.command === "nl2sqlConfigSaved") {
      state.nl2sql = message.nl2sql || state.nl2sql;
      return;
    }

    if (message.command === "exported") {
      showNotice(`Exported to ${message.path}`);
      return;
    }

    if (message.command === "error") {
      showError(message.message || "Unknown error");
    }
  });

  function showError(message) {
    const bar = document.querySelector(".status");
    if (bar) {
      const error = el("span", "error", message);
      bar.append(error);
    } else {
      app.append(el("div", "error", message));
    }
  }

  function showNotice(message) {
    const bar = document.querySelector(".status");
    if (bar) {
      const notice = el("span", "notice", message);
      bar.append(notice);
    }
  }

  function row(values, tag) {
    const tr = el("tr");
    for (const value of values) {
      tr.append(el(tag, "", String(value)));
    }
    return tr;
  }

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (content !== undefined) {
      node.textContent = content;
    }
    return node;
  }

  function appendCellContent(td, cell) {
    if (!cell) {
      return;
    }
    if (isSpecialCell(cell)) {
      td.textContent = cell.display || "";
      return;
    }
    if (!cell.truncated || cell.fullLength === undefined) {
      td.textContent = cell.display || "";
      return;
    }

    const suffix = `... (${cell.fullLength} chars)`;
    const display = cell.display || "";
    const suffixIndex = display.endsWith(suffix) ? display.length - suffix.length : -1;
    if (suffixIndex < 0) {
      td.textContent = display;
      return;
    }
    td.append(text(display.slice(0, suffixIndex)));
    td.append(el("span", "cell-suffix", suffix));
  }

  function isSpecialCell(cell) {
    return cell && (cell.kind === "null" || cell.kind === "empty-string" || cell.kind === "blank-string");
  }

  function text(content) {
    return document.createTextNode(content);
  }

  function stringifyValue(value) {
    if (value === null || value === undefined) {
      return "";
    }
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value);
  }

  request("ready", {});
})();
