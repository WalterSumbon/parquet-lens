export interface DisplayCell {
  readonly value: unknown;
  readonly display: string;
  readonly fullLength?: number;
  readonly truncated: boolean;
  readonly error?: string;
}

const defaultMaxLength = 160;

export function formatCell(value: unknown, maxLength = defaultMaxLength): DisplayCell {
  if (value === null || value === undefined) {
    return { value, display: "", truncated: false };
  }

  if (Buffer.isBuffer(value)) {
    const decoded = decodeLikelyText(value);
    if (decoded === undefined) {
      return {
        value,
        display: "[binary data]",
        truncated: false,
        error: "Binary value could not be decoded as text."
      };
    }
    return truncateDisplay(value, decoded, maxLength);
  }

  if (value instanceof Uint8Array) {
    const decoded = decodeLikelyText(Buffer.from(value));
    if (decoded === undefined) {
      return {
        value,
        display: "[binary data]",
        truncated: false,
        error: "Binary value could not be decoded as text."
      };
    }
    return truncateDisplay(value, decoded, maxLength);
  }

  const text = typeof value === "string" ? value : String(value);
  return truncateDisplay(value, text, maxLength);
}

function truncateDisplay(value: unknown, text: string, maxLength: number): DisplayCell {
  if (text.length <= maxLength) {
    return { value, display: text, fullLength: text.length, truncated: false };
  }

  const suffix = `... (${text.length} chars)`;
  const visibleLength = Math.max(0, maxLength - suffix.length);
  return {
    value,
    display: `${text.slice(0, visibleLength)}${suffix}`,
    fullLength: text.length,
    truncated: true
  };
}

function decodeLikelyText(value: Buffer): string | undefined {
  if (value.length === 0) {
    return "";
  }

  const decoded = value.toString("utf8");
  const replacementCount = (decoded.match(/\uFFFD/gu) ?? []).length;
  if (replacementCount > 0) {
    return undefined;
  }

  const controlChars = decoded.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu) ?? [];
  if (controlChars.length / decoded.length > 0.05) {
    return undefined;
  }

  return decoded;
}
