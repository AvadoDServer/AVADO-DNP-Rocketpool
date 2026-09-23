/**
 * Logging with secret redaction. Nothing in this backend logs request or response
 * bodies, headers or query strings; redaction is the second line of defence.
 */

const REDACTED = "[redacted]";

const PATTERNS: Array<[RegExp, string]> = [
  // Smartnode API tokens
  [/rpsn_[0-9a-fA-F]{8,}/g, REDACTED],
  // Bearer credentials
  [/(Bearer\s+)[^\s"',]+/gi, `$1${REDACTED}`],
  // key/value secrets in JSON, form or log style: password=..., "mnemonic":"...", privateKey: ...
  [
    /((?:password|passphrase|mnemonic|private[_-]?key|accountPrivateKey|secret|token)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,&}]+)/gi,
    `$1${REDACTED}`,
  ],
  // A run of 12 or more lowercase words looks like a recovery phrase
  [/\b(?:[a-z]{3,8} ){11,}[a-z]{3,8}\b/g, REDACTED],
];

export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type LogSink = (level: "info" | "warn" | "error", line: string) => void;

const defaultSink: LogSink = (level, line) => {
  if (level === "info") process.stdout.write(line + "\n");
  else process.stderr.write(line + "\n");
};

export function createLogger(sink: LogSink = defaultSink): Logger {
  const write = (level: "info" | "warn" | "error", msg: string) =>
    sink(level, `${new Date().toISOString()} ${level.toUpperCase()} ${redact(msg)}`);
  return {
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
  };
}
