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
 */
function rpc(socketPath: string, methodName: string, params: RpcParam[], timeoutMs: number): Promise<RpcResult> {
  const body =
    `<?xml version="1.0"?><methodCall><methodName>${methodName}</methodName><params>` +
    params.map((p) => `<param><value>${rpcValue(p)}</value></param>`).join("") +
    `</params></methodCall>`;
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath,
        // one connection per call: a pooled keep-alive socket can outlive a supervisord restart
        agent: false,
        path: "/RPC2",
        method: "POST",
        headers: { "Content-Type": "text/xml", "Content-Length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        let xml = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          if (xml.length < 64 * 1024) xml += c;
        });
        res.on("end", () => {
          if (xml.includes("<fault>")) {
            const fault = member(xml, "faultString") ?? "supervisord fault";
            return resolve({ ok: false, fault, error: fault });
          }
          resolve({ ok: true, xml });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ ok: false, error: `supervisord not reachable: ${err.message}` }));
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

/**
 * Restarts a supervisord program: stopProcess (waiting; NOT_RUNNING is fine), then
 * startProcess (waiting). `timeoutMs` applies to each of the two calls. Never throws.
 */
export async function restartProcess(
  socketPath: string,
  program: string,
  timeoutMs = 20000,
): Promise<{ ok: boolean; error?: string }> {
  const stop = await rpc(socketPath, "supervisor.stopProcess", [program, true], timeoutMs);
  if (!stop.ok && !stop.fault?.includes("NOT_RUNNING")) return { ok: false, error: `stopping ${program}: ${stop.error}` };
  const start = await rpc(socketPath, "supervisor.startProcess", [program, true], timeoutMs);
  if (!start.ok) return { ok: false, error: `starting ${program}: ${start.error}` };
  return { ok: true };
}
