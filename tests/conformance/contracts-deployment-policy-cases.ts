import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialProxyRoutingDetails,
  validateDeploymentPolicy,
  type DeploymentPolicy,
  type DeploymentPolicyValidationContext,
  type DeploymentRequestMatch,
  type DeploymentRequestPolicy,
} from "../../packages/contracts/src/index.ts";

function calendarAccount(connection: string, environment: string) {
  return {
    bindingRef: connection,
    sourceRef: { kind: "credential_source", id: "cs_" + connection, namespaceId: "ns_example" },
    driverId: "occ",
    registration: { delivery: "push" },
    consumer: { kind: "plugin", pluginId: "calendar", requirement: "account", connection },
    projection: { environment, presentation: "bearer" },
  } as const;
}

function credentialPolicyFixture<Policy extends DeploymentRequestPolicy>(
  requestPolicy: Policy,
  port = 443,
) {
  const destination = {
    binary: "/usr/bin/node",
    host: "api.example.org",
    ports: [{ from: port, to: port }],
  };
  const request = { ...destination, requestPolicy };
  const binding = calendarAccount("work", "WORK_TOKEN");
  const authority = {
    destinations: [{ host: destination.host, port, path: requestPolicy.path, method: null }],
    allowedRequests: [request],
    projection: { environment: "WORK_TOKEN", presentation: "bearer" } as const,
  };
  const policy = {
    networkAccessPolicy: { allowed: [request] },
    bindings: [binding],
    injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests: [request] }],
  } satisfies DeploymentPolicy;
  const context = {
    targetMayHoldPlaceholders: false,
    ceiling: [{ id: "api", ...destination }],
    sandbox: { wildcards: false, portRanges: false, supportsNetworkPolicy: () => true },
    authorityForBinding: ({ sourceRef, consumer }) =>
      sourceRef.id === "cs_work" && consumer.kind === "plugin" && consumer.connection === "work"
        ? authority
        : undefined,
    proxy: {
      distinguishesExecutable: false,
      distinguishesPort: false,
      rejectsStaleAndMisplacedPlaceholders: true,
      supportsBindingRequest: (binding) => binding.projection.presentation === "bearer",
    },
  } satisfies DeploymentPolicyValidationContext;
  return { policy, context, request, binding, authority };
}

function policyRefusals(policy: DeploymentPolicy, context: DeploymentPolicyValidationContext) {
  return validateDeploymentPolicy(policy, context).map(({ path, code }) => [path, code]);
}

export function registerDeploymentPolicyCases(): void {
  test("credential injection needs independent network permission for the exact HTTP request or MCP tool", () => {
    const http = { type: "http", method: "GET", path: "/events" } as const;
    const mcp = {
      type: "mcp",
      method: "tools/call",
      path: "/mcp",
      toolName: "events_read",
    } as const;
    for (const [allowed, other] of [
      [http, { ...http, path: "/admin" }],
      [http, { ...http, method: "DELETE" }],
      [mcp, { ...mcp, toolName: "events_write" }],
    ] as const) {
      // Source and reviewed consumer policy permit the injected request. Only the network differs.
      const { policy, context, request } = credentialPolicyFixture(other);
      assert.deepEqual(policyRefusals(policy, context), []);
      assert.deepEqual(
        policyRefusals(
          {
            ...policy,
            networkAccessPolicy: { allowed: [{ ...request, requestPolicy: allowed }] },
          },
          context,
        ),
        [["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"]],
      );
    }
  });

  test("a proxy qualifies the proposed deployment policy without admission authority", () => {
    const { policy, context, binding, request } = credentialPolicyFixture({
      type: "http",
      method: "GET",
      path: "/events",
    });
    const expected = [binding, request, { ...policy }];
    let observed: unknown;
    const proxy: NonNullable<DeploymentPolicyValidationContext["proxy"]> = {
      ...context.proxy,
      supportsBindingRequest(...args) {
        observed = args;
        return true;
      },
    };
    assert.deepEqual(policyRefusals(policy, { ...context, proxy }), []);
    assert.deepEqual(observed, expected);
  });

  test("a source subtree includes its base and descendants while same-host discovery stays credentialless", () => {
    const {
      policy: calendar,
      context,
      request,
      binding,
      authority,
    } = credentialPolicyFixture({
      type: "http",
      method: "GET",
      path: "/calendar/**",
    });
    const atPath = (path: string) => ({
      ...request,
      requestPolicy: { ...request.requestPolicy, path },
    });
    // The consumer can use either endpoint, but this particular account is scoped to Calendar.
    const reviewed = { ...authority, allowedRequests: [atPath("/**")] };
    const policy = {
      ...calendar,
      networkAccessPolicy: {
        allowed: [
          request,
          atPath("/$discovery/rest"),
          atPath("/admin"),
          atPath("/calendar-archive"),
        ],
      },
    };
    function inject(path: string) {
      return policyRefusals(
        {
          ...policy,
          injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests: [atPath(path)] }],
        },
        { ...context, authorityForBinding: () => reviewed },
      );
    }
    for (const path of ["/calendar/**", "/calendar", "/calendar/events", "/calendar/events/**"]) {
      assert.deepEqual(inject(path), [], path);
    }
    for (const path of ["/$discovery/rest", "/admin", "/calendar-archive"]) {
      assert.deepEqual(
        inject(path),
        [["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"]],
        path,
      );
    }
  });

  test("each injection destination needs a source endpoint covering its host, port, path and method together", () => {
    const { policy, context, binding, request, authority } = credentialPolicyFixture({
      type: "http",
      method: "GET",
      path: "/calendar/**",
    });
    const { binary, host, ports } = request;
    const httpOnly = { binary, host: "http-only.example.org", ports };
    // Each proposed route is allowed by the consumer and the Sandbox. Only the source is narrower.
    for (const rule of [
      { binary, host, ports },
      { ...request, ports: [{ from: 443, to: 444 }] },
      { ...request, host: "other.example.org" },
      httpOnly,
      { ...httpOnly, requestPolicy: { type: "mcp", path: "/mcp", method: "tools/list" } },
    ] satisfies DeploymentRequestMatch[]) {
      const allowedRequests = [rule];
      const result = policyRefusals(
        {
          ...policy,
          networkAccessPolicy: { allowed: allowedRequests },
          injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests }],
        },
        {
          ...context,
          authorityForBinding: () => ({
            ...authority,
            destinations: [
              ...authority.destinations,
              { host: "other.example.org", port: 444, path: "/calendar/**", method: null },
              // Neither a transport allowance nor an MCP selector guarantees the HTTP verb.
              { host: httpOnly.host, port: 443, path: "/**", method: "POST" },
            ],
            allowedRequests,
          }),
          ceiling: [{ id: "route", binary, host: rule.host, ports: rule.ports }],
          sandbox: { ...context.sandbox, portRanges: true },
        },
      );
      assert.deepEqual(result, [["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"]]);
    }
  });

  test("staged MCP admission compares canonical UTF-8 recipient paths exactly", () => {
    const operation = { type: "mcp", method: "tools/list" } as const;
    for (const path of ["/caf%C3%A9/mcp", "/team%20space/mcp"]) {
      const { policy, context } = credentialPolicyFixture({ ...operation, path });
      assert.deepEqual(policyRefusals(policy, context), [], path);
    }

    // The supplied source destination uses the composed spelling. The decomposed path is distinct.
    const { policy, context, authority } = credentialPolicyFixture({
      ...operation,
      path: "/cafe%CC%81/mcp",
    });
    assert.deepEqual(
      policyRefusals(policy, {
        ...context,
        authorityForBinding: () => ({
          ...authority,
          destinations: authority.destinations.map((endpoint) => ({
            ...endpoint,
            path: "/caf%C3%A9/mcp",
          })),
        }),
      }),
      [["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"]],
    );

    // All three policies agree. Invalid UTF-8, ambiguous path segments and alternate encodings still fail.
    for (const path of [
      "/caf%C3/mcp",
      "/caf%c3%a9/mcp",
      "/team%2Fspace/mcp",
      "/team%2520space/mcp",
      "/%2E%2E/mcp",
      "/%EF%BC%8E%EF%BC%8E/mcp", // Two fullwidth dots normalize to a parent segment.
    ]) {
      const invalid = credentialPolicyFixture({ ...operation, path });
      assert.deepEqual(
        policyRefusals(invalid.policy, invalid.context),
        [["/bindings/0", "INVALID_VALUE"]],
        path,
      );
    }
  });

  test("a reviewed MCP connection limits the executable, method and tool despite network permission", () => {
    const {
      policy: calendar,
      context,
      request,
      binding,
    } = credentialPolicyFixture({
      type: "mcp",
      method: "tools/call",
      path: "/mcp",
      toolName: "events_read",
    });
    const { binary, host, ports } = request;
    const otherBinary = "/usr/bin/curl";
    const policy = {
      ...calendar,
      networkAccessPolicy: {
        allowed: [
          { binary, host, ports },
          { binary: otherBinary, host, ports },
        ],
      },
    };
    const enforced = {
      ...context,
      ceiling: [...context.ceiling, { id: "client", binary: otherBinary, host, ports }],
      proxy: { ...context.proxy, distinguishesExecutable: true },
    };
    assert.deepEqual(policyRefusals(policy, enforced), []);
    for (const extra of [
      { ...request, binary: otherBinary },
      { ...request, requestPolicy: { type: "mcp", path: "/mcp", method: "tools/list" } },
      { ...request, requestPolicy: { ...request.requestPolicy, toolName: "events_write" } },
    ] satisfies DeploymentRequestMatch[]) {
      assert.deepEqual(
        policyRefusals(
          {
            ...policy,
            injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests: [extra] }],
          },
          enforced,
        ),
        [["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"]],
      );
    }
  });

  test("the Sandbox must qualify the exact union of overlapping HTTP grants", () => {
    const {
      policy: calendar,
      context,
      request,
      binding,
    } = credentialPolicyFixture({ type: "http", method: "GET", path: "/calendar/**" }, 8443);
    const { binary, host, ports } = request;
    const https = [{ from: 443, to: 443 }];
    const bothPorts = [...https, ...ports];
    const events = {
      ...request,
      requestPolicy: { ...request.requestPolicy, path: "/calendar/events" },
    };
    const network = {
      allowed: [
        { ...request, ports: https },
        { ...events, ports: bothPorts },
      ],
    };
    const policy = {
      networkAccessPolicy: network,
      bindings: [],
      injectionPolicies: [],
    };
    const bothPortsContext = {
      ...context,
      ceiling: [{ id: "api", binary, host, ports: bothPorts }],
    };
    assert.deepEqual(policyRefusals(policy, bothPortsContext), []);
    assert.deepEqual(
      policyRefusals(policy, {
        ...bothPortsContext,
        sandbox: { ...context.sandbox, supportsNetworkPolicy: () => false },
      }),
      [["/networkAccessPolicy/allowed", "INVALID_VALUE"]],
    );
    // An unrestricted rule at the same endpoint could also allow every unselected operation.
    assert.deepEqual(
      policyRefusals(
        {
          ...policy,
          networkAccessPolicy: { allowed: [request, { binary, host, ports }] },
        },
        bothPortsContext,
      ),
      [["/networkAccessPolicy/allowed/1", "INVALID_VALUE"]],
    );
    // The source and consumer permit the subtree on 8443. Only its events path has network access there.
    const bound = { ...calendar, networkAccessPolicy: network };
    const portAware = {
      ...bothPortsContext,
      proxy: { ...context.proxy, distinguishesPort: true },
    };
    assert.deepEqual(
      policyRefusals(
        {
          ...bound,
          injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests: [events] }],
        },
        portAware,
      ),
      [],
    );
    assert.deepEqual(policyRefusals(bound, portAware), [
      ["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"],
    ]);
  });

  test("a proxy must distinguish every reachable executable and port outside the binding", () => {
    const {
      policy: calendar,
      context,
      request,
      binding,
      authority,
    } = credentialPolicyFixture({
      type: "http",
      method: "GET",
      path: "/calendar/**",
    });
    const additionalRoutes: [
      DeploymentRequestMatch,
      "distinguishesExecutable" | "distinguishesPort",
    ][] = [
      [
        {
          ...request,
          binary: "/usr/bin/curl",
          // Deserialized records can have different prototypes while matching the same request.
          requestPolicy: Object.assign(Object.create(null), request.requestPolicy),
        },
        "distinguishesExecutable",
      ],
      [{ ...request, ports: [{ from: 8443, to: 8443 }] }, "distinguishesPort"],
    ];
    for (const [extra, distinction] of additionalRoutes) {
      const policy = { ...calendar, networkAccessPolicy: { allowed: [request, extra] } };
      const reachable = {
        ...context,
        ceiling: [
          ...context.ceiling,
          { id: "other", binary: extra.binary, host: extra.host, ports: extra.ports },
        ],
      };
      assert.deepEqual(policyRefusals(policy, reachable), [
        ["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"],
      ]);
      assert.deepEqual(
        policyRefusals(policy, { ...reachable, proxy: { ...context.proxy, [distinction]: true } }),
        [],
      );
    }
    // Both executables may use this binding. The Sandbox restricts curl to one calendar path.
    const narrow = {
      ...request,
      binary: "/usr/bin/curl",
      requestPolicy: { ...request.requestPolicy, path: "/calendar/events" },
    };
    const allowedRequests = [request, narrow];
    assert.deepEqual(
      policyRefusals(
        {
          ...calendar,
          networkAccessPolicy: { allowed: allowedRequests },
          injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests }],
        },
        {
          ...context,
          ceiling: [
            ...context.ceiling,
            { id: "curl", host: narrow.host, ports: narrow.ports, binary: narrow.binary },
          ],
          authorityForBinding: () => ({ ...authority, allowedRequests }),
        },
      ),
      [],
    );
  });

  test("consumer bindings sharing a source keep separate policies and presentations", () => {
    const {
      policy: calendar,
      context,
      binding,
      request,
      authority,
    } = credentialPolicyFixture({
      type: "http",
      method: "GET",
      path: "/calendar/**",
    });
    const events = {
      ...calendarAccount("events", "EVENTS_TOKEN"),
      sourceRef: binding.sourceRef,
      consumer: {
        kind: "plugin",
        pluginId: "events",
        requirement: "account",
        connection: "events",
      },
    } as const;
    const other = {
      ...request,
      requestPolicy: { ...request.requestPolicy, path: "/calendar/events" },
    };
    const eventsAuthority = {
      ...authority,
      projection: { environment: "EVENTS_TOKEN", presentation: "bearer" } as const,
      allowedRequests: [other],
    };
    const eventsPolicy = { bindingRef: events.bindingRef, allowedRequests: [other] };
    const policy = {
      ...calendar,
      networkAccessPolicy: { allowed: [request, other] },
      bindings: [binding, events],
      injectionPolicies: [...calendar.injectionPolicies, eventsPolicy],
    };
    const bothConsumers = {
      ...context,
      authorityForBinding: (id) =>
        id.bindingRef === events.bindingRef &&
        id.sourceRef.id === binding.sourceRef.id &&
        id.consumer.kind === "plugin" &&
        id.consumer.pluginId === "events" &&
        id.consumer.connection === "events"
          ? eventsAuthority
          : context.authorityForBinding(id),
    } satisfies DeploymentPolicyValidationContext;
    // Two consumers share the source but keep distinct placeholders and reviewed request policies.
    assert.deepEqual(policyRefusals(policy, bothConsumers), []);
    assert.deepEqual(
      policyRefusals(
        {
          ...policy,
          bindings: [events],
          injectionPolicies: [eventsPolicy],
        },
        bothConsumers,
      ),
      [],
    );
    assert.deepEqual(
      policyRefusals(
        { ...policy, networkAccessPolicy: { allowed: [other, request] } },
        bothConsumers,
      ),
      [],
    );
    // A unique environment variable can still differ from the one reviewed for this connection.
    assert.deepEqual(
      policyRefusals(
        {
          ...calendar,
          bindings: [
            { ...binding, projection: { ...binding.projection, environment: "OTHER_TOKEN" } },
          ],
        },
        context,
      ),
      [["/bindings/0", "INVALID_VALUE"]],
    );
    assert.deepEqual(policyRefusals(policy, context), [["/bindings/1", "INVALID_VALUE"]]);
    assert.deepEqual(
      policyRefusals(
        {
          ...policy,
          injectionPolicies: [
            ...calendar.injectionPolicies,
            { bindingRef: events.bindingRef, allowedRequests: [request] },
          ],
        },
        bothConsumers,
      ),
      [["/injectionPolicies/1/allowedRequests/0", "INVALID_VALUE"]],
    );
    assert.deepEqual(policyRefusals({ ...policy, bindings: [binding] }, bothConsumers), [
      ["/injectionPolicies/1", "INVALID_VALUE"],
    ]);
    assert.deepEqual(
      policyRefusals({ ...policy, injectionPolicies: calendar.injectionPolicies }, bothConsumers),
      [["/injectionPolicies", "INVALID_VALUE"]],
    );
    assert.deepEqual(
      policyRefusals(
        {
          ...policy,
          bindings: [binding, { ...events, projection: binding.projection }],
        },
        bothConsumers,
      ),
      [["/bindings/1", "INVALID_VALUE"]],
    );
    assert.deepEqual(
      policyRefusals(calendar, {
        ...context,
        proxy: { ...context.proxy, rejectsStaleAndMisplacedPlaceholders: false },
      }),
      [["/injectionPolicies/0", "INVALID_VALUE"]],
    );
    assert.deepEqual(
      policyRefusals(
        {
          ...calendar,
          bindings: [
            {
              ...binding,
              consumer: { kind: "repository", repositoryId: "repo_calendar" },
              projection: { ...binding.projection, presentation: "repository_git" },
            },
          ],
        },
        {
          ...context,
          authorityForBinding: () => ({
            ...authority,
            projection: { ...authority.projection, presentation: "repository_git" },
          }),
        },
      ),
      [["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"]],
    );
  });

  test("a model POST requires static source approval for that method at the same destination", () => {
    const { policy, context, request, binding, authority } = credentialPolicyFixture({
      type: "http",
      method: "POST",
      path: "/v1/responses",
    });
    const model = {
      ...binding,
      consumer: { kind: "model", providerId: "approved-responses" },
      projection: { environment: "MODEL_KEY", presentation: "bearer" },
    } as const;
    const get = { host: request.host, port: 443, path: "/v1/responses", method: "GET" };
    const post = { ...get, method: "POST" };
    function admit(destinations: (typeof get)[]) {
      return policyRefusals(
        { ...policy, bindings: [model] },
        {
          ...context,
          authorityForBinding: () => ({
            ...authority,
            destinations,
            projection: { environment: "MODEL_KEY", presentation: "bearer" },
          }),
        },
      );
    }
    // The model profile and network allow POST on 443. A source may approve a different method there.
    const refused = [["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"]];
    assert.deepEqual(admit([get]), refused);
    assert.deepEqual(admit([get, { ...post, port: 8443 }]), refused);
    assert.deepEqual(admit([post]), []);
    const unspecified = { ...post };
    Reflect.deleteProperty(unspecified, "method");
    assert.deepEqual(admit([unspecified]), refused);
  });

  test("model admission checks the reviewed provider presentation before proxy support", () => {
    const {
      policy: calendar,
      context,
      binding,
      authority,
    } = credentialPolicyFixture({
      type: "http",
      method: "POST",
      path: "/v1/messages",
    });
    const model = {
      ...binding,
      consumer: { kind: "model", providerId: "approved-messages" },
      projection: { environment: "MODEL_KEY", presentation: "x-api-key" },
    } as const;
    // The fixture supplies the reviewed Anthropic profile separately from the proposed projection.
    const reviewed = {
      ...authority,
      projection: { environment: "MODEL_KEY", presentation: "x-api-key" } as const,
    };
    const authorityForBinding: NonNullable<
      DeploymentPolicyValidationContext["authorityForBinding"]
    > = ({ bindingRef, sourceRef, consumer, driverId }) =>
      bindingRef === binding.bindingRef &&
      driverId === "occ" &&
      sourceRef.namespaceId === binding.sourceRef.namespaceId &&
      sourceRef.id === binding.sourceRef.id &&
      consumer.kind === "model" &&
      consumer.providerId === "approved-messages"
        ? reviewed
        : undefined;
    const policy = { ...calendar, bindings: [model] };
    const modelContext = { ...context, authorityForBinding };
    const bothHeaders = { ...context.proxy, supportsBindingRequest: () => true };
    assert.deepEqual(policyRefusals(policy, { ...modelContext, proxy: bothHeaders }), []);
    assert.deepEqual(policyRefusals(policy, modelContext), [
      ["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"],
    ]);
    const refused = [["/bindings/0", "INVALID_VALUE"]];
    const missingLookup = { ...modelContext, proxy: bothHeaders };
    Reflect.deleteProperty(missingLookup, "authorityForBinding");
    assert.deepEqual(policyRefusals(policy, missingLookup), refused);
    const missingProjection = { ...reviewed };
    Reflect.deleteProperty(missingProjection, "projection");
    assert.deepEqual(
      policyRefusals(policy, {
        ...modelContext,
        proxy: bothHeaders,
        authorityForBinding: () => missingProjection,
      }),
      refused,
    );
    const bearer = {
      ...model,
      projection: { ...model.projection, presentation: "bearer" },
    } as const;
    assert.deepEqual(
      policyRefusals({ ...policy, bindings: [bearer] }, { ...modelContext, proxy: bothHeaders }),
      refused,
    );
  });

  test("withdrawing the last binding still guards the remaining network routes", () => {
    const { policy, context } = credentialPolicyFixture({
      type: "http",
      method: "GET",
      path: "/events",
    });
    const retained = {
      ...policy,
      bindings: [],
      injectionPolicies: [],
    };
    const afterWithdrawal = { ...context, targetMayHoldPlaceholders: true };
    assert.deepEqual(policyRefusals(retained, afterWithdrawal), []);
    assert.deepEqual(
      policyRefusals(retained, {
        ...afterWithdrawal,
        proxy: { ...context.proxy, rejectsStaleAndMisplacedPlaceholders: false },
      }),
      [["/injectionPolicies", "INVALID_VALUE"]],
    );
  });

  test("mandatory proxy routing covers credentialless destinations and every allowed port", () => {
    const ports = [{ from: 443, to: 443 }];
    const api = { host: "api.example.org", ports };
    const publicApi = { host: "public.example.org", ports: [...ports, { from: 8443, to: 8443 }] };
    const network = {
      allowed: [api, publicApi].map((route) => ({ ...route, binary: "/usr/bin/node" })),
    };
    const endpoint = { host: "proxy.example.org", port: 8443 };
    const check = (destinations: (typeof api)[], canEnforce: boolean) =>
      credentialProxyRoutingDetails(network, { endpoint, destinations }, () => canEnforce).map(
        ({ path, code }) => [path, code],
      );
    assert.deepEqual(check([api, publicApi], true), []);
    assert.deepEqual(check([api], true), [["/proxyRouting/destinations", "INVALID_VALUE"]]);
    assert.deepEqual(check([api, { ...publicApi, ports }], true), [
      ["/proxyRouting/destinations", "INVALID_VALUE"],
    ]);
    assert.deepEqual(check([api, publicApi], false), [["/proxyRouting", "INVALID_VALUE"]]);
  });
}
