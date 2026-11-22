import assert from "node:assert/strict";
import test from "node:test";
import { requestedValues } from "../../apps/controller/src/http/caller-denial.ts";
import {
  cappedPath,
  requestFailure,
  unstorableTextFailure,
} from "../../apps/controller/src/http/errors.ts";
import {
  RESOURCE_KINDS,
  SUPPORTED_PERMISSION_ACTIONS,
  type AuthorizationEvidence,
  type ErrorDetail,
  type ResourceRef,
} from "../../packages/contracts/src/index.ts";
import {
  AgentPrincipalAuthorizationError,
  AuthorizationDeniedError,
} from "../../packages/occ/src/index.ts";
import { agentPrincipalDenied, callerDenied, GENERIC_DENIAL } from "../helpers/refusal-text.mjs";

type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

interface AjvEntry {
  readonly keyword: string;
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly params: JsonObject;
  readonly schema?: JsonValue;
}

type SentId = ReturnType<typeof requestedValues>;

// A Fastify body-validation error carrying `validation`, Ajv's (verbose) entries.
function contractFailure(validation: readonly AjvEntry[]) {
  return requestFailure(
    Object.assign(new Error("body is invalid"), {
      statusCode: 400,
      validationContext: "body",
      validation,
    }),
  );
}

// Ajv reports a referenced schema's failures under the reference ("Scalar/anyOf/0/type"), not
// under the union branch that refers to it, and an inner union there can have a shorter schema
// path than the outer union (finding 808). Entries as Ajv (verbose) reports a boolean sent for
// `{ anyOf: [{ $ref: "Scalar" }, { type: "null" }] }` where Scalar is a string-or-number union.
test("a nullable union of a referenced schema attributes the reference's problems to its branch", () => {
  const validation: readonly AjvEntry[] = [
    {
      keyword: "type",
      instancePath: "/a",
      schemaPath: "Scalar/anyOf/0/type",
      params: { type: "string" },
    },
    {
      keyword: "type",
      instancePath: "/a",
      schemaPath: "Scalar/anyOf/1/type",
      params: { type: "number" },
    },
    {
      keyword: "anyOf",
      instancePath: "/a",
      schemaPath: "Scalar/anyOf",
      params: {},
      schema: [{ type: "string" }, { type: "number" }],
    },
    {
      keyword: "type",
      instancePath: "/a",
      schemaPath: "#/properties/a/anyOf/1/type",
      params: { type: "null" },
    },
    {
      keyword: "anyOf",
      instancePath: "/a",
      schemaPath: "#/properties/a/anyOf",
      params: {},
      schema: [{ $ref: "Scalar" }, { type: "null" }],
    },
  ];
  const failure = contractFailure(validation);
  assert.equal(failure.status, 400);
  assert.equal(
    failure.message,
    "The request does not match the operation contract: body /a has the wrong type (expected one of string, number, null).",
  );
});

// A reference that two branches make could be either branch's, so it is attributed to neither
// and each problem keeps naming what its field accepts. Entries as Ajv (verbose) reports
// `{ a: { x: [1, 1] } }` for `{ anyOf: [{ $ref: "List" }, { type: "object", properties:
// { x: { $ref: "List" } } }] }`, where List is a uniqueItems array.
test("a reference that two union branches make is attributed to neither", () => {
  const validation: readonly AjvEntry[] = [
    { keyword: "type", instancePath: "/a", schemaPath: "List/type", params: { type: "array" } },
    {
      keyword: "uniqueItems",
      instancePath: "/a/x",
      schemaPath: "List/uniqueItems",
      params: { i: 1, j: 0 },
    },
    {
      keyword: "anyOf",
      instancePath: "/a",
      schemaPath: "#/properties/a/anyOf",
      params: {},
      schema: [{ $ref: "List" }, { type: "object", properties: { x: { $ref: "List" } } }],
    },
  ];
  const failure = contractFailure(validation);
  assert.equal(
    failure.message,
    "The request does not match the operation contract: body /a has the wrong type (expected array); body /a/x has an unsupported value (expected no duplicate items); body /a has an unsupported value.",
  );
});

// The cap as it was before the first segment was cut to 1,024 characters (finding 1131).
function uncutCappedPath(pointer: string) {
  if (pointer.length <= 512) {
    return pointer;
  }
  let path = "";
  for (const segment of pointer.split("/").slice(1)) {
    if (path.length + segment.length + 1 <= 512) {
      path += `/${segment}`;
      continue;
    }
    if (path === "") {
      path = "/";
      for (const piece of segment.match(/~[01]|[^]/gu) ?? []) {
        if (path.length + piece.length > 512) {
          break;
        }
        path += piece;
      }
    }
    break;
  }
  return path;
}

test("a capped detail path is unchanged by cutting a long first segment", () => {
  const pointers = ["", "/", "/a/b", `/${"a".repeat(511)}`, `/a/${"b".repeat(600)}/c`];
  // First segments just over the cap and past the 1,024-character cut, with escapes and
  // surrogate pairs straddling the 512-character boundary and the cut.
  for (const length of [511, 512, 513, 1023, 1024, 1025, 2048]) {
    for (const [fill, tail] of [
      ["k", "k"],
      ["k", "~0"],
      ["k", "~1"],
      ["k", "\u{1F600}"],
      ["k", "\ud800"],
      ["~0", "k"],
      ["\u{1F600}", "k"],
    ] as const) {
      const prefix = fill.repeat(Math.floor((length - 1) / fill.length));
      for (const key of [`${prefix}${tail}`, `k${prefix}${tail}`]) {
        pointers.push(`/${key}`, `/${key}/next`, `/${key}${"/x".repeat(10)}`);
      }
    }
  }
  for (const pointer of pointers) {
    const path = cappedPath(pointer);
    assert.equal(path, uncutCappedPath(pointer), `${pointer.length}: ${pointer.slice(0, 40)}`);
    assert.ok(path.length <= 512);
  }
});

test("a multi-megabyte first segment is capped in bounded time and heap", () => {
  // Before the cut, the per-character split built six million pieces here (finding 1131).
  const pointer = `/${"k".repeat(6_000_000)}/x`;
  const expected = `/${"k".repeat(511)}`;
  // Reading a character flattens the built string, so its 6 MB is not counted below.
  assert.equal(pointer.at(-1), "x");
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const path = cappedPath(pointer);
  const elapsedMs = performance.now() - started;
  const grewMb = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
  assert.equal(path, expected);
  // About 0.1 MB with the cut, 85 to 120 MB without it.
  assert.ok(grewMb < 16, `heap grew ${grewMb.toFixed(1)} MB`);
  assert.ok(elapsedMs < 1000, `took ${Math.round(elapsedMs)} ms`);
});

test("a contract refusal lists at most the 32 details the error contract allows", () => {
  const failure = contractFailure(
    Array.from({ length: 40 }, (_, index) => ({
      keyword: "required",
      instancePath: "",
      schemaPath: "#/required",
      params: { missingProperty: `field${index}` },
    })),
  );
  assert.ok(failure.details);
  assert.equal(failure.details.length, 32);
  assert.deepEqual(failure.details.at(-1), { path: "/field31", code: "REQUIRED" });
  assert.equal(
    failure.message,
    "The request does not match the operation contract: body /field0 is required; body /field1 is required; body /field2 is required; and 29 more.",
  );
});

test("a contract message shows fewer problems rather than cut a path below 32 characters", () => {
  // Three would cut each path to 26 characters, below the 32 minimum, so the message names two.
  const failure = contractFailure(
    ["0", "1", "2", "3"].map((digit) => ({
      keyword: "type",
      instancePath: `/${digit.repeat(40)}`,
      schemaPath: "#/type",
      params: { type: "string" },
    })),
  );
  assert.equal(
    failure.message,
    `The request does not match the operation contract: body /${"0".repeat(40)} has the wrong type (expected string); body /${"1".repeat(40)} has the wrong type (expected string); and 2 more.`,
  );
  assert.ok(failure.details);
  assert.equal(failure.details.length, 4);
});

test("unstorable text keeps document order, key precedence, and capped pointers", () => {
  const cases: readonly [value: JsonValue, path: string, code: ErrorDetail["code"]][] = [
    [{ first: [{ "a/~": "\ud800" }], later: "\u0000" }, "/first/0/a~1~0", "INVALID_VALUE"],
    [{ "a/\u0000~": "\ud800" }, "/a~1?~0", "INVALID_FORMAT"],
    [{ "a/\ud800~": "\u0000" }, "/a~1?~0", "INVALID_VALUE"],
    [{ ["a".repeat(600)]: "\u0000" }, "/" + "a".repeat(511), "INVALID_FORMAT"],
  ];
  for (const [value, path, code] of cases) {
    const refused = unstorableTextFailure("body", value);
    assert.ok(refused);
    assert.equal(refused.status, 400);
    assert.equal(refused.code, "INVALID_REQUEST");
    assert.deepEqual(refused.details, [{ path, code }]);
    assert.ok(refused.message.length <= 256);
  }
  assert.equal(unstorableTextFailure("body", { valid: "paired \ud83d\ude00" }), undefined);

  // The helper also owns path-parameter text and remains iterative for already-parsed input.
  let nested: JsonValue = "\u0000";
  for (let depth = 0; depth < 10000; depth += 1) {
    nested = [nested];
  }
  const refused = unstorableTextFailure("params", nested);
  assert.ok(refused);
  assert.deepEqual(refused.details, [{ path: "/0".repeat(256), code: "INVALID_FORMAT" }]);
});

// Finding 2534: for every grant a platform operation checks, the caller's own denial names it with
// one prefix, fits the wire cap, names an ID only when the request carried it, and reads the same
// for a Restriction as for a missing grant.
test("a caller denial names each checked grant without disclosing a Restriction or an unsent ID", () => {
  const id = `id_${"a".repeat(125)}`;
  const evidence = (
    identityId: string | undefined,
    restrictionIds: readonly string[] = [],
  ): AuthorizationEvidence => ({
    ...(identityId === undefined ? {} : { identityId }),
    groupIds: [],
    bindingIds: restrictionIds.length > 0 ? ["binding-1"] : [],
    roleIds: restrictionIds.length > 0 ? ["role-1"] : [],
    restrictionIds,
  });
  for (const kind of RESOURCE_KINDS) {
    for (const action of SUPPORTED_PERMISSION_ACTIONS[kind]) {
      const resource: ResourceRef = { kind, id, namespaceId: "ns_1" };
      const label = `${kind}:${action}`;
      const denied = (
        reason: string,
        decided: AuthorizationEvidence | undefined,
        requested: SentId,
        checked = "prn_caller",
      ) =>
        requestFailure(
          new AuthorizationDeniedError(reason, decided, { action, resource }, checked),
          { requested, actorId: "prn_caller" },
        ).message;
      const sent = requestedValues({ params: { namespaceId: "ns_1", resourceId: id } });
      const restricted = denied(
        "A matching Restriction denied the operation.",
        evidence("prn_caller", ["restriction-1"]),
        sent,
      );
      const ungranted = denied(
        "No explicit scoped binding grants the exact action and resource.",
        evidence("prn_caller"),
        sent,
      );
      assert.equal(restricted, ungranted, label);
      assert.match(restricted, /^Not authorized: /, label);
      assert.ok(restricted.length <= 256, label);
      assert.doesNotMatch(
        restricted,
        /restriction-1|binding-1|role-1|prn_caller|matching|binding grants/,
        label,
      );
      // Only Roles from the Installation configuration hold create, and only OCC binds them, so
      // a create denial never asks for a grant (finding 2581).
      if (action === "create" && kind !== "installation") {
        assert.match(
          restricted,
          /Only an Installation administrator can create .+: ask one to create it\.$/,
          label,
        );
        assert.doesNotMatch(restricted, /grant/, label);
      }
      // An exact resource is named only when the request carried its ID; a create names the
      // Namespace it targets, and an Installation names nothing.
      const named = kind !== "installation" && action !== "create";
      assert.equal(restricted.includes(id), named, label);
      // Free text and non-reference fields never count as sending an ID (finding 2585).
      const unsent = denied(
        "",
        undefined,
        requestedValues({ query: { q: id }, body: { name: id, note: "ns_1", tags: [id] } }),
      );
      assert.equal(unsent.includes(id), false, label);
      assert.equal(unsent.includes("ns_1"), false, label);
      // A decision for another principal, such as an Agent's own, names no grant at all, whether
      // or not the IAM Driver reported the identity it checked (finding 2586).
      assert.equal(denied("", evidence("prn_agent"), sent, "prn_agent"), GENERIC_DENIAL, label);
      assert.equal(denied("", evidence(undefined), sent, "prn_agent"), GENERIC_DENIAL, label);
      assert.equal(denied("", evidence("prn_caller"), sent, "prn_agent"), GENERIC_DENIAL, label);
      assert.equal(
        requestFailure(
          new AuthorizationDeniedError("", evidence("prn_caller"), { action, resource }),
          {
            requested: sent,
            actorId: "prn_caller",
          },
        ).message,
        GENERIC_DENIAL,
        label,
      );
    }
  }
  // An ID outside the plain shape is never echoed, even when the request carried it.
  const odd = "agt_1\u001b[2J";
  assert.equal(
    requestFailure(
      new AuthorizationDeniedError(
        "",
        undefined,
        { action: "read", resource: { kind: "agent", id: odd, namespaceId: "ns_1" } },
        "prn_caller",
      ),
      { requested: requestedValues({ params: { agentId: odd } }), actorId: "prn_caller" },
    ).message,
    callerDenied("Agent read", "an Agent this request uses"),
  );
});

// Finding 2592: the resource an Agent's own principal lacks comes from the Agent's stored bindings.
// The text names it only when the request carried its ID or the caller may read it, names the
// Agent only when the request carried its ID, and never names the principal.
test("an Agent principal denial names a bound resource only when the caller sent or may read it", () => {
  const agentId = "agt_1";
  const secret: ResourceRef = { kind: "secret", id: "sec_1", namespaceId: "ns_1" };
  const deploy = requestedValues({ params: { namespaceId: "ns_1", agentId } });
  const answer = (resource: ResourceRef, callerMayReadResource: boolean, requested = deploy) =>
    requestFailure(
      new AgentPrincipalAuthorizationError("prn_agent", "operate", resource, undefined, {
        agentId,
        callerMayReadResource,
      }),
      { requested, actorId: "prn_caller" },
    );
  const hidden = answer(secret, false);
  assert.equal(hidden.status, 403);
  assert.equal(hidden.code, "FORBIDDEN");
  assert.equal(
    hidden.message,
    agentPrincipalDenied(`Agent ${agentId}`, "one of its bound Secrets"),
  );
  assert.doesNotMatch(hidden.message, /sec_1|prn_agent/);
  assert.equal(
    answer(secret, true).message,
    agentPrincipalDenied(`Agent ${agentId}`, "Secret sec_1"),
  );
  // An ID the request itself sent is named even without read, as in the caller's own denials.
  assert.equal(
    answer(secret, false, requestedValues({ params: { agentId }, body: { secretId: "sec_1" } }))
      .message,
    agentPrincipalDenied(`Agent ${agentId}`, "Secret sec_1"),
  );
  // A request that did not carry the Agent's ID, such as a provisioning retry, names no Agent.
  assert.equal(
    answer(secret, true, requestedValues({ params: { workId: "work_1" } })).message,
    agentPrincipalDenied("This Agent", "Secret sec_1"),
  );
  const source: ResourceRef = { kind: "credential_source", id: "crs_1", namespaceId: "ns_1" };
  assert.equal(
    answer(source, false).message,
    agentPrincipalDenied(
      `Agent ${agentId}`,
      "one of its bound CredentialSources",
      "CredentialSource operate",
    ),
  );
  // An ID outside the plain shape is never echoed, even when the caller may read it.
  assert.equal(
    answer({ ...secret, id: "sec_1\u001b[2J" }, true).message,
    agentPrincipalDenied(`Agent ${agentId}`, "one of its bound Secrets"),
  );
});

// Finding 2585: a request names an ID through a path parameter or a reference field (`id`, or a
// name ending in `Id` or `Ids`) at any depth of its query or body, never through free text.
test("only path parameters and reference fields count as IDs a request sent", () => {
  const sent = requestedValues({
    params: { namespaceId: "ns_path", agentId: "agt_path" },
    query: { q: "agt_search", cursor: "agt_cursor", revisionId: "rev_query" },
    body: {
      configurationId: "cfg_body",
      name: "cfg_name",
      secretBindings: [{ name: "TOKEN", secretId: "sec_nested" }],
      secretIds: ["sec_list"],
      ref: { kind: "secret", id: "sec_ref" },
      description: "sec_free",
    },
  });
  for (const id of [
    "ns_path",
    "agt_path",
    "rev_query",
    "cfg_body",
    "sec_nested",
    "sec_list",
    "sec_ref",
  ]) {
    assert.equal(sent(id), true, id);
  }
  for (const id of ["agt_search", "agt_cursor", "cfg_name", "TOKEN", "secret", "sec_free"]) {
    assert.equal(sent(id), false, id);
  }
  assert.equal(requestedValues({})("anything"), false);
  // A path Agent ID also carries that Agent's SandboxPolicy ID, which is derived from it; a body
  // or query Agent ID does not (finding 2594).
  const agentUuid = "00000000-0000-4000-8000-000000000001";
  assert.equal(
    requestedValues({ params: { agentId: `agt_${agentUuid}` } })(`sbp_${agentUuid}`),
    true,
  );
  assert.equal(
    requestedValues({ body: { agentId: `agt_${agentUuid}` } })(`sbp_${agentUuid}`),
    false,
  );
  assert.equal(
    requestedValues({ params: { configurationId: `cfg_${agentUuid}` } })(`sbp_${agentUuid}`),
    false,
  );
});

test("denial ID discovery charges primitive and reference-list entries to its budget", () => {
  // Plain JSON primitives must spend the walk budget just as nested records do. A late
  // reference must stay unnamed even when it is the resource an authorization denial checked.
  const bodies: readonly JsonObject[] = [
    { padding: Array<number>(4097).fill(0), configurationId: "cfg_late" },
    {
      ...Object.fromEntries(
        Array.from({ length: 4097 }, (_, index) => [String(index), 0] as const),
      ),
      configurationId: "cfg_late",
    },
    {
      ...Object.fromEntries(
        Array.from(
          { length: 17 },
          (_, index) => [`group${index}Ids`, Array<string>(256).fill("sec_list")] as const,
        ),
      ),
      configurationId: "cfg_late",
    },
  ];
  for (const body of bodies) {
    const parsed: unknown = JSON.parse(JSON.stringify(body));
    const sent = requestedValues({
      params: { namespaceId: "ns_path", agentId: "agt_path" },
      query: { configurationId: "cfg_early", q: "cfg_free" },
      body: parsed,
    });
    for (const id of ["ns_path", "agt_path", "sbp_path", "cfg_early"]) {
      assert.equal(sent(id), true, id);
    }
    assert.equal(sent("cfg_free"), false, "free text is not a reference");
    assert.equal(
      sent("cfg_late"),
      false,
      "a reference after the entry budget must not be nameable",
    );
    const denied = requestFailure(
      new AuthorizationDeniedError(
        "",
        undefined,
        {
          action: "read",
          resource: { kind: "configuration", id: "cfg_late", namespaceId: "ns_path" },
        },
        "prn_caller",
      ),
      { requested: sent, actorId: "prn_caller" },
    );
    assert.equal(
      denied.message,
      callerDenied("Configuration read", "a Configuration this request uses"),
    );
  }

  // The list's ordinary first 256 string references still count; later direct strings do not.
  const listed = requestedValues({
    body: { secretIds: [...Array<string>(256).fill("sec_list"), "sec_after_list_cap"] },
  });
  assert.equal(listed("sec_list"), true);
  assert.equal(listed("sec_after_list_cap"), false);
});
