export interface Nl2SqlConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly promptTemplate: string;
  readonly timeoutMs: number;
  readonly headers: Record<string, string>;
}

export function validatePromptTemplate(template: string): void {
  if (!template.includes("{{nl}}")) {
    throw new Error("Prompt template must include {{nl}}.");
  }
}

export function renderPrompt(template: string, nl: string, schema: string): string {
  validatePromptTemplate(template);
  return template.replaceAll("{{nl}}", nl).replaceAll("{{schema}}", schema);
}

export function extractSqlFromCompletion(content: string): string {
  const fenced = content.match(/```(?:sql)?\s*([\s\S]*?)```/iu);
  const candidate = fenced?.[1] ?? content;
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    throw new Error("NL2SQL response did not contain SQL.");
  }
  return trimmed;
}

export async function requestNl2Sql(config: Nl2SqlConfig, nl: string, schema: string): Promise<string> {
  validatePromptTemplate(config.promptTemplate);
  if (config.apiKey.trim().length === 0) {
    throw new Error("NL2SQL API key is not configured.");
  }
  if (config.model.trim().length === 0) {
    throw new Error("NL2SQL model is not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const baseUrl = config.baseUrl.replace(/\/+$/u, "");
  const prompt = renderPrompt(config.promptTemplate, nl, schema);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...config.headers
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`NL2SQL request failed with HTTP ${response.status}.`);
    }

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("NL2SQL response is missing message content.");
    }

    return extractSqlFromCompletion(content);
  } finally {
    clearTimeout(timeout);
  }
}
