/**
 * A minimal WAMP v2 caller over a JSON WebSocket (HELLO → WELCOME, then CALL →
 * RESULT | ERROR), ported from AVADO-Client-UI src/api/wamp.ts for Node 22's global
 * WebSocket. The DAPPMANAGER router (realm dappnode_admin at ws://wamp.my.ava.do:8080/ws)
 * accepts anonymous sessions, as it did for the old wizards' autobahn clients.
 *
 * The reconcile loop opens one session per run and closes it afterwards; nothing is kept
 * open between runs.
 */

const HELLO = 1;
const WELCOME = 2;
const ABORT = 3;
const CHALLENGE = 4;
const GOODBYE = 6;
const ERROR = 8;
const CALL = 48;
const RESULT = 50;

export class WampError extends Error {
  constructor(
    message: string,
    /** "unavailable" means nobody can answer right now (router down, DAPPMANAGER restarting). */
    readonly kind: "unavailable" | "timeout" | "rejected",
  ) {
    super(message);
  }
}

/** While the DAPPMANAGER restarts its procedures are unregistered: that is "unavailable", not a refusal. */
const UNAVAILABLE_ERRORS = new Set(["wamp.error.no_such_procedure", "wamp.error.canceled", "wamp.error.timeout"]);

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

export interface WampOptions {
  url: string;
  realm: string;
  /** Defaults to Node's global WebSocket. */
  WebSocket?: WebSocketCtor;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

export interface WampCaller {
  call(procedure: string, args?: unknown[], kwargs?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

interface Pending {
  procedure: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;

export class WampClient implements WampCaller {
  private readonly url: string;
  private readonly realm: string;
  private readonly Ctor: WebSocketCtor | undefined;
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private session: Promise<WebSocketLike> | null = null;
  private ws: WebSocketLike | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(opts: WampOptions) {
    this.url = opts.url;
    this.realm = opts.realm;
    this.Ctor = opts.WebSocket ?? (globalThis as { WebSocket?: unknown }).WebSocket as WebSocketCtor | undefined;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  }

  /** Resolves to the first positional result (or the keyword results), like autobahn. */
  call(procedure: string, args?: unknown[], kwargs?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.connect().then(
      (ws) =>
        new Promise((resolve, reject) => {
          if (ws.readyState !== OPEN) {
            reject(new WampError(`${procedure}: session closed`, "unavailable"));
            return;
          }
          const id = this.nextId++;
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new WampError(`${procedure}: no answer in time`, "timeout"));
          }, timeoutMs ?? this.callTimeoutMs);
          this.pending.set(id, { procedure, resolve, reject, timer });
          const msg: unknown[] = [CALL, id, {}, procedure];
          if (args !== undefined || kwargs !== undefined) msg.push(args ?? []);
          if (kwargs !== undefined) msg.push(kwargs);
          ws.send(JSON.stringify(msg));
        }),
    );
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.session = null;
    this.rejectAll("closed");
    try {
      if (ws && ws.readyState === OPEN) ws.send(JSON.stringify([GOODBYE, {}, "wamp.close.system_shutdown"]));
      ws?.close(1000);
    } catch {
      /* already closed */
    }
  }

  private rejectAll(detail: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new WampError(`${p.procedure}: ${detail}`, "unavailable"));
      this.pending.delete(id);
    }
  }

  private connect(): Promise<WebSocketLike> {
    if (this.session) return this.session;
    const { url, realm, Ctor } = this;

    const session = new Promise<WebSocketLike>((resolve, reject) => {
      if (!Ctor) {
        reject(new WampError("WebSocket is not available in this runtime", "unavailable"));
        return;
      }
      let ws: WebSocketLike;
      try {
        ws = new Ctor(url, ["wamp.2.json"]);
      } catch (e) {
        reject(new WampError(`cannot open ${url}: ${e instanceof Error ? e.message : String(e)}`, "unavailable"));
        return;
      }
      this.ws = ws;
      let settled = false;
      const fail = (err: WampError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      const timer = setTimeout(() => {
        fail(new WampError(`no WELCOME from ${url}`, "timeout"));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, this.connectTimeoutMs);

      ws.onopen = () => {
        ws.send(JSON.stringify([HELLO, realm, { roles: { caller: { features: {} } }, agent: "avado-rocketpool-backend" }]));
      };
      ws.onerror = () => {
        /* onclose follows */
      };
      ws.onclose = () => {
        fail(new WampError(`connection to ${url} closed`, "unavailable"));
        if (this.ws !== ws) return;
        this.ws = null;
        this.session = null;
        this.rejectAll("connection closed");
      };
      ws.onmessage = (ev) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (!Array.isArray(msg)) return;
        switch (msg[0]) {
          case WELCOME:
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(ws);
            }
            break;
          case ABORT: {
            const details = (msg[1] ?? {}) as { message?: string };
            fail(new WampError(`router refused the session: ${[msg[2], details.message].filter(Boolean).join(": ")}`, "rejected"));
            ws.close();
            break;
          }
          case CHALLENGE:
            fail(new WampError("the router asked for authentication", "rejected"));
            ws.close();
            break;
          case GOODBYE:
            ws.send(JSON.stringify([GOODBYE, {}, "wamp.close.goodbye_and_out"]));
            ws.close();
            break;
          case RESULT: {
            const p = this.pending.get(msg[1] as number);
            if (!p) return;
            this.pending.delete(msg[1] as number);
            clearTimeout(p.timer);
            const args = msg[3] as unknown[] | undefined;
            p.resolve(Array.isArray(args) && args.length > 0 ? args[0] : msg[4]);
            break;
          }
          case ERROR: {
            if (msg[1] !== CALL) return;
            const p = this.pending.get(msg[2] as number);
            if (!p) return;
            this.pending.delete(msg[2] as number);
            clearTimeout(p.timer);
            const uri = String(msg[4]);
            const args = msg[5] as unknown[] | undefined;
            const text = Array.isArray(args) && typeof args[0] === "string" ? `: ${args[0]}` : "";
            p.reject(new WampError(`${p.procedure}: ${uri}${text}`, UNAVAILABLE_ERRORS.has(uri) ? "unavailable" : "rejected"));
            break;
          }
        }
      };
    });

    this.session = session;
    session.catch(() => {
      if (this.session === session) this.session = null;
    });
    return session;
  }
}
