import type { RequestHead } from "../../../apps/controller/src/drivers/repo/access/backend-contracts.ts";

type RequestHeadOptions = Partial<
  Pick<RequestHead, "receivedMonoMs" | "contentEncoding" | "framing">
>;

// Keep raw targets byte-for-byte, including deliberately invalid protocol inputs.
export function requestHead(
  method: string,
  rawTarget: string,
  headers: RequestHead["headers"] = {},
  {
    receivedMonoMs = 0,
    contentEncoding = "identity",
    framing = { kind: "none", bytes: undefined },
  }: RequestHeadOptions = {},
): RequestHead {
  return {
    method,
    rawTarget,
    headers: {
      ...(["POST", "PATCH"].includes(method) ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    receivedMonoMs,
    contentEncoding,
    framing,
  };
}
