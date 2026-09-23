import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { cleanLine, parseTail, tailFile } from "./avado/logs";
import { getAvadoStatus } from "./avado/status";
import type { Config } from "./config";
import { checkCsrf, isSafeMethod } from "./csrf";
import { sendError, sendJson } from "./http-util";
import type { Logger } from "./log";
import { getReconcileStatus, requestReconcileRun } from "./reconcile";
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

  const avadoRoutes: Record<string, Handler> = {
    "/api/avado/status": method("GET", async (_req, res) => {
      sendJson(res, 200, { status: "success", error: "", ...(await getAvadoStatus(config)) });
    }),
    "/api/avado/reconcile": method("GET", async (_req, res) => {
      sendJson(res, 200, { status: "success", error: "", ...(await getReconcileStatus(config)) });
    }),
    "/api/avado/reconcile/run": method("POST", async (_req, res) => {
      await requestReconcileRun(config);
      logger.info("reconcile run requested");
      sendJson(res, 202, { status: "success", error: "", runRequested: true });
    }),
    "/api/avado/logs": method("GET", async (_req, res, query) => {
      const tail = parseTail(query.get("tail"));
      const lines = await tailFile(config.daemonLogFile, tail);
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

      // every state-changing API request must come from our own page
      const csrf = checkCsrf(req);
      if (csrf) {
        logger.warn(`${req.method} ${pathname} refused: ${csrf}`);
        return sendError(res, 403, csrf);
      }

      if (pathname.startsWith(SN_PREFIX)) {
        return handleSmartnodeProxy(req, res, pathname, url.searchParams, { config, logger, client });
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
