// =============================================================================
// Dual-mode output: human-friendly (default) vs JSON (--json flag / ACP_JSON=1)
// With ANSI color support for TTY terminals.
// =============================================================================

let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

// -- ANSI colors (only when stdout is a TTY and not in JSON mode) --

const isTTY = process.stdout.isTTY === true;

const c = {
  bold: (s: string) => (isTTY && !jsonMode ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (isTTY && !jsonMode ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (isTTY && !jsonMode ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (isTTY && !jsonMode ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTTY && !jsonMode ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTTY && !jsonMode ? `\x1b[36m${s}\x1b[0m` : s),
};

export { c as colors };

// -- Output functions --

/** Print JSON to stdout (for --json mode or agent consumption). */
export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, jsonMode ? undefined : 2));
}

/** Print a line to stdout (human mode). Suppressed in JSON mode. */
export function log(msg: string): void {
  if (!jsonMode) console.log(msg);
}

/** Print an error line to stderr. Always shown. */
export function error(msg: string): void {
  if (jsonMode) {
    console.error(JSON.stringify({ error: msg }));
  } else {
    console.error(c.red(`Error: ${msg}`));
  }
}

/** Print a success line (human mode). Suppressed in JSON mode. */
export function success(msg: string): void {
  if (!jsonMode) console.log(c.green(`  ${msg}`));
}

/** Print a warning line (human mode). Suppressed in JSON mode. */
export function warn(msg: string): void {
  if (!jsonMode) console.log(c.yellow(`  Warning: ${msg}`));
}

/** Print a section heading. */
export function heading(title: string): void {
  if (!jsonMode) {
    console.log(`\n${c.bold(title)}`);
    console.log(c.dim("-".repeat(50)));
  }
}

/** Print a key-value pair. */
export function field(label: string, value: string | number | boolean | null | undefined): void {
  if (!jsonMode) {
    console.log(`  ${c.dim(label.padEnd(18))} ${value ?? "-"}`);
  }
}

/**
 * Output data in the appropriate mode.
 * In JSON mode: prints JSON to stdout.
 * In human mode: calls the formatter function.
 */
export function output(data: unknown, humanFormatter: (data: any) => void): void {
  if (jsonMode) {
    json(data);
  } else {
    humanFormatter(data);
  }
}

/** Fatal error — print and exit. */
export function fatal(msg: string): never {
  error(msg);
  process.exit(1);
}

export function formatSymbol(symbol: string): string {
  return symbol[0].startsWith("$") ? symbol : `$${symbol}`;
}
