import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config";
import { applyWalletGuards, readWalletState } from "../guards/wallet";
import { HttpError, Limiter, parseParams, readBody, sendError, sendJson } from "../http-util";
import type { Logger } from "../log";
import { redact } from "../log";
import { recordDepositKeys } from "../reconcile/api";
import { lookupRoute } from "./allowlist";
import { parseBigJson } from "./bigjson";
import { readApiToken } from "./token";

export const SN_PREFIX = "/api/sn/";

interface Upstream {
  status: number;
  body: unknown;
}

/** Serialises wallet requests so a guard check and the call it allows never interleave with another wallet change. */
let walletLock: Promise<unknown> = Promise.resolve();
function withWalletLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = walletLock.then(fn, fn);
  walletLock = run.catch(() => undefined);
  return run;
}

export class SmartnodeClient {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  /**
   * Calls a Smartnode route with the token injected. GET for reads (params in the
   * query), POST form-encoded for writes. Returns the bigint-safe parsed envelope.
   * The token is read from disk on every call and scrubbed from anything returned.
   */
  async call(
    route: string,
    method: "GET" | "POST",
    params: URLSearchParams,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Upstream> {
    const token = await readApiToken(this.config.dataDir);
    if (!token) throw new HttpError(503, "The Rocket Pool daemon is still starting (no API token yet).");
    const url = new URL(`${this.config.snApi}/api/${route}`);
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
    };
    if (method === "GET") url.search = params.toString();
    else {
      (init.headers as Record<string, string>)["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = params.toString();
    }
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    init.signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;

    let res: Response;
    let text: string;
    try {
      res = await fetch(url, init);
      text = await res.text();
    } catch (err) {
      if (timeout.aborted) throw new HttpError(504, "The Rocket Pool daemon did not answer in time.");
      if (opts.signal?.aborted) throw new HttpError(499, "Client closed the request");
      throw new HttpError(502, "The Rocket Pool daemon is not reachable (it may still be starting).");
    }
    // defence in depth: the token never leaves this process
    if (text.includes(token)) text = text.split(token).join("[redacted]");
    let body: unknown;
    try {
      body = parseBigJson(text);
    } catch {
      this.logger.warn(`smartnode ${route}: non-JSON response (HTTP ${res.status})`);
      throw new HttpError(502, `Unexpected response from the Rocket Pool daemon (HTTP ${res.status}).`);
    }
    return { status: res.status, body };
  }
}

function toSearchParams(params: Map<string, string>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of params) sp.append(k, v);
  return sp;
}

/**
 * Handles /api/sn/<route>. The caller has already applied the CSRF guard.
 */
export async function handleSmartnodeProxy(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
  deps: { config: Config; logger: Logger; client: SmartnodeClient; longLimiter: Limiter },
): Promise<void> {
  const { config, logger, client, longLimiter } = deps;
  const route = pathname.slice(SN_PREFIX.length);
  const spec = lookupRoute(route);
  if (!spec) return sendError(res, 404, "Unknown API route");

  const expected = spec.kind === "R" ? "GET" : "POST";
  if (req.method !== expected) {
    res.setHeader("Allow", expected);
    return sendError(res, 405, `Use ${expected} for this route`);
  }

  // bound the number of requests that may hold an upstream call open for up to an hour
  if (spec.long && !longLimiter.try()) {
    logger.warn(`${req.method} ${SN_PREFIX}${route} refused: too many long-running requests`);
    return sendError(res, 429, "Too many long-running requests at once. Please try again shortly.");
  }

  const started = Date.now();
  let status = 500;
  try {

    const clientGone = new AbortController();
    // a GET (reads, /wait) is cancelled when the browser goes away; writes are left to finish
    if (expected === "GET") res.on("close", () => !res.writableFinished && clientGone.abort());

    const forward = async (params: URLSearchParams) => {
      const upstream = await client.call(route, expected, params, {
        timeoutMs: spec.long ? config.snLongTimeoutMs : config.snTimeoutMs,
        signal: expected === "GET" ? clientGone.signal : undefined,
      });
      status = upstream.status;
      const body = upstream.body;
      // keys created by this node's own deposit may be loaded into the VC without asking
      if (route === "node/deposit" && status === 200) {
        try {
          const n = await recordDepositKeys(config, body);
          if (n > 0) logger.info(`node/deposit: ${n} new validator key(s) approved for loading`);
        } catch (e) {
          logger.error(`node/deposit: could not record the new validator keys as approved: ${String((e as Error)?.message ?? e)}`);
        }
      }
      if (!spec.secret && status >= 400) {
        const msg = (body as { error?: unknown })?.error;
        logger.warn(`smartnode ${route}: HTTP ${status}${typeof msg === "string" ? `: ${msg}` : ""}`);
      }
      sendJson(res, status, body);
    };

    if (expected === "GET") {
      await forward(query);
    } else {
      if ([...query.keys()].length > 0) throw new HttpError(400, "Send parameters in the request body, not the URL");
      const raw = parseParams(req.headers["content-type"], await readBody(req));
      const guardCtx = {
        walletState: () =>
          readWalletState(config.dataDir, async () => {
            const r = await client.call("wallet/status", "GET", new URLSearchParams(), { timeoutMs: 10_000 });
            return r.status === 200 ? (r.body as { walletInitialized?: unknown; passwordSet?: unknown }) : null;
          }),
      };
      const run = async () => {
        const outcome = await applyWalletGuards(route, raw, guardCtx);
        await forward(toSearchParams(outcome.params));
      };
      if (route.startsWith("wallet/")) await withWalletLock(run);
      else await run();
    }
  } catch (err) {
    if (err instanceof HttpError) {
      status = err.statusCode;
      if (status !== 499 && !res.headersSent) sendError(res, status, err.message);
    } else {
      status = 500;
      logger.error(`smartnode ${route}: ${redact(String((err as Error)?.message ?? err))}`);
      if (!res.headersSent) sendError(res, 500, "Internal error");
    }
  } finally {
    if (spec.long) longLimiter.release();
    // one line per call: method, route and status only (never query, body or headers)
    logger.info(`${req.method} ${SN_PREFIX}${route} ${status} ${Date.now() - started}ms`);
  }
}
