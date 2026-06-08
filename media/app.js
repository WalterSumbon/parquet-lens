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
    nl2sql: {},
    editRowIdColumn: null,
    currentQueryRequestId: null,
    isRunning: false,
    rowNumberCollapsed: false,
    rowNumberBase: 1,
    cellEditorHeight: null,
    focusCellEditor: false,
    gridScrollTop: 0,
    gridScrollLeft: 0,
    selectedRows: [],
    selectedColumns: [],
    dragSelection: null,
    contextMenu: null
  };

  const app = document.getElementById("app");
  let nl2sqlSaveTimer = undefined;

  function request(command, payload) {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vscode.postMessage({ command, requestId, ...payload });
    return requestId;
  }

  function render() {
    rememberGridScroll();
    app.innerHTML = "";
    const shell = el("div", "shell");
    shell.append(toolbar(), nlConfig(), schemaPanel(), status(), editorBand(), grid(), contextMenu());
    app.append(shell);
    restoreGridScroll();
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
    query.onkeydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        runQuery();
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

    const run = el("button", state.isRunning ? "primary running" : "primary");
    run.innerHTML = state.isRunning ? icon("stop") + "Running" : icon("play") + "Run";
    run.title = state.isRunning ? "Click to stop" : "Run query";
    run.onclick = () => state.isRunning ? stopRunning() : runQuery();
    const resetButton = el("button", "secondary");
    resetButton.innerHTML = icon("reset") + "Reset";
    resetButton.title = "Reset query, limit, selection, and view state";
    resetButton.onclick = () => resetView();
    const exportButton = el("button", "secondary");
    exportButton.innerHTML = icon("export") + "Export";
    exportButton.title = "Save the current query result as a Parquet file.";
    exportButton.onclick = () => exportResult();

    bar.append(mode, query, limit, run, resetButton, exportButton);
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
    if (state.cellEditorHeight !== null) {
      editor.style.height = `${state.cellEditorHeight}px`;
    }
    editor.oninput = () => {
      state.cellEditorHeight = editor.getBoundingClientRect().height;
    };
    editor.onmouseup = () => {
      state.cellEditorHeight = editor.getBoundingClientRect().height;
    };
    if (state.selected) {
      editor.value = stringifyValue(state.selected.rawValue);
      editor.disabled = !state.editable;
      editor.onchange = () => applyCellEdit(editor.value);
    } else {
      editor.disabled = true;
    }
    wrap.append(editor);
    if (state.focusCellEditor) {
      window.setTimeout(() => {
        editor.focus();
        editor.select();
        state.focusCellEditor = false;
      }, 0);
    }
    return wrap;
  }

  function grid() {
    const wrap = el("div", "grid-wrap");
    wrap.onscroll = () => {
      state.gridScrollTop = wrap.scrollTop;
      state.gridScrollLeft = wrap.scrollLeft;
    };
    wrap.oncontextmenu = (event) => {
      if (state.rows.length === 0 || state.columns.length === 0) {
        event.preventDefault();
        openContextMenu(event.clientX, event.clientY, "blank", {});
      }
    };
    const table = el("table", "data-table");
    const header = el("tr");
    header.append(rowNumberHeader());
    for (const column of state.columns) {
      header.append(columnHeader(column.name));
    }
    table.append(header);
    state.rows.forEach((dataRow, rowIndex) => {
      const tr = el("tr");
      tr.append(rowNumberCell(rowIndex, dataRow));
      for (const column of state.columns) {
        const cell = dataRow[column.name] || { display: "" };
        const td = el("td", state.editable ? "editable" : "");
        if (isRowSelected(rowIndex) || isColumnSelected(column.name)) {
          td.classList.add("range-selected");
        }
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
          selectCell(rowIndex, column.name, dataRow, cell, false);
        };
        td.ondblclick = () => {
          selectCell(rowIndex, column.name, dataRow, cell, true);
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

  function columnHeader(columnName) {
    const th = el("th", isColumnSelected(columnName) ? "column-selected" : "", columnName);
    th.onmousedown = (event) => {
      if (event.button !== 0) {
        return;
      }
      state.dragSelection = { type: "column", start: columnName };
      state.selected = null;
      state.selectedRows = [];
      state.selectedColumns = [columnName];
      render();
    };
    th.onmousemove = () => {
      if (state.dragSelection?.type === "column") {
        selectColumnRange(state.dragSelection.start, columnName);
      }
    };
    th.oncontextmenu = (event) => {
      event.preventDefault();
      if (!isColumnSelected(columnName)) {
        state.selected = null;
        state.selectedRows = [];
        state.selectedColumns = [columnName];
      }
      openContextMenu(event.clientX, event.clientY, "column", { columnName });
    };
    return th;
  }

  function selectCell(rowIndex, columnName, dataRow, cell, focusEditor) {
    state.selected = {
      rowIndex,
      columnName,
      rowId: state.editRowIdColumn ? dataRow[state.editRowIdColumn] : undefined,
      rawValue: cell.value,
      display: cell.display
    };
    state.selectedRows = [];
    state.selectedColumns = [];
    state.focusCellEditor = Boolean(focusEditor);
    render();
  }

  function rowNumberHeader() {
    const th = el("th", state.rowNumberCollapsed ? "row-number row-number-collapsed" : "row-number");
    th.title = state.rowNumberCollapsed
      ? "Click to expand row numbers. Right-click to switch 0-based or 1-based numbering."
      : "Click to collapse row numbers. Right-click to switch 0-based or 1-based numbering.";
    th.textContent = state.rowNumberCollapsed ? "" : "#";
    th.onclick = () => {
      state.rowNumberCollapsed = !state.rowNumberCollapsed;
      render();
    };
    th.oncontextmenu = (event) => {
      event.preventDefault();
      state.rowNumberBase = state.rowNumberBase === 0 ? 1 : 0;
      render();
    };
    return th;
  }

  function rowNumberCell(rowIndex, dataRow) {
    const td = el("td", state.rowNumberCollapsed ? "row-number row-number-collapsed" : "row-number");
    if (isRowSelected(rowIndex)) {
      td.classList.add("row-selected");
    }
    td.title = state.rowNumberCollapsed ? "Click the header to expand row numbers" : `Displayed row ${rowIndex + state.rowNumberBase}`;
    td.textContent = state.rowNumberCollapsed ? "" : String(rowIndex + state.rowNumberBase);
    td.onmousedown = (event) => {
      if (event.button !== 0) {
        return;
      }
      state.dragSelection = { type: "row", start: rowIndex };
      state.selected = null;
      state.selectedColumns = [];
      state.selectedRows = [rowIndex];
      render();
    };
    td.onmousemove = () => {
      if (state.dragSelection?.type === "row") {
        selectRowRange(state.dragSelection.start, rowIndex);
      }
    };
    td.oncontextmenu = (event) => {
      event.preventDefault();
      if (!isRowSelected(rowIndex)) {
        state.selected = null;
        state.selectedColumns = [];
        state.selectedRows = [rowIndex];
      }
      openContextMenu(event.clientX, event.clientY, "row", {
        rowIndex,
        rowId: state.editRowIdColumn ? dataRow[state.editRowIdColumn] : null
      });
    };
    return td;
  }

  function runQuery() {
    if (state.isRunning) {
      return;
    }
    const requestId = request("query", {
      mode: state.mode,
      text: state.mode === "nl" ? state.nlText : state.sqlText,
      limit: {
        mode: state.limitMode,
        value: state.limitValue
      }
    });
    state.currentQueryRequestId = requestId;
    state.isRunning = true;
    render();
  }

  function stopRunning() {
    state.currentQueryRequestId = null;
    state.isRunning = false;
    render();
  }

  function resetView() {
    state.currentQueryRequestId = null;
    state.isRunning = false;
    state.mode = "sql";
    state.sqlText = "SELECT * FROM data";
    state.nlText = "";
    state.limitMode = "limited";
    state.limitValue = 100;
    state.selected = null;
    state.rowNumberCollapsed = false;
    state.rowNumberBase = 1;
    state.focusCellEditor = false;
    render();
    runQuery();
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

  function contextMenu() {
    if (!state.contextMenu) {
      return el("div", "context-menu hidden");
    }
    const menu = el("div", "context-menu");
    menu.style.left = `${state.contextMenu.x}px`;
    menu.style.top = `${state.contextMenu.y}px`;
    for (const item of contextMenuItems()) {
      const button = el("button", "", item.label);
      button.onclick = () => {
        const action = item.action;
        closeContextMenu();
        action();
      };
      menu.append(button);
    }
    return menu;
  }

  function contextMenuItems() {
    const menu = state.contextMenu;
    if (menu.kind === "row") {
      return [
        { label: "Insert row above", action: () => insertRow(menu.rowId, "above") },
        { label: "Insert row below", action: () => insertRow(menu.rowId, "below") },
        { label: `Delete ${state.selectedRows.length || 1} row(s)`, action: () => deleteSelectedRows() }
      ];
    }
    if (menu.kind === "column") {
      return [
        { label: "Insert column left", action: () => insertColumn(menu.columnName, "left") },
        { label: "Insert column right", action: () => insertColumn(menu.columnName, "right") },
        { label: `Delete ${state.selectedColumns.length || 1} column(s)`, action: () => deleteSelectedColumns() }
      ];
    }
    return [
      { label: "Add row", action: () => insertRow(null, "end") },
      { label: "Add column", action: () => insertColumn(null, "end") }
    ];
  }

  function openContextMenu(x, y, kind, payload) {
    state.contextMenu = { x, y, kind, ...payload };
    render();
  }

  function closeContextMenu() {
    state.contextMenu = null;
    render();
  }

  function insertRow(anchorRowId, position) {
    request("insertRow", { anchorRowId: anchorRowId === undefined ? null : anchorRowId, position });
  }

  function deleteSelectedRows() {
    const rowIds = state.selectedRows
      .map((rowIndex) => state.rows[rowIndex])
      .map((row) => state.editRowIdColumn ? row?.[state.editRowIdColumn] : undefined)
      .filter((rowId) => rowId !== undefined)
      .map(Number);
    request("deleteRows", { rowIds });
  }

  function insertColumn(anchorColumnName, position) {
    request("insertColumn", {
      anchorColumnName: anchorColumnName ?? null,
      position,
      suggestedColumnName: nextColumnName()
    });
  }

  function deleteSelectedColumns() {
    request("deleteColumns", { columnNames: state.selectedColumns });
  }

  function nextColumnName() {
    let index = 1;
    const existing = new Set(state.columns.map((column) => column.name));
    while (existing.has(`new_column_${index}`)) {
      index += 1;
    }
    return `new_column_${index}`;
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
      if (message.command === "queryResult" && message.requestId !== state.currentQueryRequestId) {
        return;
      }
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
      state.editRowIdColumn = message.editRowIdColumn || state.editRowIdColumn;
      state.currentQueryRequestId = null;
      state.isRunning = false;
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

    if (message.command === "structuralEditApplied") {
      state.sqlText = message.sql || "SELECT * FROM data";
      state.schema = message.schema || state.schema;
      state.columns = message.columns || [];
      state.rows = message.rows || [];
      state.rowCount = message.rowCount || 0;
      state.columnCount = message.columnCount || 0;
      state.editable = Boolean(message.editable);
      state.selected = null;
      state.selectedRows = [];
      state.selectedColumns = [];
      state.editRowIdColumn = message.editRowIdColumn || state.editRowIdColumn;
      render();
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
      if (message.requestId === state.currentQueryRequestId) {
        if (message.sql) {
          state.mode = "sql";
          state.sqlText = message.sql;
        }
        state.currentQueryRequestId = null;
        state.isRunning = false;
        render();
      }
      showError(message.message || "Unknown error");
    }
  });

  window.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || !state.selected) {
      return;
    }
    const active = document.activeElement;
    const activeTag = active?.tagName?.toLowerCase();
    if (activeTag === "textarea" || activeTag === "input") {
      return;
    }

    if (event.key.toLowerCase() === "c") {
      event.preventDefault();
      copySelectedCell();
    }

    if (event.key.toLowerCase() === "v") {
      event.preventDefault();
      pasteIntoSelectedCell();
    }
  });

  window.addEventListener("mouseup", () => {
    state.dragSelection = null;
  });

  window.addEventListener("click", (event) => {
    if (state.contextMenu && !event.target.closest(".context-menu")) {
      state.contextMenu = null;
      render();
    }
  });

  function selectRowRange(start, end) {
    const [from, to] = start < end ? [start, end] : [end, start];
    state.selectedRows = [];
    for (let index = from; index <= to; index += 1) {
      state.selectedRows.push(index);
    }
    state.selectedColumns = [];
    state.selected = null;
    render();
  }

  function selectColumnRange(startColumn, endColumn) {
    const names = state.columns.map((column) => column.name);
    const start = names.indexOf(startColumn);
    const end = names.indexOf(endColumn);
    if (start < 0 || end < 0) {
      return;
    }
    const [from, to] = start < end ? [start, end] : [end, start];
    state.selectedColumns = names.slice(from, to + 1);
    state.selectedRows = [];
    state.selected = null;
    render();
  }

  function isRowSelected(rowIndex) {
    return state.selectedRows.includes(rowIndex);
  }

  function isColumnSelected(columnName) {
    return state.selectedColumns.includes(columnName);
  }

  function rememberGridScroll() {
    const grid = document.querySelector(".grid-wrap");
    if (!grid) {
      return;
    }
    state.gridScrollTop = grid.scrollTop;
    state.gridScrollLeft = grid.scrollLeft;
  }

  function restoreGridScroll() {
    const grid = document.querySelector(".grid-wrap");
    if (!grid) {
      return;
    }
    grid.scrollTop = state.gridScrollTop;
    grid.scrollLeft = state.gridScrollLeft;
    window.requestAnimationFrame(() => {
      grid.scrollTop = state.gridScrollTop;
      grid.scrollLeft = state.gridScrollLeft;
    });
  }

  async function copySelectedCell() {
    try {
      const value = stringifyValue(state.selected.rawValue);
      await navigator.clipboard.writeText(value);
      showNotice("Copied cell");
    } catch (error) {
      showError(`Copy failed: ${error.message || error}`);
    }
  }

  async function pasteIntoSelectedCell() {
    if (!state.editable) {
      showError("The current result is read-only.");
      return;
    }
    try {
      const value = await navigator.clipboard.readText();
      applyCellEdit(value);
      state.selected.rawValue = value;
      state.focusCellEditor = false;
      render();
    } catch (error) {
      showError(`Paste failed: ${error.message || error}`);
    }
  }

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

  function icon(name) {
    if (name === "play") {
      return '<span class="button-icon" aria-hidden="true">▶</span>';
    }
    if (name === "stop") {
      return '<span class="button-icon" aria-hidden="true">■</span>';
    }
    if (name === "reset") {
      return '<span class="button-icon" aria-hidden="true">↺</span>';
    }
    return '<span class="button-icon" aria-hidden="true">↗</span>';
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
