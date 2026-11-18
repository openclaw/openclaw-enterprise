import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialProxyRoutingDetails,
  deploymentPolicyAdmissionDetails,
  type CredentialPolicyAdmission,
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

function credentialPolicyFixture<Policy extends DeploymentRequestPolicy>(requestPolicy: Policy) {
  const destination = {
    binary: "/usr/bin/node",
    host: "api.example.org",
    ports: [{ from: 443, to: 443 }],
  };
  const request = { ...destination, requestPolicy };
  const binding = calendarAccount("work", "WORK_TOKEN");
  const authority = {
    destinations: [{ host: destination.host, port: 443, path: requestPolicy.path }],
    allowedRequests: [request],
    presentation: "bearer" as const,
  };
  const input = {
    targetMayHoldPlaceholders: false,
    ceiling: [{ id: "api", ...destination }],
    sandbox: { wildcards: false, portRanges: false, supportsNetworkPolicy: () => true },
    networkAccessPolicy: { allowed: [request] },
    bindings: [binding],
    authorityForBinding: ({ sourceRef, consumer }) =>
      sourceRef.id === "cs_work" && consumer.kind === "plugin" && consumer.connection === "work"
        ? authority
        : undefined,
    injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests: [request] }],
    proxy: {
      distinguishesExecutable: false,
      distinguishesPort: false,
      rejectsStaleAndMisplacedPlaceholders: true,
      supportsBindingRequest: (binding) => binding.projection.presentation === "bearer",
    },
  } satisfies CredentialPolicyAdmission;
  return { input, request, binding, authority };
}

function policyRefusals(input: CredentialPolicyAdmission) {
  return deploymentPolicyAdmissionDetails(input).map(({ path, code }) => [path, code]);
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
      const { input, request } = credentialPolicyFixture(other);
      assert.deepEqual(policyRefusals(input), []);
      assert.deepEqual(
        policyRefusals({
          ...input,
          networkAccessPolicy: { allowed: [{ ...request, requestPolicy: allowed }] },
        }),
        [["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"]],
      );
    }
  });

  test("a source subtree includes its base and descendants while same-host discovery stays credentialless", () => {
    const { input, request, binding, authority } = credentialPolicyFixture({
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
      ...input,
      authorityForBinding: () => reviewed,
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
      return policyRefusals({
        ...policy,
        injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests: [atPath(path)] }],
      });
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

  test("each injection destination needs a source endpoint covering its host, port and path together", () => {
    const { input, binding, request, authority } = credentialPolicyFixture({
      type: "http",
      method: "GET",
      path: "/calendar/**",
    });
    const { binary, host, ports } = request;
    // Each proposed route is allowed by the consumer and the Sandbox. Only the source is narrower.
    for (const rule of [
      { binary, host, ports },
      { ...request, ports: [{ from: 443, to: 444 }] },
      { ...request, host: "other.example.org" },
    ]) {
      const allowedRequests = [rule];
      const result = policyRefusals({
        ...input,
        authorityForBinding: () => ({
          ...authority,
          destinations: [
            ...authority.destinations,
            { host: "other.example.org", port: 444, path: "/calendar/**" },
          ],
          allowedRequests,
        }),
        ceiling: [{ id: "route", binary, host: rule.host, ports: rule.ports }],
        sandbox: { ...input.sandbox, portRanges: true },
        networkAccessPolicy: { allowed: allowedRequests },
        injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests }],
      });
      assert.deepEqual(result, [["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"]]);
    }
  });

  test("a reviewed MCP connection limits the executable, method and tool despite network permission", () => {
    const { input, request, binding } = credentialPolicyFixture({
      type: "mcp",
      method: "tools/call",
      path: "/mcp",
      toolName: "events_read",
    });
    const { binary, host, ports } = request;
    const otherBinary = "/usr/bin/curl";
    const policy = {
      ...input,
      networkAccessPolicy: {
        allowed: [
          { binary, host, ports },
          { binary: otherBinary, host, ports },
        ],
      },
      ceiling: [...input.ceiling, { id: "client", binary: otherBinary, host, ports }],
      proxy: { ...input.proxy, distinguishesExecutable: true },
    };
    assert.deepEqual(policyRefusals(policy), []);
    for (const extra of [
      { ...request, binary: otherBinary },
      { ...request, requestPolicy: { type: "mcp", path: "/mcp", method: "tools/list" } },
      { ...request, requestPolicy: { ...request.requestPolicy, toolName: "events_write" } },
    ] satisfies DeploymentRequestMatch[]) {
      assert.deepEqual(
        policyRefusals({
          ...policy,
          injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests: [extra] }],
        }),
        [["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"]],
      );
    }
  });

  test("credentialless access needs a Sandbox that can enforce the complete network policy", () => {
    const { input, request } = credentialPolicyFixture({
      type: "http",
      method: "GET",
      path: "/events",
    });
    const policy = {
      targetMayHoldPlaceholders: false,
      ceiling: input.ceiling,
      sandbox: input.sandbox,
      networkAccessPolicy: input.networkAccessPolicy,
      bindings: [],
      injectionPolicies: [],
    };
    assert.deepEqual(policyRefusals(policy), []);
    assert.deepEqual(
      policyRefusals({
        ...policy,
        sandbox: { ...input.sandbox, supportsNetworkPolicy: () => false },
      }),
      [["/networkAccessPolicy/allowed", "INVALID_VALUE"]],
    );
    // An unrestricted rule at the same endpoint could also allow every unselected operation.
    const { binary, host, ports } = request;
    assert.deepEqual(
      policyRefusals({
        ...policy,
        networkAccessPolicy: { allowed: [request, { binary, host, ports }] },
      }),
      [["/networkAccessPolicy/allowed/1", "INVALID_VALUE"]],
    );
  });

  test("a proxy must distinguish every reachable executable and port outside the binding", () => {
    const { input, request, binding, authority } = credentialPolicyFixture({
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
      const policy = {
        ...input,
        ceiling: [
          ...input.ceiling,
          { id: "other", binary: extra.binary, host: extra.host, ports: extra.ports },
        ],
        networkAccessPolicy: { allowed: [request, extra] },
      };
      assert.deepEqual(policyRefusals(policy), [
        ["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"],
      ]);
      assert.deepEqual(
        policyRefusals({ ...policy, proxy: { ...input.proxy, [distinction]: true } }),
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
      policyRefusals({
        ...input,
        ceiling: [
          ...input.ceiling,
          { id: "curl", host: narrow.host, ports: narrow.ports, binary: narrow.binary },
        ],
        networkAccessPolicy: { allowed: allowedRequests },
        authorityForBinding: () => ({ ...authority, allowedRequests }),
        injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests }],
      }),
      [],
    );
  });

  test("credential policies identify each account binding and its supported presentation", () => {
    const { input, binding, request, authority } = credentialPolicyFixture({
      type: "http",
      method: "GET",
      path: "/events",
    });
    const personal = calendarAccount("personal", "PERSONAL_TOKEN");
    const other = { ...request, requestPolicy: { ...request.requestPolicy, path: "/personal" } };
    const personalAuthority = {
      ...authority,
      destinations: [{ host: request.host, port: 443, path: "/personal" }],
      allowedRequests: [other],
    };
    const policy = {
      ...input,
      networkAccessPolicy: { allowed: [request, other] },
      bindings: [binding, personal],
      authorityForBinding: (id) =>
        id.sourceRef.id === "cs_personal" &&
        id.consumer.kind === "plugin" &&
        id.consumer.connection === "personal"
          ? personalAuthority
          : input.authorityForBinding(id),
      injectionPolicies: [
        ...input.injectionPolicies,
        { bindingRef: personal.bindingRef, allowedRequests: [other] },
      ],
    } satisfies CredentialPolicyAdmission;
    assert.deepEqual(policyRefusals(policy), []);
    assert.deepEqual(
      policyRefusals({ ...policy, authorityForBinding: input.authorityForBinding }),
      [["/bindings/1", "INVALID_VALUE"]],
    );
    assert.deepEqual(
      policyRefusals({
        ...policy,
        injectionPolicies: [
          ...input.injectionPolicies,
          { bindingRef: personal.bindingRef, allowedRequests: [request] },
        ],
      }),
      [["/injectionPolicies/1/allowedRequests/0", "INVALID_VALUE"]],
    );
    assert.deepEqual(policyRefusals({ ...policy, bindings: [binding] }), [
      ["/injectionPolicies/1", "INVALID_VALUE"],
    ]);
    assert.deepEqual(policyRefusals({ ...policy, injectionPolicies: input.injectionPolicies }), [
      ["/injectionPolicies", "INVALID_VALUE"],
    ]);
    assert.deepEqual(
      policyRefusals({
        ...policy,
        bindings: [binding, { ...personal, projection: binding.projection }],
      }),
      [["/bindings/1", "INVALID_VALUE"]],
    );
    assert.deepEqual(
      policyRefusals({
        ...input,
        proxy: { ...input.proxy, rejectsStaleAndMisplacedPlaceholders: false },
      }),
      [["/injectionPolicies/0", "INVALID_VALUE"]],
    );
    assert.deepEqual(
      policyRefusals({
        ...input,
        authorityForBinding: () => ({ ...authority, presentation: "repository_git" }),
        bindings: [
          {
            ...binding,
            consumer: { kind: "repository", repositoryId: "repo_calendar" },
            projection: { ...binding.projection, presentation: "repository_git" },
          },
        ],
      }),
      [["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"]],
    );
  });

  test("model admission checks the reviewed provider presentation before proxy support", () => {
    const { input, binding, authority } = credentialPolicyFixture({
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
    const reviewed = { ...authority, presentation: "x-api-key" as const };
    const authorityForBinding: NonNullable<CredentialPolicyAdmission["authorityForBinding"]> = ({
      bindingRef,
      sourceRef,
      consumer,
      driverId,
    }) =>
      bindingRef === binding.bindingRef &&
      driverId === "occ" &&
      sourceRef.namespaceId === binding.sourceRef.namespaceId &&
      sourceRef.id === binding.sourceRef.id &&
      consumer.kind === "model" &&
      consumer.providerId === "approved-messages"
        ? reviewed
        : undefined;
    const policy = { ...input, bindings: [model], authorityForBinding };
    const bothHeaders = { ...input.proxy, supportsBindingRequest: () => true };
    assert.deepEqual(policyRefusals({ ...policy, proxy: bothHeaders }), []);
    assert.deepEqual(policyRefusals(policy), [
      ["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"],
    ]);
    const refused = [["/bindings/0", "INVALID_VALUE"]];
    const missingLookup = { ...policy, proxy: bothHeaders };
    Reflect.deleteProperty(missingLookup, "authorityForBinding");
    assert.deepEqual(policyRefusals(missingLookup), refused);
    const missingPresentation = { ...reviewed };
    Reflect.deleteProperty(missingPresentation, "presentation");
    assert.deepEqual(
      policyRefusals({
        ...policy,
        proxy: bothHeaders,
        authorityForBinding: () => missingPresentation,
      }),
      refused,
    );
    const bearer = {
      ...model,
      projection: { ...model.projection, presentation: "bearer" },
    } as const;
    assert.deepEqual(
      policyRefusals({ ...policy, bindings: [bearer], proxy: bothHeaders }),
      refused,
    );
  });

  test("withdrawing the last binding still guards the remaining network routes", () => {
    const { input } = credentialPolicyFixture({ type: "http", method: "GET", path: "/events" });
    const retained = {
      ...input,
      bindings: [],
      injectionPolicies: [],
      targetMayHoldPlaceholders: true,
    };
    assert.deepEqual(policyRefusals(retained), []);
    assert.deepEqual(
      policyRefusals({
        ...retained,
        proxy: { ...input.proxy, rejectsStaleAndMisplacedPlaceholders: false },
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
