import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { createLogger } from "../src/log";

export const TOKEN = "rpsn_" + "ab12".repeat(16);
export const TOKEN2 = "rpsn_" + "cd34".repeat(16);

export interface UpstreamCall {
  method: string;
  path: string;
  query: string;
  body: string;
  auth: string | undefined;
  contentType: string | undefined;
}

export type UpstreamReply = { status?: number; body: string; headers?: Record<string, string> };
export type UpstreamHandler = (call: UpstreamCall) => UpstreamReply | Promise<UpstreamReply>;

export interface Harness {
  config: Config;
  base: string;
  root: string;
  logs: string[];
  calls: UpstreamCall[];
  setUpstream(h: UpstreamHandler): void;
  request(method: string, p: string, opts?: { headers?: Record<string, string>; body?: string }): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    text: string;
    json: any;
  }>;
  post(p: string, body?: unknown, headers?: Record<string, string>): ReturnType<Harness["request"]>;
  close(): Promise<void>;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rp-backend-"));
  const dataDir = path.join(root, "rocketpool", "data");
  const uiDir = path.join(root, "ui");
  await mkdir(dataDir, { recursive: true });
  await mkdir(path.join(uiDir, "assets"), { recursive: true });
  await writeFile(path.join(uiDir, "index.html"), "<!doctype html><title>RP</title>");
  await writeFile(path.join(uiDir, "assets", "app-123.js"), "console.log(1)");
  await writeFile(path.join(uiDir, "favicon.svg"), "<svg/>");
  await writeFile(
    path.join(dataDir, "api-tokens.json"),
    JSON.stringify({ tokens: [{ token: TOKEN, comment: "rocketpool CLI", scope: "write" }] }),
  );

  const calls: UpstreamCall[] = [];
  let handler: UpstreamHandler = () => ({ body: JSON.stringify({ status: "success", error: "" }) });
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const u = new URL(req.url ?? "/", "http://x");
      const call: UpstreamCall = {
        method: req.method ?? "",
        path: u.pathname,
        query: u.search,
        body,
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
      };
      calls.push(call);
      const out = await handler(call);
      if (res.destroyed) return;
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json", ...(out.headers ?? {}) });
      res.end(out.body);
    });
  });
  const upPort = await listen(upstream);

  const config: Config = {
    ...loadConfig({
      DATA_DIR: dataDir,
      UI_DIR: uiDir,
      SN_API: `http://127.0.0.1:${upPort}`,
      BACKUP_DIR: path.join(root, "rocketpool", "backups"),
      RECONCILE_STATUS_FILE: path.join(root, "reconcile-status.json"),
      RECONCILE_TRIGGER_FILE: path.join(root, "reconcile-now"),
      DAEMON_LOG_FILE: path.join(root, "daemon.log"),
      STARTUP_ERROR_FILE: path.join(root, "startup-error.txt"),
      SUPERVISOR_SOCKET: path.join(root, "supervisor.sock"),
      PACKAGE_VERSION: "1.0.0-test",
      ...env,
    }),
  };
  const logs: string[] = [];
  const app = http.createServer(createApp(config, createLogger((_lvl, line) => logs.push(line))));
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;

  const request: Harness["request"] = async (method, p, opts = {}) => {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${base}${p}`,
        { method, headers: { Host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) } },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (text += c));
          res.on("end", () => {
            let json: any;
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
          });
        },
      );
      req.on("error", reject);
      req.end(opts.body);
    });
  };

  return {
    config,
    base,
    root,
    logs,
    calls,
    setUpstream(h) {
      handler = h;
    },
    request,
    post(p, body = {}, headers = {}) {
      return request("POST", p, {
        headers: {
          "Content-Type": "application/json",
          "X-Avado-Request": "1",
          Origin: base,
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    },
    async close() {
      await new Promise((r) => app.close(r));
      await new Promise((r) => upstream.close(r));
      await rm(root, { recursive: true, force: true });
    },
  };
}
