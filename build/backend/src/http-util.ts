import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** JSON reply in Smartnode's envelope style: {status, error, ...}. */
export function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

export function sendError(res: ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { status: "error", error: message });
}

export const MAX_BODY_BYTES = 64 * 1024;

export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, "Request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Parses a request body into flat string parameters.
 * Accepts application/json (a flat object of strings, numbers and booleans) or
 * application/x-www-form-urlencoded. An empty body gives no parameters.
 */
export function parseParams(contentType: string | undefined, body: Buffer): Map<string, string> {
  const params = new Map<string, string>();
  if (body.length === 0) return params;
  const type = (contentType || "").split(";")[0]!.trim().toLowerCase();
  const text = body.toString("utf8");
  if (type === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "JSON body must be an object");
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        params.set(key, String(value));
      } else {
        throw new HttpError(400, `Parameter "${key}" must be a string, number or boolean`);
      }
    }
    return params;
  }
  if (type === "application/x-www-form-urlencoded") {
    for (const [key, value] of new URLSearchParams(text)) params.set(key, value);
    return params;
  }
  throw new HttpError(415, "Use application/json or application/x-www-form-urlencoded");
}
