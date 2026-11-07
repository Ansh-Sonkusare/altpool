// MCP tool results. Handlers never throw: bad input and upstream failures come back as { isError: true } with a Fix: line.
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** bigint does not survive JSON.stringify; bigints become decimal strings. */
export const toJson = (v: unknown): string => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

export const ok = (...parts: string[]): ToolResult => ({ content: parts.map((text) => ({ type: "text", text })) });
export const fail = (message: string, fix: string): ToolResult => ({ isError: true, content: [{ type: "text", text: `${message}\nFix: ${fix}` }] });
export const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
