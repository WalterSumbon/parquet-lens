const assert = require("node:assert");
const test = require("node:test");
const {
  extractSqlFromCompletion,
  renderPrompt,
  validatePromptTemplate
} = require("../out/nl2sql");

test("validates prompt template contains nl placeholder", () => {
  assert.throws(() => validatePromptTemplate("schema only {{schema}}"), /{{nl}}/);
});

test("renders prompt with nl and schema placeholders", () => {
  const prompt = renderPrompt("Schema:\n{{schema}}\nRequest:\n{{nl}}", "top rows", "a: INTEGER");
  assert.equal(prompt, "Schema:\na: INTEGER\nRequest:\ntop rows");
});

test("extracts SQL from fenced completion", () => {
  assert.equal(
    extractSqlFromCompletion("```sql\nSELECT * FROM data LIMIT 10\n```"),
    "SELECT * FROM data LIMIT 10"
  );
});

test("extracts bare SQL and rejects empty responses", () => {
  assert.equal(extractSqlFromCompletion(" SELECT count(*) FROM data "), "SELECT count(*) FROM data");
  assert.throws(() => extractSqlFromCompletion("   "), /did not contain SQL/);
});
