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
  const input = {
    targetMayHoldPlaceholders: false,
    ceiling: [{ id: "api", ...destination }],
    sandbox: { wildcards: false, portRanges: false, supportsNetworkPolicy: () => true },
    networkAccessPolicy: { allowed: [request] },
    bindings: [binding],
    injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests: [request] }],
    proxy: {
      distinguishesExecutable: false,
      distinguishesPort: false,
      rejectsStaleAndMisplacedPlaceholders: true,
      supportsBindingRequest: (binding) => binding.projection.presentation === "bearer",
    },
  } satisfies CredentialPolicyAdmission;
  return { input, request, binding };
}

function policyRefusals(input: CredentialPolicyAdmission) {
  return deploymentPolicyAdmissionDetails(input).map(({ path, code }) => [path, code]);
}

function evaluatorPolicyFixture() {
  const pin = { id: "calendar", digest: "1".repeat(64) };
  const admittedSource = {
    bindingRef: "work",
    host: "api.example.org",
    port: 443,
    path: "/calendar/**",
    scopes: ["calendar.read", "profile.read"],
  };
  const { input, request } = credentialPolicyFixture({
    type: "evaluator",
    ...pin,
    admittedSource,
  });
  // The connected account granted more scopes than the deployment needs.
  const authority = {
    endpoints: [{ host: "api.example.org", port: 443, path: "/calendar/**" }],
    grantedScopes: ["calendar.read", "calendar.write", "profile.read"],
  };
  const binding = { ...calendarAccount("work", "WORK_TOKEN"), evaluatorAuthority: authority };
  const matchSource = (source: typeof admittedSource) => ({
    ...request,
    requestPolicy: { ...request.requestPolicy, admittedSource: source },
  });
  return {
    pin,
    admittedSource,
    request,
    binding,
    matchSource,
    input: {
      ...input,
      bindings: [binding],
      sandbox: { ...input.sandbox, evaluators: [pin] },
      proxy: { ...input.proxy, evaluators: [pin] },
    },
  };
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
      const { input, request, binding } = credentialPolicyFixture(allowed);
      assert.deepEqual(policyRefusals(input), []);
      assert.deepEqual(
        policyRefusals({
          ...input,
          injectionPolicies: [
            {
              bindingRef: binding.bindingRef,
              allowedRequests: [{ ...request, requestPolicy: other }],
            },
          ],
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

  test("both enforcing Drivers must qualify the evaluator pinned in the revision", () => {
    const { input, pin, request } = evaluatorPolicyFixture();
    assert.deepEqual(policyRefusals(input), []);
    // Even a Driver advertising request support must name the exact reviewed evaluator.
    assert.deepEqual(policyRefusals({ ...input, sandbox: { ...input.sandbox, evaluators: [] } }), [
      ["/networkAccessPolicy/allowed/0", "INVALID_VALUE"],
    ]);
    assert.deepEqual(
      policyRefusals({
        ...input,
        proxy: {
          ...input.proxy,
          evaluators: [{ ...pin, digest: "2".repeat(64) }],
        },
      }),
      [["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"]],
    );
    // A separately qualified evaluator cannot supply the network allowance for this binding.
    for (const other of [
      { ...pin, id: "other" },
      { ...pin, digest: "2".repeat(64) },
    ]) {
      const alternate = { ...request, requestPolicy: { ...request.requestPolicy, ...other } };
      assert.deepEqual(
        policyRefusals({
          ...input,
          sandbox: { ...input.sandbox, evaluators: [pin, other] },
          networkAccessPolicy: { allowed: [alternate] },
        }),
        [["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"]],
      );
    }
  });

  test("network evaluators need a complete admitted source for a known binding", () => {
    const { input, matchSource, admittedSource } = evaluatorPolicyFixture();
    function withSource(source: typeof admittedSource) {
      return policyRefusals({
        ...input,
        networkAccessPolicy: { allowed: [matchSource(source)] },
      });
    }
    assert.deepEqual(withSource(admittedSource), []);
    for (const field of Object.keys(admittedSource)) {
      // A partially populated source can arrive from a deserialized revision.
      const incomplete = { ...admittedSource };
      Reflect.deleteProperty(incomplete, field);
      assert.deepEqual(
        withSource(incomplete),
        [["/networkAccessPolicy/allowed/0", "INVALID_VALUE"]],
        field,
      );
    }
    for (const changed of [
      { bindingRef: "unknown" },
      { host: "*.example.org" },
      { port: 0 },
      { scopes: ["calendar.read calendar.write"] },
      { unexpected: true },
    ]) {
      assert.deepEqual(withSource({ ...admittedSource, ...changed }), [
        ["/networkAccessPolicy/allowed/0", "INVALID_VALUE"],
      ]);
    }
  });

  test("evaluator bounds on network and injection rules must be authorized by the source record", () => {
    const { input, binding, request } = evaluatorPolicyFixture();
    const { evaluatorAuthority, ...withoutAuthority } = binding;
    const endpoint = evaluatorAuthority.endpoints[0]!;
    const { binary, host, ports } = request;
    const transport = { allowed: [{ binary, host, ports }] };
    // These endpoints share individual fields with the rule, but neither authorizes its full endpoint.
    const otherEndpoints = [
      { ...endpoint, path: "/profile/**" },
      { ...endpoint, port: 8443 },
    ];
    for (const candidate of [
      withoutAuthority,
      { ...binding, evaluatorAuthority: { ...evaluatorAuthority, endpoints: otherEndpoints } },
      {
        ...binding,
        evaluatorAuthority: { ...evaluatorAuthority, grantedScopes: ["calendar.read"] },
      },
    ]) {
      const policy = { ...input, bindings: [candidate] };
      assert.deepEqual(policyRefusals(policy), [
        ["/networkAccessPolicy/allowed/0", "INVALID_VALUE"],
      ]);
      // Ordinary transport is authorized. The injection rule must independently check the source.
      assert.deepEqual(policyRefusals({ ...policy, networkAccessPolicy: transport }), [
        ["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"],
      ]);
    }
  });

  test("one evaluator can serve two accounts only when both Drivers qualify their combined policy", () => {
    const { input, pin, binding, request, admittedSource, matchSource } = evaluatorPolicyFixture();
    const account = calendarAccount("personal", "PERSONAL_TOKEN");
    const scopes = ["calendar.write"];
    const personal = {
      ...account,
      evaluatorAuthority: {
        endpoints: binding.evaluatorAuthority.endpoints,
        grantedScopes: scopes,
      },
    };
    const personalRule = matchSource({ ...admittedSource, bindingRef: account.bindingRef, scopes });
    const policy = {
      ...input,
      bindings: [binding, personal],
      networkAccessPolicy: { allowed: [request, personalRule] },
      injectionPolicies: [
        ...input.injectionPolicies,
        { bindingRef: account.bindingRef, allowedRequests: [personalRule] },
      ],
    };
    assert.deepEqual(policyRefusals(policy), []);
    const ungranted = matchSource({ ...admittedSource, bindingRef: personal.bindingRef });
    assert.deepEqual(
      policyRefusals({ ...policy, networkAccessPolicy: { allowed: [request, ungranted] } }),
      [["/networkAccessPolicy/allowed/1", "INVALID_VALUE"]],
    );
    assert.deepEqual(
      policyRefusals({
        ...policy,
        sandbox: {
          ...input.sandbox,
          supportsNetworkPolicy: (network) => network.allowed.length === 1,
        },
      }),
      [["/networkAccessPolicy/allowed", "INVALID_VALUE"]],
    );
    assert.deepEqual(
      policyRefusals({
        ...policy,
        proxy: {
          ...input.proxy,
          supportsBindingRequest: (bound) => bound.projection.environment === "WORK_TOKEN",
        },
      }),
      [["/injectionPolicies/1/allowedRequests/0", "INVALID_VALUE"]],
    );

    // Different evaluator versions can make different decisions at the same endpoint.
    const otherPin = { ...pin, digest: "2".repeat(64) };
    const otherRule = {
      ...personalRule,
      requestPolicy: { ...personalRule.requestPolicy, ...otherPin },
    };
    assert.deepEqual(
      policyRefusals({
        ...policy,
        networkAccessPolicy: { allowed: [request, otherRule] },
        sandbox: { ...input.sandbox, evaluators: [pin, otherPin] },
      }),
      [["/networkAccessPolicy/allowed/1", "INVALID_VALUE"]],
    );
  });

  test("one binding can use independent endpoint rows on the same host", () => {
    const { input, binding, request, admittedSource, matchSource } = evaluatorPolicyFixture();
    const { evaluatorAuthority } = binding;
    const endpoint = evaluatorAuthority.endpoints[0]!;
    for (const [path, issues] of [
      ["/profile/**", []],
      ["/calendar/events", [["/networkAccessPolicy/allowed/1", "INVALID_VALUE"]]],
    ] as const) {
      const second = matchSource({ ...admittedSource, path, scopes: ["profile.read"] });
      const allowed = [request, second];
      const policy = {
        ...input,
        bindings: [
          {
            ...binding,
            evaluatorAuthority: {
              ...evaluatorAuthority,
              endpoints: [endpoint, { ...endpoint, path }],
            },
          },
        ],
        networkAccessPolicy: { allowed },
        injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests: allowed }],
      };
      assert.deepEqual(policyRefusals(policy), issues, path);
    }
  });

  test("an evaluator may permit credentialless discovery while injection retains the admitted binding and endpoint", () => {
    const { input, binding, request, admittedSource, matchSource } = evaluatorPolicyFixture();
    const discovery = { ...request, host: "discovery.example.org" };
    const alternatePort = { ...request, ports: [{ from: 8443, to: 8443 }] };
    const network = [request, discovery, alternatePort];
    // The same evaluator can inspect discovery outside the source path on the API host.
    // The proxy also distinguishes the alternate port and gets the original injection path.
    const policy = {
      ...input,
      networkAccessPolicy: { allowed: network },
      ceiling: network.map(({ binary, host, ports }, i) => ({
        id: "endpoint-" + i,
        binary,
        host,
        ports,
      })),
      proxy: { ...input.proxy, distinguishesPort: true },
    };
    function injectionRule(rule: DeploymentRequestMatch) {
      return policyRefusals({
        ...policy,
        injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests: [rule] }],
      });
    }
    const refused = [["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"]];
    assert.deepEqual(injectionRule(request), []);
    for (const other of [discovery, alternatePort]) {
      assert.deepEqual(injectionRule(other), refused);
    }
    assert.deepEqual(
      injectionRule(
        matchSource({ ...admittedSource, scopes: [...admittedSource.scopes].reverse() }),
      ),
      [],
    );
    for (const changed of [
      { host: discovery.host },
      { port: 8443 },
      { path: "/**" },
      { scopes: [...admittedSource.scopes, "calendar.write"] },
    ]) {
      assert.deepEqual(injectionRule(matchSource({ ...admittedSource, ...changed })), refused);
    }

    // An admitted second account still cannot claim the first account's evaluator rule.
    const other = {
      ...calendarAccount("personal", "PERSONAL_TOKEN"),
      evaluatorAuthority: binding.evaluatorAuthority,
    };
    assert.deepEqual(
      policyRefusals({
        ...policy,
        bindings: [binding, other],
        injectionPolicies: [
          ...policy.injectionPolicies,
          { bindingRef: other.bindingRef, allowedRequests: [request] },
        ],
      }),
      [["/injectionPolicies/1/allowedRequests/0", "INVALID_VALUE"]],
    );
  });

  test("a proxy must distinguish every reachable executable and port outside the binding", () => {
    const { input, request } = credentialPolicyFixture({
      type: "http",
      method: "GET",
      path: "/events",
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
  });

  test("credential policies identify each account binding and its supported presentation", () => {
    const { input, binding, request } = credentialPolicyFixture({
      type: "http",
      method: "GET",
      path: "/events",
    });
    const personal = calendarAccount("personal", "PERSONAL_TOKEN");
    const policy = {
      ...input,
      bindings: [binding, personal],
      injectionPolicies: [
        ...input.injectionPolicies,
        { bindingRef: personal.bindingRef, allowedRequests: [request] },
      ],
    };
    assert.deepEqual(policyRefusals(policy), []);
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
    const { input, binding } = credentialPolicyFixture({
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
    const modelPresentationFor: NonNullable<CredentialPolicyAdmission["modelPresentationFor"]> = (
      ref,
      source,
      provider,
    ) =>
      ref === binding.bindingRef &&
      source.namespaceId === binding.sourceRef.namespaceId &&
      source.id === binding.sourceRef.id &&
      provider === "approved-messages"
        ? "x-api-key"
        : undefined;
    const policy = { ...input, bindings: [model], modelPresentationFor };
    const bothHeaders = { ...input.proxy, supportsBindingRequest: () => true };
    assert.deepEqual(policyRefusals({ ...policy, proxy: bothHeaders }), []);
    assert.deepEqual(policyRefusals(policy), [
      ["/injectionPolicies/0/allowedRequests/0", "INVALID_VALUE"],
    ]);
    const refused = [["/bindings/0", "INVALID_VALUE"]];
    assert.deepEqual(policyRefusals({ ...input, bindings: [model], proxy: bothHeaders }), refused);
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
