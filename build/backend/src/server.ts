import http from "node:http";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createLogger } from "./log";
import { startReconcileLoop } from "./reconcile";

const config = loadConfig();
const logger = createLogger();

process.on("unhandledRejection", (reason) => {
  logger.error(`unhandled rejection: ${String((reason as Error)?.message ?? reason)}`);
});

const server = http.createServer(createApp(config, logger));
// /api/wait and wallet recovery hold a response open; that is bounded per route in sn/proxy.ts
server.requestTimeout = 120_000; // time to receive a request, not to answer it
server.headersTimeout = 60_000;

server.listen(config.port, config.host, () => {
  logger.info(`AVADO Rocket Pool backend listening on ${config.host}:${config.port} (UI ${config.uiDir}, Smartnode ${config.snApi})`);
});

const loop = startReconcileLoop(config, logger);

function shutdown(signal: string): void {
  logger.info(`${signal} received, shutting down`);
  loop.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
