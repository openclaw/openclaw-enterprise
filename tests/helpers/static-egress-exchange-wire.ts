import assert from "node:assert/strict";
import { isArray, isBoundedInteger, isChoice, isRecord } from "./egress-observation-values.ts";

type Header = { name: string; value: string };
type Timestamp = { seconds: string; nanos?: number };
type Handle = { request_id: string; operation_handle: Buffer; audience: string };
type Evidence = {
  material_id: string;
  material_version: string;
  usable_until: Timestamp;
  authority_evidence: Buffer;
};
export type Material = Handle & { evidence: Evidence; credential_headers: Header[] };
type Refusal = { code: number };

export type Resolution =
  | { result: "ready"; ready: Material; ready_without_material?: never; refused?: never }
  | {
      result: "ready_without_material";
      ready_without_material: Handle;
      ready?: never;
      refused?: never;
    }
  | { result: "refused"; refused: Refusal; ready?: never; ready_without_material?: never };

export type Authorization =
  | {
      result: "allowed";
      allowed: {
        request_id: string;
        operation_handle: Buffer;
        credential_headers_sha256: Buffer;
        send_start_by: Timestamp;
        response_custody: Buffer;
        no_material_required?: boolean;
      };
      refused?: never;
    }
  | { result: "refused"; refused: Refusal; allowed?: never };

export type ResponseFrame = {
  status: number;
  headers?: Header[];
  body: Buffer;
  trailers?: Header[];
  response_complete: boolean;
};
export type CompleteReply = ResponseFrame & { response_complete: true };
type Lease = { renew_by: Timestamp; expires_at: Timestamp };
type ReplyPayloads = {
  challenge: Buffer;
  resolved: Resolution;
  authorized: Authorization;
  response: CompleteReply;
  lease: Lease;
};

export type ExchangeReply = {
  [Event in keyof ReplyPayloads]: { event: Event } & Record<Event, ReplyPayloads[Event]> & {
      [Other in Exclude<keyof ReplyPayloads, Event>]?: never;
    };
}[keyof ReplyPayloads];

const events = ["challenge", "resolved", "authorized", "response", "lease"] as const;
const resolutions = ["ready", "ready_without_material", "refused"] as const;
const authorizations = ["allowed", "refused"] as const;

function oneof<Field extends string>(
  message: Record<string, unknown>,
  discriminant: string,
  fields: readonly Field[],
): Field {
  const selected = message[discriminant];
  assert.ok(
    isChoice(fields, selected) &&
      Object.hasOwn(message, selected) &&
      fields.every((field) => field === selected || !Object.hasOwn(message, field)),
    `Invalid installation exchange ${discriminant} oneof`,
  );
  return selected;
}

function object(value: unknown, field: string): Record<string, unknown> {
  assert.ok(isRecord(value), `Invalid installation exchange ${field}`);
  return value;
}

function bytes(value: unknown, field: string, length?: number): Buffer {
  assert.ok(
    Buffer.isBuffer(value) && (length === undefined || value.length === length),
    `Invalid installation exchange ${field}`,
  );
  return value;
}

function string(value: unknown, field: string): string {
  assert.ok(typeof value === "string", `Invalid installation exchange ${field}`);
  return value;
}

function timestamp(value: unknown, field: string): Timestamp {
  const { seconds = "0", nanos } = object(value, field);
  assert.ok(
    typeof seconds === "string" &&
      /^-?\d+$/.test(seconds) &&
      // google.protobuf.Timestamp represents years 0001 through 9999.
      Number(seconds) >= -62_135_596_800 &&
      Number(seconds) <= 253_402_300_799 &&
      (nanos === undefined || isBoundedInteger(nanos, 999_999_999)),
    `Invalid installation exchange ${field} timestamp`,
  );
  return nanos === undefined ? { seconds } : { seconds, nanos };
}

function headers(value: unknown, field: string): Header[] {
  if (value === undefined) {
    return [];
  }
  assert.ok(isArray(value), `Invalid installation exchange ${field}`);
  return value.map((line) => {
    const { name, value = "" } = object(line, field);
    return { name: string(name, field), value: string(value, field) };
  });
}

function handle(value: Record<string, unknown>): Handle {
  return {
    request_id: string(value.request_id, "request_id"),
    operation_handle: bytes(value.operation_handle, "operation_handle"),
    audience: string(value.audience, "audience"),
  };
}

function refusal(value: unknown): Refusal {
  const { code } = object(value, "refused");
  assert.ok(isBoundedInteger(code, 5) && code > 0, "Invalid installation exchange refusal code");
  return { code };
}

export function decodeResolution(value: unknown): Resolution {
  const message = object(value, "resolved");
  const result = oneof(message, "result", resolutions);
  switch (result) {
    case "ready": {
      const ready = object(message.ready, "ready");
      const evidence = object(ready.evidence, "evidence");
      return {
        result,
        ready: {
          ...handle(ready),
          evidence: {
            material_id: string(evidence.material_id, "material_id"),
            material_version: string(evidence.material_version, "material_version"),
            usable_until: timestamp(evidence.usable_until, "usable_until"),
            authority_evidence: bytes(evidence.authority_evidence, "authority_evidence"),
          },
          credential_headers: headers(ready.credential_headers, "credential_headers"),
        },
      };
    }
    case "ready_without_material":
      return {
        result,
        ready_without_material: handle(object(message.ready_without_material, result)),
      };
    case "refused":
      return { result, refused: refusal(message.refused) };
  }
}

function authorization(value: unknown): Authorization {
  const message = object(value, "authorized");
  const result = oneof(message, "result", authorizations);
  if (result === "refused") {
    return { result, refused: refusal(message.refused) };
  }
  const allowed = object(message.allowed, "allowed");
  const noMaterial = allowed.no_material_required;
  assert.ok(
    noMaterial === undefined || typeof noMaterial === "boolean",
    "Invalid no-material flag",
  );
  return {
    result,
    allowed: {
      request_id: string(allowed.request_id, "request_id"),
      operation_handle: bytes(allowed.operation_handle, "operation_handle"),
      credential_headers_sha256: bytes(
        allowed.credential_headers_sha256,
        "credential_headers_sha256",
        32,
      ),
      send_start_by: timestamp(allowed.send_start_by, "send_start_by"),
      response_custody: bytes(allowed.response_custody, "response_custody", 32),
      ...(noMaterial === undefined ? {} : { no_material_required: noMaterial }),
    },
  };
}

function completeResponse(value: unknown): CompleteReply {
  const response = object(value, "response");
  assert.ok(
    isBoundedInteger(response.status, 599) &&
      response.status >= 200 &&
      response.response_complete === true,
    "Invalid complete installation exchange response",
  );
  // proto-loader omits empty repeated fields with defaults and arrays disabled.
  return {
    status: response.status,
    ...(response.headers === undefined ? {} : { headers: headers(response.headers, "headers") }),
    body: response.body === undefined ? Buffer.alloc(0) : bytes(response.body, "body"),
    ...(response.trailers === undefined
      ? {}
      : { trailers: headers(response.trailers, "trailers") }),
    response_complete: true,
  };
}

/** Validate the proto-loader output before a frame can enter the receiver's FIFO. */
export function decodeExchangeReply(value: unknown): ExchangeReply {
  const message = object(value, "reply");
  const event = oneof(message, "event", events);
  switch (event) {
    case "challenge":
      return { event, challenge: bytes(message.challenge, event, 32) };
    case "resolved":
      return { event, resolved: decodeResolution(message.resolved) };
    case "authorized":
      return { event, authorized: authorization(message.authorized) };
    case "response":
      return { event, response: completeResponse(message.response) };
    case "lease": {
      const lease = object(message.lease, event);
      return {
        event,
        lease: {
          renew_by: timestamp(lease.renew_by, "renew_by"),
          expires_at: timestamp(lease.expires_at, "expires_at"),
        },
      };
    }
  }
}
