// =============================================================================
// Open a URL in the user's default browser. Platform-specific, no dependencies.
// SECURITY: avoid shell string execution (command injection) by using spawn/execFile
// with argument arrays (no shell interpolation).
// =============================================================================

import { spawn } from "child_process";

export function openUrl(url: string): void {
  const platform = process.platform;

  // Prefer direct executables (no shell) to avoid command injection.
  // - macOS: `open <url>`
  // - Windows: `explorer.exe <url>` (works for http/https and file paths)
  // - Linux: `xdg-open <url>`
  const command =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "explorer.exe"
        : "xdg-open";

  try {
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
    });

    child.on("error", () => {
      // Silently fail — the URL is always printed as fallback elsewhere.
    });

    // Allow parent process to exit independently.
    child.unref();
  } catch {
    // Best-effort only.
  }
}
