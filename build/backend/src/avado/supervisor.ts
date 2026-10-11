import http from "node:http";

export interface ProcessState {
  /** Supervisord state name: RUNNING, STARTING, BACKOFF, STOPPED, EXITED, FATAL, …; UNKNOWN when supervisord can't be asked. */
  state: string;
  description?: string;
  /** Process start time (ISO), when running. */
  since?: string;
  exitStatus?: number;
  error?: string;
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function member(xml: string, name: string): string | undefined {
  const re = new RegExp(`<name>${name}</name>\\s*<value>\\s*(?:<(?:string|int|i4)>)?([^<]*)`);
  return re.exec(xml)?.[1];
}

type RpcParam = string | boolean;

function rpcValue(p: RpcParam): string {
  return typeof p === "boolean" ? `<boolean>${p ? 1 : 0}</boolean>` : `<string>${xmlEscape(p)}</string>`;
}

/** Outcome of one XML-RPC call: the response XML, or why there is none (fault string or transport error). */
type RpcResult = { ok: true; xml: string } | { ok: false; fault?: string; error: string };

/**
 * One XML-RPC call to supervisord over its unix socket. No shell is involved; method
 * names and the program name come from code and configuration, never from a request.
 * `deadlineMs` is wall-clock time for the whole call: the request is destroyed when it
 * runs out. Always settles, exactly once.
 */
function rpc(socketPath: string, methodName: string, params: RpcParam[], deadlineMs: number): Promise<RpcResult> {
  const body =
    `<?xml version="1.0"?><methodCall><methodName>${methodName}</methodName><params>` +
    params.map((p) => `<param><value>${rpcValue(p)}</value></param>`).join("") +
    `</params></methodCall>`;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: RpcResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const req = http.request(
      {
        socketPath,
        // one connection per call: a pooled keep-alive socket can outlive a supervisord restart
        agent: false,
        path: "/RPC2",
        method: "POST",
        headers: { "Content-Type": "text/xml", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let xml = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          if (xml.length < 64 * 1024) xml += c;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) return settle({ ok: false, error: `supervisord answered HTTP ${res.statusCode}` });
          if (!xml.includes("<methodResponse>")) return settle({ ok: false, error: "Unexpected supervisord response" });
          if (xml.includes("<fault>")) {
            const fault = member(xml, "faultString") ?? "supervisord fault";
            return settle({ ok: false, fault, error: fault });
          }
          settle({ ok: true, xml });
        });
        res.on("error", (err) => settle({ ok: false, error: `supervisord not reachable: ${err.message}` }));
        res.on("aborted", () => settle({ ok: false, error: "supervisord closed the connection" }));
        res.on("close", () => settle({ ok: false, error: "supervisord closed the connection" }));
      },
    );
    const timer = setTimeout(() => {
      settle({ ok: false, error: `supervisord did not answer within ${Math.round(deadlineMs / 1000)}s` });
      req.destroy();
    }, deadlineMs);
    req.on("error", (err) => settle({ ok: false, error: `supervisord not reachable: ${err.message}` }));
    req.end(body);
  });
}

/** Asks supervisord for a program's state. */
export async function getProcessState(socketPath: string, program: string, timeoutMs = 2000): Promise<ProcessState> {
  const r = await rpc(socketPath, "supervisor.getProcessInfo", [program], timeoutMs);
  if (!r.ok) return { state: "UNKNOWN", error: r.error };
  const xml = r.xml;
  const state = member(xml, "statename");
  if (!state) return { state: "UNKNOWN", error: "Unexpected supervisord response" };
  const start = Number(member(xml, "start"));
  const exit = Number(member(xml, "exitstatus"));
  return {
    state,
    description: member(xml, "description"),
    since: state === "RUNNING" && start > 0 ? new Date(start * 1000).toISOString() : undefined,
    exitStatus: Number.isFinite(exit) && state !== "RUNNING" ? exit : undefined,
  };
}

/** How long the restart waits for the daemon to stop (supervisord.conf: stopwaitsecs=60). */
export const RESTART_STOP_DEADLINE_MS = 70_000;
/** startProcess is sent without waiting, so its answer is quick. */
export const RESTART_START_TIMEOUT_MS = 5_000;

/**
 * Restarts a supervisord program: stopProcess(program, wait=true) under a wall-clock
 * deadline (NOT_RUNNING is fine), then startProcess(program, wait=false), which returns
 * as soon as supervisord has accepted it. The start is sent even when the stop timed out
 * or failed, so the program is never left stopped by this call; ALREADY_STARTED counts as
 * success. `ok` is false only when the start itself failed. Never throws.
 */
export async function restartProcess(
  socketPath: string,
  program: string,
  stopDeadlineMs = RESTART_STOP_DEADLINE_MS,
  startTimeoutMs = RESTART_START_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
  await rpc(socketPath, "supervisor.stopProcess", [program, true], stopDeadlineMs);
  const start = await rpc(socketPath, "supervisor.startProcess", [program, false], startTimeoutMs);
  if (!start.ok && !start.fault?.includes("ALREADY_STARTED")) return { ok: false, error: `starting ${program}: ${start.error}` };
  return { ok: true };
}
