// Compare the API server's fixed-point quantities without float conversion.
// Kubernetes/apimachinery pkg/api/resource: JSON quantities trim Unicode space,
// round away from zero below Nano precision, and cap BinarySI magnitudes only.
interface Amount {
  readonly digits: string;
  readonly exponent: number;
  readonly sign: number;
}
const DECIMAL: Readonly<Record<string, number>> = {
  "": 0,
  n: -9,
  u: -6,
  m: -3,
  k: 3,
  M: 6,
  G: 9,
  T: 12,
  P: 15,
  E: 18,
};
const BINARY: Readonly<Record<string, number>> = {
  Ki: 10,
  Mi: 20,
  Gi: 30,
  Ti: 40,
  Pi: 50,
  Ei: 60,
};
const GRAMMAR = /^([+-]?)([0-9]*)(?:\.([0-9]*))?([numkMGTPE]|[KMGTPE]i|[eE][+-]?[0-9]+)?$/;
const BINARY_MAX: Amount = { digits: "9223372036854775807", exponent: 0, sign: 1 };

function normalized(digits: string, exponent: number, negative: boolean): Amount {
  digits = digits.replace(/^0+/, "");
  if (!digits) {
    return { digits: "0", exponent: 0, sign: 0 };
  }
  if (exponent < -9) {
    const cut = -9 - exponent;
    const remainder = cut >= digits.length ? digits : digits.slice(-cut);
    const kept = cut >= digits.length ? "0" : digits.slice(0, -cut);
    digits = String(BigInt(kept) + (/[1-9]/.test(remainder) ? 1n : 0n));
    exponent = -9;
  }
  const zeros = /0+$/.exec(digits)?.[0].length ?? 0;
  if (zeros) {
    digits = digits.slice(0, -zeros);
    exponent += zeros;
  }
  return { digits, exponent, sign: negative ? -1 : 1 };
}

function magnitude(a: Amount, b: Amount): number {
  const rank = a.digits.length + a.exponent - b.digits.length - b.exponent;
  if (rank) {
    return Math.sign(rank);
  }
  const width = Math.max(a.digits.length, b.digits.length);
  const aa = a.digits.padEnd(width, "0");
  const bb = b.digits.padEnd(width, "0");
  return aa === bb ? 0 : aa < bb ? -1 : 1;
}

function parsed(value: string): Amount | undefined {
  // Quantity.UnmarshalJSON receives the JSON spelling, not an unescaped string.
  value = JSON.stringify(value)
    .slice(1, -1)
    .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const match = GRAMMAR.exec(value);
  if (!value || !match || match[0] !== value) {
    return undefined;
  }
  const [, sign, integer, fraction = "", suffix = ""] = match;
  let exponent = DECIMAL[suffix!];
  let digits = (integer! + fraction).replace(/^0+/, "") || "0";
  const binaryExponent = BINARY[suffix!];
  if (exponent === undefined && binaryExponent === undefined) {
    const e = BigInt(suffix.slice(1));
    if (e < -(1n << 63n) || e > (1n << 63n) - 1n) {
      return undefined;
    }
    exponent = Number(BigInt.asIntN(32, e));
  }
  // The native fast path accepts implicit zero; its decimal slow path needs digits.
  if (
    !/[0-9]/.test(integer! + fraction) &&
    ((binaryExponent !== undefined && binaryExponent >= 50) ||
      (binaryExponent === undefined && exponent! < -9))
  ) {
    return undefined;
  }
  if (binaryExponent !== undefined) {
    digits = String(BigInt(digits) << BigInt(binaryExponent));
    exponent = 0;
  }
  const amount = normalized(
    digits,
    Number(BigInt.asIntN(32, BigInt(exponent!) - BigInt(fraction.length))),
    sign === "-",
  );
  return binaryExponent !== undefined && amount.sign && magnitude(amount, BINARY_MAX) > 0
    ? { ...BINARY_MAX, sign: amount.sign }
    : amount;
}

/** Undefined means the API server cannot parse one of these JSON quantity strings. */
export function compareResourceQuantities(request: string, limit: string): number | undefined {
  const a = parsed(request);
  const b = parsed(limit);
  if (!a || !b) {
    return undefined;
  }
  if (a.sign !== b.sign) {
    return Math.sign(a.sign - b.sign);
  }
  return a.sign === 0 ? 0 : a.sign * magnitude(a, b);
}
