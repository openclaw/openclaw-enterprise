import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  NamespaceSchema,
  NamespaceListResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { BODY_NOT_JSON, RESOURCE_NOT_FOUND } from "../helpers/refusal-text.mjs";
import {
  tenantANamespaceId,
  tenantRequest as request,
  type TenantRequestOptions,
} from "../helpers/tenant-reader-app.ts";
import {
  bootstrap,
  createAgent,
  createFixture,
  createNamespace,
  responseData,
  responseError,
} from "./occ-api-security-fixture.ts";

export function registerBodyValidationCases() {
  test("malformed, non-JSON, invalid, and oversized inputs fail without mutations", async () => {
    const fixture = await createFixture({ maxBodyBytes: 256 });
    await bootstrap(fixture);
    const controller = fixture.controller;
    assert.ok(controller);
    const before = controller.pendingOperations().length;

    const cases: ReadonlyArray<TenantRequestOptions & { expectedStatus: number; body: unknown }> = [
      {
        expectedStatus: 415,
        headers: { "content-type": "text/plain" },
        body: '{"name":"wrong media type"}',
      },
      { expectedStatus: 400, body: '{"name":' },
      { expectedStatus: 400, body: null },
      { expectedStatus: 400, body: [] },
      { expectedStatus: 400, body: {} },
      { expectedStatus: 400, body: { name: "   " } },
      { expectedStatus: 413, body: { name: "x".repeat(1024) } },
    ];

    for (const { expectedStatus, ...options } of cases) {
      const result = await request(fixture.app, "/namespaces", options);
      assert.equal(result.response.status, expectedStatus, JSON.stringify(options.body));
      assert.equal(controller.pendingOperations().length, before);
    }

    // Text that is not JSON says so (finding D762). JSON the prototype-poisoning guard refuses is
    // valid JSON, so it keeps the contract message.
    const notJson = await request(fixture.app, "/namespaces", { body: '{"name":"a\nb"}' });
    assert.equal(notJson.response.status, 400);
    assert.deepEqual(responseError(notJson.payload), {
      code: "INVALID_REQUEST",
      message: BODY_NOT_JSON,
    });
    const poisoned = await request(fixture.app, "/namespaces", {
      body: '{"__proto__":{"x":1},"name":"p"}',
    });
    assert.equal(poisoned.response.status, 400);
    assert.equal(
      responseError(poisoned.payload).message,
      "The request does not match the operation contract.",
    );

    // Route-specific Preset defaults must still obey an explicitly smaller application limit.
    for (const method of ["POST", "PATCH"]) {
      const suffix = method === "PATCH" ? "/pre_00000000-0000-4000-8000-000000000001" : "";
      const result = await request(
        fixture.app,
        `/namespaces/${tenantANamespaceId}/presets${suffix}`,
        {
          method,
          body: {
            name: "Bounded",
            template: {
              variables: { guidance: { type: "string", default: "Routine guidance. ".repeat(40) } },
            },
          },
        },
      );
      assert.equal(result.response.status, 413);
      assert.equal(controller.pendingOperations().length, before);
    }

    // So must the Configuration write defaults.
    for (const method of ["POST", "PATCH"]) {
      const suffix = method === "PATCH" ? "/cfg_00000000-0000-4000-8000-000000000001" : "";
      const result = await request(
        fixture.app,
        `/namespaces/${tenantANamespaceId}/configurations${suffix}`,
        {
          method,
          body: {
            ...(method === "POST" ? { kind: "agent" } : {}),
            values: { notes: "Routine notes. ".repeat(40) },
          },
        },
      );
      assert.equal(result.response.status, 413, method);
      assert.equal(controller.pendingOperations().length, before);
    }

    assert.equal(
      fixture.auditSink.events.filter(
        (event) => event.kind === "mutation" && event.resource.kind === "namespace",
      ).length,
      0,
    );
  });

  test("NUL characters and unpaired surrogates are refused in bodies and path parameters", async () => {
    // PostgreSQL text and jsonb cannot store either one: they answered 500 or 503 there, while
    // the in-memory State accepted them. A lone surrogate in a name was stored as U+FFFD.
    const fixture = await createFixture();
    await bootstrap(fixture);
    const namespace = await createNamespace(fixture, "Unstorable text tenant");
    const configurations = `/namespaces/${namespace.id}/configurations`;
    const nul = ["a NUL character", "INVALID_FORMAT"] as const;
    const surrogate = ["an unpaired UTF-16 surrogate", "INVALID_VALUE"] as const;
    // A detail path too long for 512 characters keeps whole leading segments.
    const longKey = "k".repeat(300);
    const cases: ReadonlyArray<
      readonly [
        pathname: string,
        body: string,
        path: string,
        problem: typeof nul | typeof surrogate,
      ]
    > = [
      ["/namespaces", '{"name":"lone \\ud800 surrogate"}', "/name", surrogate],
      ["/namespaces", '{"name":"trailing \\udc00"}', "/name", surrogate],
      [configurations, '{"kind":"agent","values":{"x":"a\\u0000b"}}', "/values/x", nul],
      [configurations, '{"kind":"agent","values":{"a\\u0000~/":"x"}}', "/values/a?~0~1", nul],
      [configurations, '{"kind":"agent","values":{"\\udbff":"x"}}', "/values/?", surrogate],
      // The first offender in document order is named.
      [
        configurations,
        '{"kind":"agent","values":{"first":["ok","\\ud800"],"second":"\\u0000"}}',
        "/values/first/1",
        surrogate,
      ],
      // Keys and values share document order.
      [configurations, '{"kind":"agent","values":{"a":"\\u0000","b\\ud800":1}}', "/values/a", nul],
      // A first segment too long for the 512-character detail path is cut, not dropped.
      [configurations, `{"${"k".repeat(600)}\\u0000":1}`, `/${"k".repeat(511)}`, nul],
      [
        configurations,
        `{"kind":"agent","values":{"x":{"${longKey}":{"${"m".repeat(300)}":"\\u0000"}}}}`,
        `/values/x/${longKey}`,
        nul,
      ],
    ];
    for (const [pathname, body, path, [problem, code]] of cases) {
      const result = await request(fixture.app, pathname, { body });
      assert.equal(result.response.status, 400, body.slice(0, 80));
      assert.equal(responseError(result.payload).code, "INVALID_REQUEST");
      assert.deepEqual(responseError(result.payload).details, [{ path, code }]);
      const before = "The request does not match the operation contract: body ";
      const after = ` contains ${problem}.`;
      // A path too long for the 256-character message cap is cut, never the problem wording.
      const room = 256 - before.length - after.length;
      const shown = path.length <= room ? path : `${path.slice(0, room - 1)}…`;
      assert.equal(responseError(result.payload).message, `${before}${shown}${after}`);
    }
    // A body nested past the depth bound is refused before its text is checked.
    const deep = 30_000;
    const tooDeep = await request(fixture.app, configurations, {
      body: `{"kind":"agent","values":{"x":${"[".repeat(deep)}"\\u0000"${"]".repeat(deep)}}}`,
    });
    assert.equal(tooDeep.response.status, 400);
    assert.deepEqual(responseError(tooDeep.payload).details, [
      { path: `/values/x${"/0".repeat(23)}`, code: "TOO_DEEP" },
    ]);
    // A surrogate pair is one well-formed character.
    const paired = await request(fixture.app, "/namespaces", {
      body: { name: "Paired \u{1F600}" },
    });
    assert.equal(paired.response.status, 201);

    const role = await request(fixture.app, `/namespaces/${namespace.id}/iam/roles/role%00x`);
    assert.equal(role.response.status, 400);
    assert.deepEqual(responseError(role.payload).details, [
      { path: "/roleId", code: "INVALID_FORMAT" },
    ]);
    assert.equal(
      responseError(role.payload).message,
      "The request does not match the operation contract: params /roleId contains a NUL character.",
    );

    const namespaces = await request(fixture.app, "/namespaces");
    assert.deepEqual(
      responseData(NamespaceListResponse.properties.data, namespaces.payload).map(
        ({ name }) => name,
      ),
      ["default", "Unstorable text tenant", "Paired \u{1F600}"],
    );
    assert.equal(
      fixture.auditSink.events.filter(
        (event) => event.kind === "mutation" && event.resource.kind === "configuration",
      ).length,
      0,
    );
  });
}

export function registerPathValidationCases() {
  test("router failures answer the error envelope without echoing the path", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    const namespace = await createNamespace(fixture, "Router failure tenant");
    const roles = `/namespaces/${namespace.id}/iam/roles`;
    const contract = "The request does not match the operation contract";
    for (const [pathname, status, code, message] of [
      // Fastify answered these itself: its own body naming FST_ERR_* and the submitted path,
      // no meta.requestId, x-request-id, cache-control or nosniff, and 414 for a long parameter.
      [
        "/namespaces/%ZZ",
        400,
        "INVALID_REQUEST",
        "The request path has a malformed percent-encoding.",
      ],
      [
        `${roles}/role%ED%A0%80x`,
        400,
        "INVALID_REQUEST",
        "The request path has a malformed percent-encoding.",
      ],
      [
        `${roles}/${"r".repeat(401)}`,
        400,
        "INVALID_REQUEST",
        `${contract}: a path parameter is too long.`,
      ],
      // Role IDs may hold 200 characters, so a long one reaches the route.
      [`${roles}/${"r".repeat(200)}`, 404, "NOT_FOUND", RESOURCE_NOT_FOUND],
      [`${roles}/${"%F0%9F%98%80".repeat(200)}`, 404, "NOT_FOUND", RESOURCE_NOT_FOUND],
    ] as const) {
      const { response, payload } = await request(fixture.app, pathname);
      assert.equal(response.status, status, pathname.slice(0, 80));
      assert.deepEqual(responseError(payload), { code, message });
      assert.deepEqual(Object.keys(payload).sort(), ["error", "meta"]);
      assert.doesNotMatch(JSON.stringify(payload), /FST_ERR|%ZZ|%ED|rrrr/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    }
  });

  test("names are measured in characters, not UTF-16 code units", async () => {
    // 200 emoji fit the 200-character contract (and PostgreSQL char_length), but each is two
    // UTF-16 code units; the controller answered 404 NOT_FOUND for such a Namespace or Agent.
    const fixture = await createFixture();
    await bootstrap(fixture);
    const name = "\u{1F600}".repeat(200);
    const namespace = await createNamespace(fixture, name);
    assert.equal(namespace.name, name);
    const agent = await createAgent(fixture, namespace, name);
    assert.equal(agent.name, name);

    const tooLong = await request(fixture.app, "/namespaces", { body: { name: `${name}x` } });
    assert.equal(tooLong.response.status, 400);
    assert.deepEqual(responseError(tooLong.payload).details, [{ path: "/name", code: "TOO_LONG" }]);
  });
}

export function registerDiagnosticLimitCase() {
  test("contract error details stay within the published path cap and name what a field accepts", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    const namespace = await createNamespace(fixture, "Contract detail tenant");
    const configurations = `/namespaces/${namespace.id}/configurations`;
    const configuration = { kind: "agent", values: {} };
    const source = { kind: "secret", namespaceId: namespace.id, id: `sec_${randomUUID()}` };
    const longBinding = "K".repeat(600);
    let deepValues: Record<string, unknown> = {};
    for (let depth = 0; depth < 26; depth += 1) {
      deepValues = { ["d".repeat(40)]: deepValues };
    }
    const contract = "The request does not match the operation contract: body";
    const cases: ReadonlyArray<readonly [body: unknown, path: string, code: string]> = [
      // A submitted field name too long for the 512-character detail path is cut, as the NUL
      // check cuts it.
      [{ ...configuration, ["k".repeat(700)]: 1 }, `/${"k".repeat(511)}`, "UNKNOWN_FIELD"],
      // The cut keeps whole escapes: no dangling "~".
      [{ ...configuration, ["~".repeat(300)]: 1 }, `/${"~0".repeat(255)}`, "UNKNOWN_FIELD"],
      // Keys that the Configuration check refuses are named by a capped path too.
      [{ kind: "agent", values: { [longBinding]: { prototype: 1 } } }, "/values", "INVALID_VALUE"],
      // Under a long map key the instance path itself is too long: whole leading segments stay.
      [
        { ...configuration, secretBindings: { [longBinding]: { source, extra: 1 } } },
        "/secretBindings",
        "UNKNOWN_FIELD",
      ],
      [
        { ...configuration, secretBindings: { [longBinding]: { source: "x" } } },
        "/secretBindings",
        "INVALID_TYPE",
      ],
      // Leading segments that end exactly at 512 characters all stay.
      [
        { ...configuration, secretBindings: { ["K".repeat(496)]: { source, extra: 1 } } },
        `/secretBindings/${"K".repeat(496)}`,
        "UNKNOWN_FIELD",
      ],
      // The Configuration check's depth limit names a capped path under long keys.
      [
        { kind: "agent", values: deepValues },
        `/values${`/${"d".repeat(40)}`.repeat(12)}`,
        "TOO_DEEP",
      ],
    ];
    for (const [body, path, code] of cases) {
      const result = await request(fixture.app, configurations, { body });
      assert.equal(result.response.status, 400, JSON.stringify(result.payload).slice(0, 200));
      assert.deepEqual(responseError(result.payload).details, [{ path, code }]);
    }

    // A cut path names an ancestor of the offending field, which itself is accepted, so the
    // message says the problem is inside it. Uncut paths keep naming the field itself.
    const agents = `/namespaces/${namespace.id}/agents`;
    const agent = { name: "Contract detail agent", configurationId: `cfg_${randomUUID()}` };
    const messages: ReadonlyArray<readonly [route: string, body: unknown, message: string]> = [
      [
        configurations,
        { ...configuration, secretBindings: { [longBinding]: { source, extra: 1 } } },
        "/secretBindings contains a field that is not accepted.",
      ],
      [
        configurations,
        { ...configuration, secretBindings: { [longBinding]: { source: "x" } } },
        "/secretBindings contains a field that has the wrong type (expected object).",
      ],
      [
        configurations,
        { ...configuration, secretBindings: { [longBinding]: {} } },
        "/secretBindings or an object under it is missing a required field.",
      ],
      [
        configurations,
        { ...configuration, secretBindings: { [longBinding]: { source: { ...source, id: "x" } } } },
        "/secretBindings contains a field that has an invalid format.",
      ],
      [
        configurations,
        {
          ...configuration,
          secretBindings: { [longBinding]: { source: { ...source, kind: "x" } } },
        },
        '/secretBindings contains a field that has an unsupported value (expected "secret").',
      ],
      [
        agents,
        { ...agent, harnessAuth: { method: "api_key", source, [longBinding]: 1 } },
        "/harnessAuth contains a field that is not accepted.",
      ],
      [
        configurations,
        { ...configuration, secretBindings: { short: { source, extra: 1 } } },
        "/secretBindings/short/extra is not an accepted field.",
      ],
      [
        agents,
        { ...agent, harnessAuth: { method: "api_key", source, extra: 1 } },
        "/harnessAuth/extra is not an accepted field.",
      ],
    ];
    for (const [route, body, message] of messages) {
      const result = await request(fixture.app, route, { body });
      assert.equal(result.response.status, 400, JSON.stringify(result.payload).slice(0, 200));
      assert.equal(responseError(result.payload).message, `${contract} ${message}`);
    }

    // A path too long for the 256-character message cap is cut, never the problem wording,
    // whether the detail path kept the long key or dropped it.
    for (const [length, wording] of [
      [300, " has an invalid format."],
      // The detail path keeps /secretBindings/<key> and drops the field under it.
      [494, " contains a field that has an invalid format."],
    ] as const) {
      const key = "K".repeat(length);
      const result = await request(fixture.app, configurations, {
        body: { ...configuration, secretBindings: { [key]: { source: { ...source, id: "x" } } } },
      });
      assert.equal(result.response.status, 400);
      const { message } = responseError(result.payload);
      assert.equal(Array.from(message).length, 256, message);
      assert.ok(message.startsWith(`${contract} /secretBindings/KKK`), message);
      assert.ok(message.endsWith(`…${wording}`), message);
    }
    // With several problems the long path is cut, and the short ones and every wording stay.
    const several = await request(fixture.app, agents, {
      body: { ...agent, harnessAuth: { method: "x", ["Q".repeat(150)]: 1 } },
    });
    assert.equal(several.response.status, 400);
    const severalMessage = responseError(several.payload).message;
    assert.equal(Array.from(severalMessage).length, 256, severalMessage);
    assert.ok(severalMessage.startsWith(`${contract} /harnessAuth/QQQ`), severalMessage);
    assert.ok(
      severalMessage.endsWith(
        "… is not an accepted field; body /harnessAuth/source is required;" +
          " body /harnessAuth/sourceId is required; and 2 more.",
      ),
      severalMessage,
    );
    // Paths that exactly fill the cap stay whole.
    const exact = await request(fixture.app, agents, {
      body: { ...agent, harnessAuth: { method: "x", ["Q".repeat(71)]: 1 } },
    });
    assert.equal(
      responseError(exact.payload).message,
      `${contract} /harnessAuth/${"Q".repeat(71)} is not an accepted field;` +
        " body /harnessAuth/source is required; body /harnessAuth/sourceId is required;" +
        " and 2 more.",
    );
    assert.equal(Array.from(responseError(exact.payload).message).length, 256);
    // The cap counts characters, not UTF-16 code units: an astral key that fits stays whole,
    // and a cut keeps whole characters.
    const room = 256 - `${contract} / is not an accepted field.`.length;
    for (const [count, shown] of [
      [150, "\u{1F600}".repeat(150)],
      [200, `${"\u{1F600}".repeat(room - 1)}…`],
    ] as const) {
      const astral = await request(fixture.app, agents, {
        body: { ...agent, ["\u{1F600}".repeat(count)]: 1 },
      });
      assert.equal(astral.response.status, 400);
      assert.equal(
        responseError(astral.payload).message,
        `${contract} /${shown} is not an accepted field.`,
      );
    }

    // A union whose shapes all accept one type names that type, not "one of" a single entry.
    const wholeBody = await request(
      fixture.app,
      `/namespaces/${namespace.id}/channel-directory/lookup`,
      { body: '"x"' },
    );
    assert.equal(wholeBody.response.status, 400);
    assert.deepEqual(responseError(wholeBody.payload).details, [
      { path: "", code: "INVALID_TYPE" },
    ]);
    assert.equal(
      responseError(wholeBody.payload).message,
      `${contract} / has the wrong type (expected object).`,
    );
    // The method selects the api_key shape, so a problem inside it names what its field accepts.
    const wrongSource = await request(fixture.app, `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "Contract detail agent",
        configurationId: `cfg_${randomUUID()}`,
        harnessAuth: { method: "api_key", source: "x" },
      },
    });
    assert.equal(wrongSource.response.status, 400);
    assert.deepEqual(responseError(wrongSource.payload).details, [
      { path: "/harnessAuth/source", code: "INVALID_TYPE" },
    ]);
    assert.equal(
      responseError(wrongSource.payload).message,
      `${contract} /harnessAuth/source has the wrong type (expected object).`,
    );

    // An operation without query parameters or a request body says which one it refused.
    const query = await request(fixture.app, `/namespaces/${namespace.id}/agents?limit=5`);
    assert.equal(query.response.status, 400);
    assert.equal(
      responseError(query.payload).message,
      "The request does not match the operation contract: this operation accepts no query parameters.",
    );
    const emptyBody = await request(fixture.app, `/namespaces/${namespace.id}`, {
      method: "DELETE",
      body: {},
    });
    assert.equal(emptyBody.response.status, 400);
    assert.equal(
      responseError(emptyBody.payload).message,
      "The request does not match the operation contract: this operation accepts no request body.",
    );
    // A chunked body declares no length and a GET body is never parsed; the framing still counts.
    const chunked = await request(fixture.app, `/namespaces/${namespace.id}`, {
      headers: { "transfer-encoding": "chunked" },
    });
    assert.equal(chunked.response.status, 400);
    assert.equal(
      responseError(chunked.payload).message,
      "The request does not match the operation contract: this operation accepts no request body.",
    );
    const kept = await request(fixture.app, `/namespaces/${namespace.id}`);
    assert.equal(kept.response.status, 200);
    assert.equal(responseData(NamespaceSchema, kept.payload).id, namespace.id);
  });
}
