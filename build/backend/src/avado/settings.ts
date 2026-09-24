import { readFile } from "node:fs/promises";

/**
 * The automatic-transaction settings the daemon actually runs with, read at request
 * time from the rendered Smartnode settings file (build/user-settings.template ->
 * <rpDir>/user-settings.yml, see build/scripts/lib.sh). Every value is a numeric
 * string, exactly as Smartnode stores it.
 *
 * `autoTxGasThreshold` and `minipoolStakeGasThreshold` are the same underlying
 * Smartnode field (Go id `minipoolStakeGasThreshold`; there is no separate
 * `autoTxGasThreshold` key in the settings file), so both names carry the same
 * value here for callers that expect either name. `autoTxMaxFee` is only present
 * if the settings file has it.
 */
export interface AutoTxSettings {
  autoTxGasThreshold: string;
  minipoolStakeGasThreshold: string;
  manualMaxFee: string;
  priorityFee: string;
  distributeThreshold: string;
  autoTxMaxFee?: string;
  /** Unit for each field above, keyed by field name. */
  units: Record<string, string>;
}

const UNITS: Record<string, string> = {
  autoTxGasThreshold: "gwei",
  minipoolStakeGasThreshold: "gwei",
  manualMaxFee: "gwei",
  priorityFee: "gwei",
  distributeThreshold: "ETH",
  autoTxMaxFee: "gwei",
};

/** Keys read from the `smartnode:` section of the rendered settings file. */
const SMARTNODE_KEYS = ["manualMaxFee", "priorityFee", "minipoolStakeGasThreshold", "distributeThreshold", "autoTxMaxFee"];

/** A value must look like a plain (optionally decimal) number to be trusted. */
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Strict, minimal reader for exactly the `smartnode:` section of the rendered
 * Smartnode settings file: a top-level `section:` line (no leading whitespace),
 * then 2-space-indented `key: value` lines, values optionally quoted, `#` starts
 * a comment. This is not a general YAML parser and doesn't need to be: the file
 * is rendered by our own start-node.sh (build/user-settings.template) in this
 * exact shape. Anything it doesn't recognise is simply not collected, never
 * throws.
 */
function parseSmartnodeSection(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  let inSmartnode = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").replace(/\s+$/, "");
    if (line === "") continue;

    const topLevel = /^([A-Za-z_][A-Za-z0-9_]*):\s*$/.exec(line);
    if (topLevel) {
      inSmartnode = topLevel[1] === "smartnode";
      continue;
    }
    if (!inSmartnode) continue;

    const kv = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    if (!key || !SMARTNODE_KEYS.includes(key)) continue;
    found[key] = unquote(rawValue ?? "");
  }
  return found;
}

/**
 * Reads the automatic-transaction settings the daemon runs with, straight from the
 * rendered settings file, at request time. Returns null on any problem at all
 * (file missing or unreadable, unexpected shape, a required value that isn't a
 * plain number) so the caller can omit `settings` rather than fail the request or
 * return something misleading. Never throws.
 */
export async function readAutoTxSettings(settingsFile: string): Promise<AutoTxSettings | null> {
  let text: string;
  try {
    text = await readFile(settingsFile, "utf8");
  } catch {
    return null;
  }

  let found: Record<string, string>;
  try {
    found = parseSmartnodeSection(text);
  } catch {
    return null;
  }

  const required = ["manualMaxFee", "priorityFee", "minipoolStakeGasThreshold", "distributeThreshold"] as const;
  for (const key of required) {
    const value = found[key];
    if (value === undefined || !NUMBER_RE.test(value)) return null;
  }

  const settings: AutoTxSettings = {
    autoTxGasThreshold: found.minipoolStakeGasThreshold!,
    minipoolStakeGasThreshold: found.minipoolStakeGasThreshold!,
    manualMaxFee: found.manualMaxFee!,
    priorityFee: found.priorityFee!,
    distributeThreshold: found.distributeThreshold!,
    units: {
      autoTxGasThreshold: UNITS.autoTxGasThreshold!,
      minipoolStakeGasThreshold: UNITS.minipoolStakeGasThreshold!,
      manualMaxFee: UNITS.manualMaxFee!,
      priorityFee: UNITS.priorityFee!,
      distributeThreshold: UNITS.distributeThreshold!,
    },
  };

  const autoTxMaxFee = found.autoTxMaxFee;
  if (autoTxMaxFee !== undefined && NUMBER_RE.test(autoTxMaxFee)) {
    settings.autoTxMaxFee = autoTxMaxFee;
    settings.units.autoTxMaxFee = UNITS.autoTxMaxFee!;
  }

  return settings;
}
