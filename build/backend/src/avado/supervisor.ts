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

/**
 * Asks supervisord (XML-RPC over its unix socket) for a program's state.
 * No shell is involved; the program name comes from configuration, never from a request.
 */
export function getProcessState(socketPath: string, program: string, timeoutMs = 2000): Promise<ProcessState> {
  const body =
    `<?xml version="1.0"?><methodCall><methodName>supervisor.getProcessInfo</methodName>` +
    `<params><param><value><string>${xmlEscape(program)}</string></value></param></params></methodCall>`;
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath,
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
            return resolve({ state: "UNKNOWN", error: member(xml, "faultString") ?? "supervisord fault" });
          }
          const state = member(xml, "statename");
          if (!state) return resolve({ state: "UNKNOWN", error: "Unexpected supervisord response" });
          const start = Number(member(xml, "start"));
          const exit = Number(member(xml, "exitstatus"));
          resolve({
            state,
            description: member(xml, "description"),
            since: state === "RUNNING" && start > 0 ? new Date(start * 1000).toISOString() : undefined,
            exitStatus: Number.isFinite(exit) && state !== "RUNNING" ? exit : undefined,
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ state: "UNKNOWN", error: `supervisord not reachable: ${err.message}` }));
    req.end(body);
  });
}
