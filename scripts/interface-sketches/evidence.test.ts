import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { CouplingEdge } from "./coupling.ts";
import type { EvidenceDiagram } from "./evidence.ts";
import {
  evidenceCatalog,
  formatEvidenceReport,
  sourceFiles,
  verifyClaimCatalog,
  verifyEvidence,
} from "./evidence.ts";

const edge: CouplingEdge = {
  from: "src/caller.ts#caller",
  kind: "calls",
  to: "src/target.ts#target",
  site: { file: "src/caller.ts", line: 8 },
};
function catalog(): EvidenceDiagram[] {
  return [
    {
      id: "example",
      source: "examples/example.ts",
      classification: "conditional-composition",
      diagram: {
        title: "Example",
        groups: [],
        nodes: [
          { id: "caller", title: "Caller" },
          { id: "target", title: "Target" },
          { id: "other", title: "Other" },
        ],
        edges: [{ from: "caller", to: "target", label: "Calls" }],
      },
      claims: [
        {
          description: "One static call",
          pointer: { kind: "edge", from: "caller", to: "target", label: "Calls" },
          required: [{ from: edge.from, kind: "calls", to: edge.to }],
        },
      ],
    },
  ];
}

test("requires the exact directed compiler relationship and retains its source site", () => {
  const result = verifyClaimCatalog([edge], catalog());
  assert.deepEqual(result.problems, []);
  assert.equal(result.claims[0]!.status, "static-match");
  assert.deepEqual(result.claims[0]!.matches[0]!.site, { file: "src/caller.ts", line: 8 });
  for (const changed of [
    [],
    [{ ...edge, to: "src/other.ts#target" }],
    [{ ...edge, from: edge.to, to: edge.from }],
    [{ ...edge, kind: "binds" as const }],
  ]) {
    const failed = verifyClaimCatalog(changed, catalog());
    assert.equal(failed.claims[0]!.status, "missing-evidence");
    assert.equal(failed.problems.length, 1);
  }
  assert.equal(result.diagrams[0]!.coverage.filter((item) => item.status === "unmapped").length, 3);
});

test("stale labels, redirected endpoints, duplicate edges and missing nodes cannot pass", () => {
  for (const mutate of [
    (entry: EvidenceDiagram) => {
      entry.diagram.edges = [{ from: "caller", to: "target", label: "Changed" }];
    },
    (entry: EvidenceDiagram) => {
      entry.diagram.edges = [{ from: "caller", to: "other", label: "Calls" }];
    },
    (entry: EvidenceDiagram) => {
      entry.diagram.edges = [...entry.diagram.edges, ...entry.diagram.edges];
    },
    (entry: EvidenceDiagram) => {
      entry.diagram.nodes = entry.diagram.nodes.filter((node) => node.id !== "target");
    },
    (entry: EvidenceDiagram) => {
      entry.diagram.nodes = [...entry.diagram.nodes, { id: "caller", title: "Duplicate" }];
    },
  ]) {
    const selected = catalog();
    mutate(selected[0]!);
    const result = verifyClaimCatalog([edge], selected);
    assert.equal(result.claims[0]!.status, "invalid");
    assert.ok(result.problems.length > 0);
  }
});

test("proposal and conditional assertions remain unestablished even with matching compiler edges", () => {
  const proposal = catalog();
  proposal[0]!.classification = "proposal";
  const result = verifyClaimCatalog([edge], proposal);
  assert.equal(result.claims[0]!.status, "not-established");
  assert.ok(result.diagrams[0]!.coverage.every((item) => item.status === "not-established"));
  const conditional = catalog();
  conditional[0]!.diagram.edges = [
    { from: "caller", to: "target", label: "Calls", kind: "conditional" },
  ];
  conditional[0]!.claims = [
    {
      ...conditional[0]!.claims[0]!,
      pointer: {
        kind: "edge",
        from: "caller",
        to: "target",
        label: "Calls",
        edgeKind: "conditional",
      },
    },
  ];
  assert.equal(verifyClaimCatalog([edge], conditional).claims[0]!.status, "not-established");
});

test("node evidence requires a current unique pointer and a nonempty witness set", () => {
  const selected = catalog();
  selected[0]!.claims = [
    {
      ...selected[0]!.claims[0]!,
      pointer: { kind: "node", id: "caller", title: "Caller" },
    },
  ];
  assert.equal(verifyClaimCatalog([edge], selected).claims[0]!.status, "static-match");
  selected[0]!.diagram.nodes = [
    { id: "caller", title: "Renamed" },
    { id: "target", title: "Target" },
  ];
  assert.equal(verifyClaimCatalog([edge], selected).claims[0]!.status, "invalid");
  const empty = catalog();
  empty[0]!.claims = [{ ...empty[0]!.claims[0]!, required: [] }];
  assert.equal(verifyClaimCatalog([edge], empty).claims[0]!.status, "invalid");
  const ambiguous = catalog();
  assert.ok(
    verifyClaimCatalog([edge], [...ambiguous, ...ambiguous]).claims.every(
      (claim) => claim.status === "invalid",
    ),
  );
});

test("all five trusted diagrams expose coverage and bounded report language", () => {
  const result = verifyEvidence([]);
  assert.deepEqual(
    result.diagrams.map(({ id, classification }) => [id, classification]),
    [
      ["platform-roles", "contract"],
      ["current-git", "source-preview"],
      ["current-git-setup", "source-preview"],
      ["generic-exchange", "conditional-composition"],
      ["credential-pull-proposal", "proposal"],
    ],
  );
  for (const entry of evidenceCatalog) {
    const coverage = result.diagrams.find((item) => item.id === entry.id)!;
    assert.equal(coverage.coverage.length, entry.diagram.nodes.length + entry.diagram.edges.length);
  }
  assert.match(formatEvidenceReport(result), /unmapped elements/);
  assert.match(formatEvidenceReport(result), /No runtime execution/);
  assert.ok(result.claims.every((claim) => claim.status === "missing-evidence"));
  assert.ok(sourceFiles.every((file) => !file.startsWith("/") && !file.includes("node_modules")));
});

test("repository sources support the catalog, and removing or redirecting any witness fails", async () => {
  const { analyzeCoupling } = await import("./coupling.ts");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const graph = analyzeCoupling(root, sourceFiles);
  const result = verifyEvidence(graph.edges);
  assert.deepEqual(result.problems, []);
  assert.ok(result.claims.every((claim) => claim.status === "static-match"));
  // Each requirement is a necessary witness. Other edges cannot substitute for it.
  for (const entry of evidenceCatalog) {
    for (const claim of entry.claims) {
      for (const witness of claim.required) {
        const same = (candidate: CouplingEdge) =>
          candidate.from === witness.from &&
          candidate.kind === witness.kind &&
          candidate.to === witness.to;
        const removed = verifyEvidence(graph.edges.filter((candidate) => !same(candidate)));
        assert.ok(removed.problems.length > 0, `removed ${witness.to}`);
        const redirected = verifyEvidence(
          graph.edges.map((candidate) =>
            same(candidate) ? { ...candidate, to: "src/unrelated.ts#unrelated" } : candidate,
          ),
        );
        assert.ok(redirected.problems.length > 0, `redirected ${witness.to}`);
      }
    }
  }
});
