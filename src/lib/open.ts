// =============================================================================
// Open a URL in the user's default browser. Uses execFile to avoid shell injection.
// =============================================================================

import { execFile } from "child_process";

export function openUrl(url: string): void {
  const platform = process.platform;
  const cb = (err: Error | null) => {
    if (err) {
      // Silently fail — the URL is always printed as fallback
    }
  };

  if (platform === "darwin") {
    execFile("open", [url], {}, cb);
  } else if (platform === "win32") {
    execFile("cmd", ["/c", "start", "", url], {}, cb);
  } else {
    execFile("xdg-open", [url], {}, cb);
  }
}
