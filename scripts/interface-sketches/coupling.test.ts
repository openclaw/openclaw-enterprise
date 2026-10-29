import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeCoupling } from "./coupling.ts";

function fixture(t: test.TestContext, sources: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "oce-coupling-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  for (const [file, source] of Object.entries(sources)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  }
  return root;
}

const contracts = `export interface Exchange { resolve(): void }
export interface Driver { bindExchange?(factory: () => Exchange): void }
export class Controller {
  createCredentialProxy(): Exchange { throw new Error("fixture"); }
}
export class Proxy implements Exchange { resolve() {} }
export const helper = () => {};
`;

test("resolves aliases, mapped methods, interfaces and lexical callbacks from source only", (t) => {
  const root = fixture(t, {
    "packages/occ/src/index.ts":
      'export { Controller, Proxy, helper } from "../../../contracts.js";',
    "contracts.ts": contracts,
    "decoy.ts": "export class Proxy { resolve() {} }",
    "caller.ts": `import { Controller, Proxy as Renamed, helper as invoke } from "@openclaw-enterprise/occ";
import type { Exchange, Driver } from "./contracts.js";
import { Proxy as Decoy } from "./decoy.js";
export const run = (controller: Pick<Controller, "createCredentialProxy">, driver: Driver) => {
  const forwarder = controller.createCredentialProxy();
  driver.bindExchange?.(() => { forwarder.resolve(); return new Renamed(); });
  invoke();
  const other = new Decoy();
  other.resolve();
  const bound = forwarder.resolve.bind(forwarder);
};
export class Service implements Exchange {
  resolve() { invoke(); }
}
`,
  });
  const result = analyzeCoupling(root, ["caller.ts"]);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(
    result.edges.map(({ from, kind, to, site }) => [from, kind, to, site.line]),
    [
      ["caller.ts#Service", "implements", "contracts.ts#Exchange", 12],
      ["caller.ts#Service.resolve", "calls", "contracts.ts#helper", 13],
      ["caller.ts#run", "binds", "contracts.ts#Exchange.resolve", 10],
      ["caller.ts#run", "calls", "contracts.ts#Controller.createCredentialProxy", 5],
      ["caller.ts#run", "calls", "contracts.ts#Driver.bindExchange", 6],
      ["caller.ts#run", "calls", "contracts.ts#Exchange.resolve", 6],
      ["caller.ts#run", "calls", "contracts.ts#helper", 7],
      ["caller.ts#run", "calls", "decoy.ts#Proxy.resolve", 9],
      ["caller.ts#run", "constructs", "contracts.ts#Proxy", 6],
      ["caller.ts#run", "constructs", "decoy.ts#Proxy", 8],
    ],
  );
  assert.ok(result.edges.every(({ site }) => site.file === "caller.ts"));
  assert.deepEqual(analyzeCoupling(root, ["caller.ts", "caller.ts"]), result);
});

test("keeps ambiguous, dynamic, any and incorrectly bound targets unresolved", (t) => {
  const root = fixture(t, {
    "contracts.ts": contracts,
    "caller.ts": `import type { Exchange } from "./contracts.js";
interface Other { resolve(): void }
function overloaded(x: string): void;
function overloaded(x: number): void;
function overloaded(x: string | number) {}
export function run(a: Exchange, b: Exchange, union: Exchange | Other, dynamic: any, key: string) {
  union.resolve();
  dynamic.resolve();
  a[key]();
  a.resolve.bind(b);
  overloaded("x");
}
`,
  });
  const result = analyzeCoupling(root, ["caller.ts"]);
  assert.deepEqual(result.edges, []);
  assert.deepEqual(
    result.unresolved.map(({ kind, site }) => [kind, site.line]),
    [
      ["calls", 7],
      ["calls", 8],
      ["calls", 9],
      ["binds", 10],
      ["calls", 11],
    ],
  );
  assert.ok(
    result.unresolved.every(({ from, site }) => from === "caller.ts#run" && site.line >= 7),
  );
});

test("rediscovers edits and removals instead of retaining claimed edges", (t) => {
  const root = fixture(t, {
    "contracts.ts": "export const first = () => {}; export const second = () => {};",
    "caller.ts":
      'import { first, second } from "./contracts.js"; export const run = () => first();',
  });
  assert.equal(analyzeCoupling(root, ["caller.ts"]).edges[0].to, "contracts.ts#first");
  writeFileSync(
    path.join(root, "caller.ts"),
    'import { second as next } from "./contracts.js"; export const run = () => next();',
  );
  assert.equal(analyzeCoupling(root, ["caller.ts"]).edges[0].to, "contracts.ts#second");
  writeFileSync(path.join(root, "contracts.ts"), "export const first = () => {};");
  const removed = analyzeCoupling(root, ["caller.ts"]);
  assert.deepEqual(removed.edges, []);
  assert.deepEqual(removed.unresolved, [
    { from: "caller.ts#run", site: { file: "caller.ts", line: 1 }, kind: "calls" },
  ]);
});

test("excludes external dependencies and fails missing inputs and malformed source", (t) => {
  const root = fixture(t, {
    "caller.mjs":
      'import { readFileSync } from "node:fs"; export function run() { readFileSync("unused"); missing(); }',
    "broken.ts": "export function broken( {",
    "dependency.ts": 'import "./broken.js"; export const run = () => {};',
  });
  const result = analyzeCoupling(root, ["caller.mjs"]);
  assert.deepEqual(result.edges, []);
  assert.deepEqual(
    result.unresolved.map(({ kind, site }) => [kind, site.line]),
    [["calls", 1]],
  );
  assert.throws(() => analyzeCoupling(root, ["absent.ts"]));
  assert.throws(() => analyzeCoupling(root, ["broken.ts"]), /broken.ts:1:/);
  assert.throws(() => analyzeCoupling(root, ["dependency.ts"]), /broken.ts:1:/);
});

test("keeps property and constructor owners distinct and rejects non-callable declarations", (t) => {
  const root = fixture(t, {
    "caller.ts": `export const helper = () => {};
export const notCallable = 42;
export class Service {
  constructor() { helper(); }
  handle = () => { helper(); };
}
export const run = (service: Service) => {
  service.handle();
  service["handle"]();
  service.handle.bind(service);
  new Service();
  notCallable();
};
helper();
`,
  });
  const result = analyzeCoupling(root, ["caller.ts"]);
  assert.deepEqual(
    result.edges.map(({ from, kind, to }) => [from, kind, to]),
    [
      ["caller.ts#Service.constructor", "calls", "caller.ts#helper"],
      ["caller.ts#Service.handle", "calls", "caller.ts#helper"],
      ["caller.ts#run", "binds", "caller.ts#Service.handle"],
      ["caller.ts#run", "calls", "caller.ts#Service.handle"],
      ["caller.ts#run", "calls", "caller.ts#Service.handle"],
      ["caller.ts#run", "constructs", "caller.ts#Service"],
    ],
  );
  assert.deepEqual(
    result.unresolved.map(({ from, site }) => [from, site.line]),
    [
      ["caller.ts", 14],
      ["caller.ts#run", 12],
    ],
  );
});

test("nested class implementations cannot satisfy an enclosing class witness", (t) => {
  const root = fixture(t, {
    "caller.ts": `interface Exchange { resolve(): void }
export class Service implements Exchange {
  resolve() {}
}
`,
  });
  const witness = { from: "caller.ts#Service", kind: "implements", to: "caller.ts#Exchange" };
  const matches = () =>
    analyzeCoupling(root, ["caller.ts"]).edges.filter(
      ({ from, kind, to }) => from === witness.from && kind === witness.kind && to === witness.to,
    );
  assert.equal(matches().length, 1);
  // Moving the implementation into a nested class removes the outer class contract.
  writeFileSync(
    path.join(root, "caller.ts"),
    `interface Exchange { resolve(): void }
export class Service {
  static {
    class Nested implements Exchange { resolve() {} }
  }
}
`,
  );
  assert.deepEqual(matches(), []);
  assert.deepEqual(analyzeCoupling(root, ["caller.ts"]).unresolved, [
    { from: "caller.ts", kind: "implements", site: { file: "caller.ts", line: 4 } },
  ]);
});

test("static members cannot satisfy instance witnesses or collide with dotted member names", (t) => {
  const root = fixture(t, {
    "caller.ts": `export const helper = () => {};
export class Service {
  resolve() { helper(); }
  static resolve() { helper(); }
  "static.resolve"() { helper(); }
}
export function run(service: Service) {
  service.resolve();
  service.resolve.bind(service);
}
`,
  });
  const before = analyzeCoupling(root, ["caller.ts"]);
  assert.deepEqual(before.unresolved, []);
  assert.equal(before.edges.filter(({ from }) => from === "caller.ts#run").length, 2);
  // Keep the instance declaration, but replace its callers with static calls/binds.
  writeFileSync(
    path.join(root, "caller.ts"),
    `export const helper = () => {};
export class Service {
  resolve() { helper(); }
  static resolve() { helper(); }
  "static.resolve"() { helper(); }
}
export function run(service: Service) {
  Service.resolve();
  Service.resolve.bind(Service);
  service["static.resolve"]();
}
`,
  );
  const after = analyzeCoupling(root, ["caller.ts"]);
  assert.deepEqual(after.unresolved, []);
  const oldWitnesses = before.edges.filter(({ from }) => from === "caller.ts#run");
  for (const witness of oldWitnesses) {
    assert.ok(
      !after.edges.some(
        ({ from, kind, to }) => from === witness.from && kind === witness.kind && to === witness.to,
      ),
    );
  }
  assert.deepEqual(
    after.edges.map(({ from, kind, to }) => [from, kind, to]),
    [
      ["caller.ts#Service.resolve", "calls", "caller.ts#helper"],
      ["caller.ts#Service.static.resolve", "calls", "caller.ts#helper"],
      ["caller.ts#Service::static.resolve", "calls", "caller.ts#helper"],
      ["caller.ts#run", "binds", "caller.ts#Service::static.resolve"],
      ["caller.ts#run", "calls", "caller.ts#Service.static.resolve"],
      ["caller.ts#run", "calls", "caller.ts#Service::static.resolve"],
    ],
  );
});
