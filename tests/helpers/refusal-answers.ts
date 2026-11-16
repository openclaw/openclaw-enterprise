import assert from "node:assert/strict";

import { requestFailure } from "../../apps/controller/src/http/errors.ts";

type RefusalAnswer = Pick<ReturnType<typeof requestFailure>, "status" | "code" | "message">;

interface Response {
  readonly status: number;
  readonly error?: unknown;
  readonly body?: unknown;
}

type NormalizedAnswer = Record<string, unknown> & Pick<Response, "status">;

/** Maps a thrown or rejected OCC error to its HTTP status, code and message. */
export async function refusedAnswer(
  work: () => unknown,
  options?: Parameters<typeof requestFailure>[1],
): Promise<RefusalAnswer> {
  const error: unknown = await Promise.resolve()
    .then(work)
    .then(
      () => assert.fail("the request must be refused"),
      (rejection: unknown) => rejection,
    );
  const { status, code, message } = requestFailure(error, options);
  return { status, code, message };
}

/**
 * Compare the entire error across requests, hiding only the ID sent by each request. A denial
 * must give the same answer for an unreadable resource and IDs that do not exist.
 * Accepts top-level, body-wrapped and flat errors. Successful responses with a body compare
 * by status alone. The first answer must match the expected status and is returned normalized.
 */
export async function assertSameAnswer(
  send: (id: string) => Response | PromiseLike<Response>,
  ids: readonly string[],
  { status = 403, label = "" }: { status?: number; label?: string } = {},
): Promise<NormalizedAnswer> {
  const [firstId, ...otherIds] = ids;
  assert.ok(
    firstId !== undefined && otherIds.length > 0,
    "compare an existing ID with at least one missing ID",
  );
  const first = normalizeAnswer(await send(firstId), firstId);
  const answers: NormalizedAnswer[] = [];
  for (const id of otherIds) {
    answers.push(normalizeAnswer(await send(id), id));
  }
  const prefix = label === "" ? "" : `${label}: `;
  assert.equal(first.status, status, `${prefix}${JSON.stringify(first)}`);
  for (const answer of answers) {
    assert.deepEqual(answer, first, `${prefix}a missing ID must get the same answer`);
  }
  return first;
}

function normalizeAnswer(response: Response, id: string): NormalizedAnswer {
  const { body, status } = response;
  const bodyError = isRecord(body) ? body.error : undefined;
  const error = response.error ?? bodyError ?? (body === undefined ? response : {});
  const masked = hideSentId(error, id);
  const fields =
    typeof masked === "string" ? Object.fromEntries(Object.entries<string>(masked)) : masked;
  return { ...(isRecord(fields) ? fields : {}), status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function hideSentId(value: unknown, id: string): unknown {
  if (typeof value === "string") {
    return value.replaceAll(id, "<id>");
  }
  const items: readonly unknown[] | undefined = Array.isArray(value) ? value : undefined;
  if (items !== undefined) {
    return items.map((item) => hideSentId(item, id));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, hideSentId(item, id)]),
    );
  }
  return value;
}
