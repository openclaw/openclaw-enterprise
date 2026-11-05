import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { project } from "./projection.ts";
import type { GraphInput } from "./projection.ts";
import type { CouplingEdge } from "./coupling.ts";

const edge = (to: string, line = 1, from = "src/main.ts#start"): CouplingEdge => ({
  from,
  to,
  kind: "calls",
  site: { file: "src/main.ts", line },
});
function graph(edges: CouplingEdge[]): GraphInput {
  return {
    schemaVersion: 1,
    source: { state: "working-tree", commit: null },
    scope: { analysis: "static" },
    files: ["src/main.ts"],
    edges,
    unresolved: [],
    evidence: {
      diagrams: [
        { id: "sample", source: "sample.ts", classification: "source-preview", coverage: [] },
      ],
      claims: [
        {
          diagram: "sample",
          description: "Calls",
          pointer: { kind: "node", id: "source", title: "Source" },
          status: "static-match",
          matches: edges,
          missing: [],
        },
      ],
      problems: [],
    },
  };
}
const selection = { mode: "diagram", value: "sample" } as const;

test("exact identities keep ambiguous names separate and from selection ignores the catalog", () => {
  const input = graph([
    edge("a/api.ts#Service.run"),
    edge("b/api.ts#Service.run"),
    edge("a/api.ts#Service.stop", 3, "elsewhere.ts#start"),
  ]);
  input.evidence = {};
  const result = project(input, { mode: "from", value: "src/main.ts#start" });
  assert.equal(result.diagram.nodes.length, 3);
  assert.deepEqual(
    result.diagram.nodes.filter((node) => node.title === "Service.run").map((node) => node.detail),
    ["a/api.ts", "b/api.ts"],
  );
  assert.equal(result.sources.omissions.unselectedSites, 1);
  assert.throws(() => project(input, { mode: "from", value: "start" }), /exact/);
});

test("grouped method counts preserve every exact site and deduplicate overlapping claims", () => {
  const first = edge("api.ts#Service.run");
  const input = graph([
    first,
    first,
    edge("api.ts#Service.run", 2),
    edge("api.ts#Service.stop", 3),
  ]);
  const result = project(input, selection);
  assert.equal(result.diagram.edges[0].label, "calls · 2 methods");
  assert.deepEqual(result.sources.relationships[0].underlying, [
    {
      from: "src/main.ts#start",
      kind: "calls",
      to: "api.ts#Service.run",
      file: "src/main.ts",
      line: 1,
    },
    {
      from: "src/main.ts#start",
      kind: "calls",
      to: "api.ts#Service.run",
      file: "src/main.ts",
      line: 2,
    },
    {
      from: "src/main.ts#start",
      kind: "calls",
      to: "api.ts#Service.stop",
      file: "src/main.ts",
      line: 3,
    },
  ]);
  input.edges.reverse();
  assert.deepEqual(project(input, selection), result);
});

test("reject proposals, unknown IDs, empty matches, failed evidence and absent graph sites", () => {
  const input = graph([edge("api.ts#run")]);
  assert.throws(() => project(input, { ...selection, value: "unknown" }), /Unknown/);
  input.evidence.diagrams![0].classification = "proposal";
  assert.throws(() => project(input, selection), /Proposal/);
  input.evidence.diagrams![0].classification = "source-preview";
  input.evidence.claims![0].status = "missing-evidence";
  assert.throws(() => project(input, selection), /missing evidence/);
  input.evidence.claims![0].status = "static-match";
  input.edges = [];
  assert.throws(() => project(input, selection), /absent/);
  input.evidence.claims![0].matches = [];
  assert.throws(() => project(input, selection), /Missing evidence/);
  input.evidence.claims = [];
  assert.throws(() => project(input, selection), /No matched/);
});

test("large views are rejected without truncation", () => {
  assert.throws(
    () =>
      project(graph(Array.from({ length: 17 }, (_, i) => edge(`api.ts#function${i}`))), selection),
    /View too large/,
  );
});

test("CLI renders JSON input and fails before writing for invalid selections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "projection-test-"));
  try {
    const path = join(directory, "graph.json");
    const prefix = join(directory, "view");
    await writeFile(path, JSON.stringify(graph([edge("api.ts#run")])));
    const run = (id: string) =>
      spawnSync(
        process.execPath,
        [new URL("./projection.ts", import.meta.url).pathname, path, "--diagram", id, prefix],
        { encoding: "utf8" },
      );
    assert.notEqual(run("missing").status, 0);
    assert.deepEqual(await readdir(directory), ["graph.json"]);
    const success = run("sample");
    assert.equal(success.status, 0, success.stderr);
    assert.equal((await readFile(`${prefix}.png`)).subarray(1, 4).toString(), "PNG");
    const scene = JSON.parse(await readFile(`${prefix}.json`, "utf8"));
    assert.ok(scene.width <= 1920 && scene.height <= 1200);
    const sources = JSON.parse(await readFile(`${prefix}.sources.json`, "utf8"));
    assert.equal(sources.relationships[0].underlying[0].to, "api.ts#run");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("captions can rename an observed declaration but cannot add one", () => {
  const input = graph([edge("api.ts#run")]);
  const original = project(input, selection);
  const captioned = project(input, selection, {
    title: "Which API?",
    nodes: { "api.ts#run": "Selected API" },
  });
  assert.equal(captioned.diagram.title, "Which API?");
  assert.ok(captioned.diagram.nodes.some((node) => node.title === "Selected API"));
  assert.deepEqual(captioned.sources.relationships, original.sources.relationships);
  assert.throws(
    () =>
      project(input, selection, { title: "Bad", nodes: { "api.ts#invented": "Not in source" } }),
    /Invalid captions/,
  );
});
