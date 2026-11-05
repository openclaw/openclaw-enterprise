import { isIP } from "node:net";

export function modelEndpointSupportsDnsProofs(endpoint: URL): boolean {
  const hostname = endpoint.hostname;
  // WHATWG URL retains brackets around IPv6 literals; isIP expects the bare address.
  const address =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  return isIP(address) === 0;
}
