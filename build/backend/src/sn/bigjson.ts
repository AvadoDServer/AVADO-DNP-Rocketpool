/**
 * Bigint-safe JSON parsing for Smartnode responses.
 *
 * Smartnode encodes big.Int values (wei amounts) as bare JSON numbers. JSON.parse
 * would silently round them. Every number literal whose magnitude exceeds
 * Number.MAX_SAFE_INTEGER (2^53 - 1) is turned into a string holding its exact
 * original text before parsing; smaller numbers stay numbers.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function isUnsafe(literal: string): boolean {
  if (/^-?\d+$/.test(literal)) {
    const v = BigInt(literal);
    return v > MAX_SAFE || v < -MAX_SAFE;
  }
  // Fractional or exponent form: unsafe when the magnitude is above 2^53
  return Math.abs(Number(literal)) > Number.MAX_SAFE_INTEGER;
}

export function quoteBigNumbers(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  let last = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x22 /* " */) {
      // skip a string literal, honouring escapes
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 0x5c /* \ */) i += 2;
        else if (d === 0x22) {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    if (c === 0x2d /* - */ || (c >= 0x30 && c <= 0x39)) {
      const start = i;
      i++;
      while (i < n) {
        const d = text[i]!;
        if ((d >= "0" && d <= "9") || d === "." || d === "e" || d === "E" || d === "+" || d === "-") i++;
        else break;
      }
      const literal = text.slice(start, i);
      if (isUnsafe(literal)) {
        out += text.slice(last, start) + '"' + literal + '"';
        last = i;
      }
      continue;
    }
    i++;
  }
  return out + text.slice(last);
}

export function parseBigJson(text: string): unknown {
  return JSON.parse(quoteBigNumbers(text));
}
