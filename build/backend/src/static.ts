import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * CSP for every UI response. frame-ancestors lets only the AVADO admin (my.ava.do)
 * embed the UI, which protects the confirm buttons from clickjacking; X-Frame-Options
 * is deliberately not sent (it cannot express this list, and CSP takes precedence).
 */
export const UI_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "script-src 'self'",
  "frame-ancestors 'self' http://my.ava.do http://*.my.ava.do",
].join("; ");

function plain(res: ServerResponse, code: number, text: string): void {
  res.writeHead(code, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": UI_CSP,
  });
  res.end(text);
}

function isInside(root: string, file: string): boolean {
  return file === root || file.startsWith(root + path.sep);
}

/**
 * Resolves a URL path to a file under uiDir. Returns null for anything outside it,
 * dotfiles, or undecodable paths.
 */
export function resolveStaticPath(uiDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const normalized = path.posix.normalize("/" + decoded);
  if (normalized.split("/").some((seg) => seg.startsWith("."))) return null;
  const root = path.resolve(uiDir);
  const file = path.resolve(root, "." + normalized);
  return isInside(root, file) ? file : null;
}

async function serveFile(req: IncomingMessage, res: ServerResponse, file: string, cache: string): Promise<boolean> {
  let st;
  try {
    st = await stat(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": UI_CSP,
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  await new Promise<void>((resolve) => {
    const stream = createReadStream(file);
    stream.on("error", () => {
      res.destroy();
      resolve();
    });
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
  return true;
}

const INDEX_CACHE = "no-cache";
const ASSET_CACHE = "public, max-age=31536000, immutable";
const OTHER_CACHE = "public, max-age=3600";

/**
 * Serves the SPA: real files from uiDir, index.html for extension-less paths
 * (client-side routes), 404 for missing files with an extension.
 */
export async function handleStatic(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  uiDir: string,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return plain(res, 405, "Method not allowed");
  }
  const file = resolveStaticPath(uiDir, urlPath);
  if (!file) return plain(res, 404, "Not found");

  let root: string;
  try {
    root = await realpath(path.resolve(uiDir));
  } catch {
    return plain(res, 503, "The user interface is not installed");
  }
  const index = path.join(root, "index.html");

  let real: string | null = null;
  try {
    real = await realpath(file);
  } catch {
    real = null;
  }
  if (real && isInside(root, real)) {
    const target = (await stat(real)).isDirectory() ? path.join(real, "index.html") : real;
    const isIndex = path.basename(target) === "index.html";
    const isAsset = urlPath.startsWith("/assets/");
    const cache = isIndex ? INDEX_CACHE : isAsset ? ASSET_CACHE : OTHER_CACHE;
    if (await serveFile(req, res, target, cache)) return;
  } else if (real) {
    // symlink pointing outside the UI dir
    return plain(res, 404, "Not found");
  }

  // SPA fallback: client-side routes have no file extension
  const last = urlPath.split("/").pop() ?? "";
  if (last.includes(".") || urlPath.startsWith("/assets/")) return plain(res, 404, "Not found");
  if (await serveFile(req, res, index, INDEX_CACHE)) return;
  return plain(res, 503, "The user interface is not installed");
}
