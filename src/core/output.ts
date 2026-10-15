import type { CtError } from "./errors.js";

export interface Result<T = Record<string, unknown>> {
  ok: boolean;
  message: string;
  data: T;
}

const secrets = new Set<string>();
const REDACTED = "[REDACTED]";

/** Keep every nonempty literal secret, without trimming meaningful whitespace. */
export function registerSecret(value: string | undefined): string | undefined {
  if (value) secrets.add(value);
  return value || undefined;
}

/** Release secret values when a command has finished. */
export function clearSecrets(): void {
  secrets.clear();
}

export function mask(text: string): string {
  const patterns = [
    // Also hide truncated blocks: a failed subprocess may output only part of a key.
    "-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\\s\\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)",
    "tskey-[A-Za-z0-9_-]+",
    // Go's proxy diagnostics can include URL userinfo, including encoded passwords.
    "(?<=://)[^\\s/]+(?=@)",
    ...[...secrets]
      .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  ];
  const matches: { start: number; end: number }[] = [];
  // Find every match in the original text, including overlapping literal occurrences.
  for (const pattern of new Set(patterns)) {
    const regex = new RegExp(pattern, "g");
    let match = regex.exec(text);
    while (match) {
      matches.push({ start: match.index, end: match.index + match[0].length });
      regex.lastIndex = match.index + 1;
      match = regex.exec(text);
    }
  }
  const merged: typeof matches = [];
  for (const match of matches.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && match.start < previous.end) {
      previous.end = Math.max(previous.end, match.end);
    } else {
      merged.push(match);
    }
  }
  let masked = "";
  let end = 0;
  for (const match of merged) {
    masked += text.slice(end, match.start) + REDACTED;
    end = match.end;
  }
  return masked + text.slice(end);
}

function maskedData(value: unknown): unknown {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map(maskedData);
  if (value !== null && typeof value === "object") {
    // Keep keys unmasked: our code fixes them; they are never derived from secrets.
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskedData(item)]));
  }
  return value;
}

export function render(result: Result<unknown>, json = false): string {
  const value = json
    ? JSON.stringify({
        ok: result.ok,
        message: mask(result.message),
        data: maskedData(result.data),
      })
    : mask(result.message);
  return `${value}\n`;
}

export function printResult(result: Result<unknown>, json = false): void {
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(render(result, json));
}

export function renderError(error: CtError, json = false): string {
  if (json) {
    return render(
      { ok: false, message: error.message, data: { code: error.code, next: error.next } },
      true,
    );
  }
  return `${mask(`${error.code}: ${error.message}\nNext: ${error.next}`)}\n`;
}

export function printError(error: CtError, json = false): void {
  process.stderr.write(renderError(error, json));
}
