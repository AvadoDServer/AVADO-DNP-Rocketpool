import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { BACKUP_DOWNLOAD_LIMIT, handleBackupDownload } from "./avado/backup-download";
import { cleanLine, parseTail, tailFile } from "./avado/logs";
import { getAvadoStatus } from "./avado/status";
import { archiveLegacyMnemonic } from "./backup";
import type { Config } from "./config";
import { checkCsrf, isSafeMethod } from "./csrf";
import { isAllowedHost } from "./host";
import { HttpError, Limiter, readBody, sendError, sendJson } from "./http-util";
import type { Logger } from "./log";
import { approveKeysForLoading, getReconcileStatus, requestReconcileRun } from "./reconcile";
import { handleSmartnodeProxy, SmartnodeClient, SN_PREFIX } from "./sn/proxy";
import { handleStatic } from "./static";

type Handler = (req: IncomingMessage, res: ServerResponse, query: URLSearchParams) => Promise<void>;

function method(expected: "GET" | "POST", handler: Handler): Handler {
  return async (req, res, query) => {
    if (req.method !== expected && !(expected === "GET" && req.method === "HEAD")) {
      res.setHeader("Allow", expected);
      return sendError(res, 405, `Use ${expected} for this route`);
    }
    return handler(req, res, query);
  };
}

export function createApp(config: Config, logger: Logger): RequestListener {
  const client = new SmartnodeClient(config, logger);
  const longLimiter = new Limiter(config.longRequestLimit);
  const logLimiter = new Limiter(config.logReadLimit);
  const downloadLimiter = new Limiter(BACKUP_DOWNLOAD_LIMIT);
  /** The node address from Smartnode's wallet/status (file names only); undefined when unknown. */
  const nodeAddress = async (): Promise<string | undefined> => {
    try {
      const r = await client.call("wallet/status", "GET", new URLSearchParams(), { timeoutMs: 5_000 });
      const a = (r.body as { nodeAddress?: unknown } | null)?.nodeAddress;
      return r.status === 200 && typeof a === "string" ? a : undefined;
    } catch {
      return undefined;
    }
  };

  const avadoRoutes: Record<string, Handler> = {
    "/api/avado/status": method("GET", async (_req, res) => {
      sendJson(res, 200, { status: "success", error: "", ...(await getAvadoStatus(config, logLimiter)) });
    }),
    "/api/avado/reconcile": method("GET", async (_req, res) => {
      sendJson(res, 200, { status: "success", error: "", ...(await getReconcileStatus(config)) });
    }),
    "/api/avado/reconcile/run": method("POST", async (_req, res) => {
      await requestReconcileRun(config);
      logger.info("reconcile run requested");
      sendJson(res, 202, { status: "success", error: "", runRequested: true });
    }),
    "/api/avado/reconcile/approve": method("POST", async (req, res) => {
      const type = (req.headers["content-type"] || "").split(";")[0]!.trim().toLowerCase();
      if (type !== "application/json") return sendError(res, 415, "Use application/json");
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)).toString("utf8"));
      } catch (e) {
        if (e instanceof HttpError) return sendError(res, e.statusCode, e.message);
        return sendError(res, 400, "Invalid JSON body");
      }
      try {
        const r = await approveKeysForLoading(config, body);
        logger.info(`reconcile: owner approved ${r.approved} validator key(s) for loading (${r.added} new)`);
        sendJson(res, 202, { status: "success", error: "", ...r, runRequested: true });
      } catch (e) {
        if (e instanceof HttpError) return sendError(res, e.statusCode, e.message);
        throw e;
      }
    }),
    "/api/avado/legacy-mnemonic/archive": method("POST", async (req, res) => {
      const type = (req.headers["content-type"] || "").split(";")[0]!.trim().toLowerCase();
      if (type !== "application/json") return sendError(res, 415, "Use application/json");
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)).toString("utf8"));
      } catch (e) {
        if (e instanceof HttpError) return sendError(res, e.statusCode, e.message);
        return sendError(res, 400, "Invalid JSON body");
      }
      try {
        const r = await archiveLegacyMnemonic({ dataDir: config.dataDir, backupDir: config.backupDir }, body);
        logger.info(`legacy mnemonic archived to ${r.name}`);
        sendJson(res, 200, { status: "success", error: "", archived: true, name: r.name });
      } catch (e) {
        if (e instanceof HttpError) return sendError(res, e.statusCode, e.message);
        throw e;
      }
    }),
    "/api/avado/backups/download": method("POST", async (req, res) => {
      try {
        await handleBackupDownload(req, res, { config, logger, limiter: downloadLimiter, nodeAddress });
      } catch (e) {
        if (e instanceof HttpError) return sendError(res, e.statusCode, e.message);
        throw e;
      }
    }),
    "/api/avado/logs": method("GET", async (_req, res, query) => {
      const tail = parseTail(query.get("tail"));
      if (!logLimiter.try()) return sendError(res, 429, "Too many log requests at once. Please try again shortly.");
      let lines: string[] | null;
      try {
        lines = await tailFile(config.daemonLogFile, tail);
      } finally {
        logLimiter.release();
      }
      sendJson(res, 200, {
        status: "success",
        error: "",
        available: lines !== null,
        lines: (lines ?? []).map(cleanLine),
      });
    }),
  };

  return (req, res) => {
    void (async () => {
      const started = Date.now();
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        return sendError(res, 400, "Bad request");
      }
      const pathname = url.pathname;

      if (!pathname.startsWith("/api/")) return handleStatic(req, res, pathname, config.uiDir);

      // DNS rebinding guard: the API only answers requests addressed to this box
      if (!isAllowedHost(req.headers.host, config.allowedHostnames)) {
        logger.warn(`${req.method} ${pathname} refused: Host not allowed`);
        return sendError(res, 421, "This API only answers requests addressed to the AVADO box");
      }

      // every state-changing API request must come from our own page
      const csrf = checkCsrf(req);
      if (csrf) {
        logger.warn(`${req.method} ${pathname} refused: ${csrf}`);
        return sendError(res, 403, csrf);
      }

      if (pathname.startsWith(SN_PREFIX)) {
        return handleSmartnodeProxy(req, res, pathname, url.searchParams, { config, logger, client, longLimiter });
      }

      const handler = avadoRoutes[pathname];
      if (!handler) return sendError(res, 404, "Unknown API route");
      await handler(req, res, url.searchParams);
      if (!isSafeMethod(req.method)) logger.info(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    })().catch((err: unknown) => {
      logger.error(`request failed: ${String((err as Error)?.message ?? err)}`);
      if (!res.headersSent) sendError(res, 500, "Internal error");
      else res.destroy();
    });
  };
}
