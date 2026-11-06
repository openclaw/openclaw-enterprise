import { isIPv4 } from "node:net";

export const TRANSPORT_PORT = 8443;
export const CONNECT_TIMEOUT_MS = 3_000;
export const MAX_CONNECTIONS = 32;

export function privateIPv4(address: string): string {
  if (isIPv4(address)) {
    const [first, second] = address.split(".").map(Number);
    if (
      first === 10 ||
      (first === 192 && second === 168) ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31)
    ) {
      return address;
    }
  }
  throw new Error("A fixed RFC 1918 IPv4 address is required.");
}

export function dnsAuthority(value: string): string {
  const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (
    value.length > 253 ||
    !value.includes(".") ||
    isIPv4(value) ||
    !value.split(".").every((label) => dnsLabel.test(label))
  ) {
    throw new Error("A fixed lowercase DNS authority is required.");
  }
  return value;
}
