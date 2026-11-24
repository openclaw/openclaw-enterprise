import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import {
  ConfigurationResponse,
  ErrorResponse,
  type OpenClawConfigurationDocument,
  type OpenClawConfigurationValue,
} from "../../packages/contracts/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { consoleFixtureClient } from "../helpers/console-fixture-client.ts";

// A value in a JSON request body may sit at most this many levels below the body root.
export const MAX_DEPTH = 24;
export const TOO_DEEP = (path: string): ErrorResponse["error"] => ({
  code: "INVALID_REQUEST",
  message: "The supplied configuration is invalid.",
  details: [{ path, code: "TOO_DEEP" }],
});

export async function createFixture(t: TestContext) {
  // The filesystem Driver validates native values, as production Drivers do.
  const fixture = consoleFixtureClient(
    await createConsoleAppFixture(t, { providers: [], filesystemConfiguration: true }),
  );
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("JSON body depth", { ready: true });
  const session = await fixture.signIn();
  return { ...fixture, namespace, session };
}

type DepthFixture = Awaited<ReturnType<typeof createFixture>>;

export type SendRaw = (
  fixture: DepthFixture,
  method: string,
  path: string,
  text: string,
) => Promise<{ status: number; body: unknown }>;

// `levels` objects, each holding the next under `key`, around `leaf`.
export function nested(
  levels: number,
  leaf: OpenClawConfigurationValue,
  key = "n",
): OpenClawConfigurationValue {
  let value = leaf;
  for (let level = 0; level < levels; level += 1) {
    value = { [key]: value };
  }
  return value;
}

// `levels` arrays, each holding the next, around `leaf`.
function nestedArrays(
  levels: number,
  leaf: OpenClawConfigurationValue,
): OpenClawConfigurationValue {
  let value = leaf;
  for (let level = 0; level < levels; level += 1) {
    value = [value];
  }
  return value;
}

export const pointer = (prefix: string, levels: number, segment = "n") =>
  `${prefix}${`/${segment}`.repeat(levels)}`;

// Native values with `config` holding `inner`: plugin configuration is free-form JSON.
export const knowledge = (config: OpenClawConfigurationValue) => ({
  plugins: { entries: { knowledge: { enabled: true, config } } },
});
export const KNOWLEDGE = "/plugins/entries/knowledge/config";

type DepthRoute = {
  name: string;
  path: string;
  status: number;
  base: number;
  prefix: string;
  body: (inner: OpenClawConfigurationValue, index: number) => OpenClawConfigurationDocument;
};

export type DepthRoutes = readonly [configuration: DepthRoute, ...otherRoutes: DepthRoute[]];

export async function assertAcceptedDepth(
  fixture: DepthFixture,
  routes: DepthRoutes,
  maxDepth: number,
): Promise<void> {
  let index = 0;
  for (const route of routes) {
    const levels = maxDepth - route.base;
    for (const inner of [
      nested(levels, "leaf"),
      // Arrays count the same as objects, and a container at the bound may be empty.
      { n: nestedArrays(levels - 1, "leaf") },
      nested(levels, {}),
      { n: nestedArrays(levels - 1, []) },
    ]) {
      index += 1;
      const body = route.body(inner, index);
      const accepted = await fixture.request("POST", route.path, { body });
      assert.equal(
        accepted.status,
        route.status,
        `${route.name}: ${JSON.stringify(accepted.body).slice(0, 300)}`,
      );
    }
  }
}

type RefusalHelpers = {
  nested: typeof nested;
  pointer: typeof pointer;
  sendRaw: SendRaw;
  TOO_DEEP: typeof TOO_DEEP;
};

export async function assertRefusedDepth(
  fixture: DepthFixture,
  routes: DepthRoutes,
  { nested, pointer, sendRaw, TOO_DEEP }: RefusalHelpers,
): Promise<void> {
  const ordinary: Omit<DepthRoute, "status"> = {
    name: "Namespace create (64 KiB)",
    path: "/namespaces",
    base: 1,
    prefix: "/extra",
    // An unknown field: a schema error, unless the depth check refuses the body first.
    body: (inner) => ({ name: "Too deep", extra: inner }),
  };
  let index = 0;
  for (const route of [...routes, ordinary]) {
    const levels = MAX_DEPTH - route.base;
    const cases: readonly (readonly [OpenClawConfigurationValue, string])[] = [
      // One scalar one level too deep.
      [nested(levels + 1, "leaf"), pointer(route.prefix, levels + 1)],
      // A container one level too deep, empty or not.
      [nested(levels, { n: {} }), pointer(route.prefix, levels + 1)],
      [nested(levels + 1, []), pointer(route.prefix, levels + 1)],
      [{ n: nestedArrays(levels, "leaf") }, `${route.prefix}/n${"/0".repeat(levels)}`],
      // Keys are named as sent, escaped as JSON Pointer segments.
      [nested(levels + 1, 1, 'a/~é"'), pointer(route.prefix, levels + 1, 'a~1~0é"')],
    ];
    for (const [inner, path] of cases) {
      index += 1;
      const text = JSON.stringify(route.body(inner, index));
      // A key sent with a \u escape is named decoded.
      const sends = text.includes("é") ? [text, text.replaceAll("é", "\\u00e9")] : [text];
      for (const sent of sends) {
        const refused = await sendRaw(fixture, "POST", route.path, sent);
        const { error } = fixture.fixtureResponse(refused, 400, ErrorResponse, route.name);
        assert.deepEqual(error, TOO_DEEP(path), route.name);
      }
    }
    // A valid body at the bound on the ordinary route gets its usual contract answer.
    if (route === ordinary) {
      const atBound = await sendRaw(
        fixture,
        "POST",
        route.path,
        JSON.stringify(route.body(nested(levels, "leaf"), 0)),
      );
      const { error } = fixture.fixtureResponse(
        atBound,
        400,
        ErrorResponse,
        "Namespace at depth bound",
      );
      assert.deepEqual(error.details, [{ path: "/extra", code: "UNKNOWN_FIELD" }]);
    }
    // About 60 KB, 30 000 levels deep: a 500 before the check existed.
    const deep = await sendRaw(
      fixture,
      "POST",
      route.path,
      JSON.stringify(route.body("DEEP", 0)).replace(
        '"DEEP"',
        `${"[".repeat(30_000)}1${"]".repeat(30_000)}`,
      ),
    );
    const { error } = fixture.fixtureResponse(deep, 400, ErrorResponse, route.name);
    assert.deepEqual(error, TOO_DEEP(`${route.prefix}${"/0".repeat(MAX_DEPTH + 1 - route.base)}`));
  }
  // Strings and escapes that look like brackets do not count.
  const bracketText = '[[[{{{\\"\\\\'.repeat(20);
  const values = knowledge(nested(MAX_DEPTH - 5, bracketText, `{[${bracketText}`));
  const created = await fixture.request("POST", routes[0].path, {
    body: { kind: "agent", values },
  });
  const { data } = fixture.fixtureResponse(
    created,
    201,
    ConfigurationResponse,
    "brackets in strings",
  );
  assert.deepEqual(data.values, values);

  // Width alone is accepted. Two deep entries must report the first index in wire order.
  const items = Array.from({ length: 32 }, (_, index) => ({ index }));
  const shallow = await fixture.request("POST", routes[0].path, {
    body: routes[0].body({ items }, 0),
  });
  fixture.fixtureResponse(shallow, 201, ConfigurationResponse, "shallow wide array");
  const deepItems = items.map((item, index) =>
    index === 11 || index === 27 ? nested(18, "leaf") : item,
  );
  const deep = await sendRaw(
    fixture,
    "POST",
    routes[0].path,
    JSON.stringify(routes[0].body({ items: deepItems }, 0)),
  );
  const { error } = fixture.fixtureResponse(
    deep,
    400,
    ErrorResponse,
    "wide array with deep entries",
  );
  assert.deepEqual(error, TOO_DEEP(`/values${KNOWLEDGE}/items/11${"/n".repeat(18)}`));
}

export async function assertRefusedLargeBody(
  fixture: DepthFixture,
  path: string,
  sendRaw: SendRaw,
): Promise<void> {
  const prefix = '{"kind":"agent","values":{"plugins":{"entries":{"knowledge":{"config":{"n":';
  const levels = Math.floor((6 * 1024 * 1024 - prefix.length) / 2);
  const text = `${prefix}${"[".repeat(levels)}${"]".repeat(levels)}}}}}}}`;
  assert.ok(Buffer.byteLength(text) > 6 * 1024 * 1024 - 64);
  // Warm the route, so the measurement covers only this body.
  const warmup = await sendRaw(
    fixture,
    "POST",
    path,
    JSON.stringify({ kind: "agent", values: {} }),
  );
  fixture.fixtureResponse(warmup, 201, ConfigurationResponse, "warm Configuration create");
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  // The sampler runs between the request's I/O steps, not during a synchronous parse; the
  // sample after the response still sees what a parse left on the heap.
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }, 1);
  const started = performance.now();
  let refused: Awaited<ReturnType<SendRaw>>;
  try {
    refused = await sendRaw(fixture, "POST", path, text);
  } finally {
    clearInterval(sampler);
  }
  const elapsedMs = performance.now() - started;
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  const { error } = fixture.fixtureResponse(refused, 400, ErrorResponse, "6 MB Configuration");
  assert.deepEqual(error, TOO_DEEP(`/values${KNOWLEDGE}/n${"/0".repeat(MAX_DEPTH - 5)}`));
  // About 30 ms with the check, about 1 s without it.
  assert.ok(elapsedMs < 1000, `took ${Math.round(elapsedMs)} ms`);
  // Parsing it built millions of arrays: about 300 MB of heap. The request and body text
  // themselves take a few times 6 MB, plus garbage not yet collected.
  const grewMb = (peak - before) / (1024 * 1024);
  assert.ok(grewMb < 128, `heap grew ${grewMb.toFixed(1)} MB`);
}
