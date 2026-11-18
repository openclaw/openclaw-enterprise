import type { ChannelDirectoryLookupBody } from "../../../packages/contracts/src/api/common.ts";
import type { ChannelDirectoryResult } from "@openclaw-enterprise/contracts";
import { fixtureError, fixtureResponse } from "./preview-rules.mts";

interface DirectoryEvidence {
  kind: "users" | "channels";
  query: string;
  cursor: string | null;
  ids: string[] | null;
}

// Secret aliases belong to the preview map. Optional owner IDs retain their wire forms.
// eslint-disable-next-line no-control-regex -- directory IDs must exclude ASCII control characters.
const idControls = /[\u0000-\u001f\u007f]/;
const ownerId = /^(?:agt|cfg)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const commonFields = ["kind", "secretId", "agentId", "configurationId"];
const lookupFields = [...commonFields, "query", "cursor"];
const hydrationFields = [...commonFields, "ids"];

function isLookupBody(body: unknown): body is ChannelDirectoryLookupBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  if (
    !("kind" in body) ||
    (body.kind !== "users" && body.kind !== "channels") ||
    !("secretId" in body) ||
    typeof body.secretId !== "string" ||
    !body.secretId ||
    [...body.secretId].length > 200 ||
    body.secretId.includes("\0") ||
    ("agentId" in body && "configurationId" in body)
  ) {
    return false;
  }
  if (
    "agentId" in body &&
    (typeof body.agentId !== "string" ||
      !body.agentId.startsWith("agt_") ||
      !ownerId.test(body.agentId))
  ) {
    return false;
  }
  if (
    "configurationId" in body &&
    (typeof body.configurationId !== "string" ||
      !body.configurationId.startsWith("cfg_") ||
      !ownerId.test(body.configurationId))
  ) {
    return false;
  }
  if ("ids" in body) {
    return (
      Object.keys(body).every((key) => hydrationFields.includes(key)) &&
      Array.isArray(body.ids) &&
      body.ids.length >= 1 &&
      body.ids.length <= 20 &&
      body.ids.every(
        (id: unknown) =>
          typeof id === "string" && id.length >= 1 && [...id].length <= 200 && !idControls.test(id),
      ) &&
      new Set(body.ids).size === body.ids.length
    );
  }
  return (
    Object.keys(body).every((key) => lookupFields.includes(key)) &&
    (!("query" in body) ||
      (typeof body.query === "string" &&
        [...body.query].length <= 200 &&
        !body.query.includes("\0"))) &&
    (!("cursor" in body) ||
      (typeof body.cursor === "string" &&
        body.cursor.length >= 1 &&
        [...body.cursor].length <= 2048 &&
        !body.cursor.includes("\0")))
  );
}

export function serveChannelDirectory(
  body: unknown,
  secrets: ReadonlyMap<string, unknown>,
  evidence: { directoryResponses: DirectoryEvidence[] },
): Response {
  if (!isLookupBody(body)) {
    return fixtureError(400, "INVALID_REQUEST", "Malformed channel directory preview request.");
  }
  if (!secrets.has(body.secretId)) {
    return fixtureError(400, "INVALID_REQUEST", "The simulated Secret is not in this preview.");
  }
  const ids = "ids" in body ? body.ids : undefined;
  const query = "query" in body ? body.query : undefined;
  const cursor = "cursor" in body ? body.cursor : undefined;
  if (cursor !== undefined && cursor !== "page-2") {
    return fixtureError(400, "INVALID_REQUEST", "The preview cursor is not recognized.");
  }
  const candidates: ChannelDirectoryResult["candidates"] =
    body.kind === "users"
      ? [
          { id: "UDEMO123", name: "alex.chen", displayName: "Alex Chen" },
          { id: "UDEMO124", name: "alex.ops", displayName: "Alex Chen" },
          { id: "WDEMO125", name: "sam.rivers", displayName: "Sam Rivers" },
          { id: "UDEMO126", name: "riley.park", displayName: "Riley Park" },
          { id: "UDEMO127", name: "morgan.lee", displayName: "Morgan Lee" },
          { id: "UDEMO128", name: "jordan.bell", displayName: "Jordan Bell" },
          { id: "UDEMO129", name: "taylor.reed", displayName: "Taylor Reed" },
          { id: "UDEMO130", name: "casey.wong", displayName: "Casey Wong" },
          { id: "UDEMO131", name: "jamie.stone", displayName: "Jamie Stone" },
        ]
      : [
          { id: "CDEMO123", name: "general" },
          { id: "GDEMO124", name: "incident-private" },
          { id: "CDEMO125", name: "platform" },
          { id: "CDEMO126", name: "releases" },
          { id: "CDEMO127", name: "support" },
          { id: "CDEMO128", name: "design" },
          { id: "CDEMO129", name: "engineering" },
          { id: "CDEMO130", name: "product" },
          { id: "CDEMO131", name: "announcements" },
        ];
  const search = (query ?? "").toLowerCase();
  const matches = candidates.filter((candidate) =>
    ids
      ? ids.includes(candidate.id)
      : [candidate.id, candidate.name, candidate.displayName ?? ""].some((value) =>
          value.toLowerCase().includes(search),
        ),
  );
  const offset = cursor === "page-2" ? 7 : 0;
  const nextCursor = !ids && matches.length > offset + 7 ? "page-2" : undefined;
  evidence.directoryResponses.push({
    kind: body.kind,
    query: query ?? "",
    cursor: cursor ?? null,
    ids: ids ?? null,
  });
  const result: ChannelDirectoryResult = {
    workspaceId: "TDEMO123",
    workspaceName: "Demo workspace",
    candidates: ids ? matches : matches.slice(offset, offset + 7),
    ...(nextCursor ? { nextCursor } : {}),
    complete: !nextCursor,
  };
  return fixtureResponse(result);
}
