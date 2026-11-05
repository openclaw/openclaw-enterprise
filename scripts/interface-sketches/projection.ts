import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CouplingEdge } from "./coupling.ts";
import type { Diagram, Pin } from "./diagram.ts";
import type { EvidenceResult } from "./evidence.ts";
import { compileDiagram } from "./layout.ts";
import { render } from "./render.ts";

export type GraphInput = {
  schemaVersion: number;
  source: unknown;
  scope: unknown;
  files: string[];
  edges: CouplingEdge[];
  unresolved: { from: string; site: { file: string; line: number }; kind: string }[];
  evidence: Partial<EvidenceResult>;
};
export type Selection = { mode: "diagram" | "from"; value: string };
type Site = { from: string; kind: CouplingEdge["kind"]; to: string; file: string; line: number };
const key = (site: Site): string =>
  JSON.stringify([site.from, site.kind, site.to, site.file, site.line]);
const compare = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};
const unique = (values: string[]): string[] => [...new Set(values)].sort(compare);
const sites = (edges: CouplingEdge[]): Site[] => {
  const entries = edges.map(({ from, kind, to, site }) => ({ from, kind, to, ...site }));
  return [...new Map(entries.map((site) => [key(site), site])).values()].sort((a, b) =>
    compare(key(a), key(b)),
  );
};
const declaration = (exact: string): { file: string; name: string } => {
  const hash = exact.indexOf("#");
  if (hash < 1 || hash === exact.length - 1) {
    throw new Error(`Expected an exact file#declaration: ${exact}`);
  }
  return { file: exact.slice(0, hash), name: exact.slice(hash + 1) };
};
// Only unambiguous ordinary member names are grouped; quoted and static names stay exact.
function memberOwner(exact: string): string | undefined {
  const { file, name } = declaration(exact);
  const match = /^([\w$]+)\.([\w$]+)$/.exec(name);
  return match ? `${file}#${match[1]}` : undefined;
}

/** Project trusted graph.ts JSON, without loading source files or executing input. */
type Captions = {
  title: string;
  nodes: Record<string, string>;
  board?: readonly [number, number];
  pins?: Record<string, Pin>;
};
export function project(input: GraphInput, selection: Selection, captions?: Captions) {
  if (input.schemaVersion !== 1) {
    throw new Error("Unsupported graph schemaVersion; expected 1");
  }
  const all = sites(input.edges);
  let selected: Site[];
  let omittedCoverage: unknown[] = [];
  if (selection.mode === "diagram") {
    const entries = input.evidence.diagrams?.filter((entry) => entry.id === selection.value) ?? [];
    if (entries.length !== 1) {
      throw new Error(`Unknown or ambiguous diagram ID: ${selection.value}`);
    }
    const entry = entries[0];
    if (entry.classification === "proposal") {
      throw new Error("Proposal diagrams do not establish static relationships");
    }
    const claims = input.evidence.claims?.filter((claim) => claim.diagram === entry.id) ?? [];
    if (
      input.evidence.problems?.some((problem) => problem.startsWith(`${entry.id}:`)) ||
      claims.some(
        (claim) =>
          claim.status === "invalid" ||
          claim.status === "missing-evidence" ||
          claim.missing.length > 0,
      )
    ) {
      throw new Error(`Failed or missing evidence for diagram: ${entry.id}`);
    }
    const matched = claims.filter((claim) => claim.status === "static-match");
    if (
      matched.some((claim) => claim.matches.length === 0) ||
      entry.coverage.some(
        (item) =>
          item.status === "mapped" &&
          !claims.some((claim) => JSON.stringify(claim.pointer) === JSON.stringify(item.pointer)),
      )
    ) {
      throw new Error(`Missing evidence for diagram: ${entry.id}`);
    }
    selected = sites(matched.flatMap((claim) => claim.matches));
    const actual = new Set(all.map(key));
    if (selected.some((site) => !actual.has(key(site)))) {
      throw new Error(`Evidence is absent from graph edges: ${entry.id}`);
    }
    omittedCoverage = entry.coverage.filter((item) => item.status !== "mapped");
  } else {
    declaration(selection.value);
    selected = all.filter((site) => site.from === selection.value);
  }
  if (selected.length === 0) {
    throw new Error(`No matched relationships for ${selection.mode}: ${selection.value}`);
  }
  const buckets = new Map<string, Site[]>();
  for (const site of selected) {
    const owner = site.kind === "calls" || site.kind === "binds" ? memberOwner(site.to) : undefined;
    const bucket = JSON.stringify([
      site.from,
      site.kind,
      owner ? "members" : "exact",
      owner ?? site.to,
    ]);
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), site]);
  }
  const relationships = [...buckets.values()]
    .map((underlying) => {
      const targets = unique(underlying.map((site) => site.to));
      const grouped = targets.length > 1;
      return {
        from: underlying[0].from,
        to: grouped ? memberOwner(targets[0])! : targets[0],
        kind: underlying[0].kind,
        grouped,
        methodCount: targets.filter((target) => memberOwner(target) !== undefined).length,
        underlying,
      };
    })
    .sort((a, b) =>
      compare(JSON.stringify([a.from, a.kind, a.to]), JSON.stringify([b.from, b.kind, b.to])),
    );
  const identities = unique(relationships.flatMap((edge) => [edge.from, edge.to]));
  if (identities.length > 16 || relationships.length > 20) {
    throw new Error(
      `View too large: ${identities.length} nodes, ${relationships.length} relationships (limits: 16 and 20). Select a narrower declaration or diagram.`,
    );
  }
  const files = unique(identities.map((id) => declaration(id).file));
  const context = (file: string): string => {
    const parts = file.split("/");
    for (let length = 1; length <= parts.length; length++) {
      const suffix = parts.slice(-length).join("/");
      if (files.filter((other) => other === suffix || other.endsWith(`/${suffix}`)).length === 1) {
        return suffix;
      }
    }
    return file;
  };
  if (
    captions &&
    ((captions.pins &&
      (!captions.board || Object.keys(captions.pins).some((id) => !identities.includes(id)))) ||
      typeof captions.title !== "string" ||
      !captions.title.trim() ||
      !captions.nodes ||
      Object.entries(captions.nodes).some(
        ([id, title]) => !identities.includes(id) || typeof title !== "string" || !title.trim(),
      ))
  ) {
    throw new Error("Invalid captions: use a title and labels for declarations in this view");
  }
  const nodes = identities.map((exact, index) => {
    const { file, name } = declaration(exact);
    const title = name.length > 30 && name.includes(".") ? name.replace(".", ".\n") : name;
    const label = context(file);
    const slash = label.lastIndexOf("/");
    const detail =
      slash < 0 || label.length < 27
        ? label
        : `${label.slice(0, slash + 1)}\n${label.slice(slash + 1)}`;
    const caption = captions?.nodes[exact];
    return {
      id: `n${index}`,
      pin: captions?.pins?.[exact],
      title: caption ?? title,
      detail: caption ? name.split(".").at(-1)! : detail,
    };
  });
  const nodeId = (exact: string): string => nodes[identities.indexOf(exact)].id;
  const displayed = relationships.map((edge) => ({
    ...edge,
    displayFrom: nodeId(edge.from),
    displayTo: nodeId(edge.to),
    label: edge.grouped ? `${edge.kind} · ${edge.methodCount} methods` : edge.kind,
  }));
  const owners = new Set(selected.map((site) => site.from));
  const unresolved = input.unresolved
    .filter((site) => owners.has(site.from))
    .sort(
      (a, b) =>
        compare(a.from, b.from) ||
        compare(a.site.file, b.site.file) ||
        a.site.line - b.site.line ||
        compare(a.kind, b.kind),
    );
  const diagram: Diagram = {
    title:
      captions?.title ??
      (selection.mode === "diagram"
        ? `Static relationships · ${selection.value}`
        : `Outgoing relationships · ${declaration(selection.value).name}`),
    subtitle: "Compiler-resolved references in selected source files",
    layout: captions?.board ? { board: captions.board } : undefined,
    groups: [],
    nodes,
    edges: displayed.map((edge) => ({
      from: edge.displayFrom,
      to: edge.displayTo,
      label: edge.label,
    })),
    notes: [
      selection.mode === "from"
        ? `Unresolved sites in this declaration: ${unresolved.length}. Arrows show source references, not execution order.`
        : `Matched claims only. ${omittedCoverage.length} diagram elements outside this view. Arrows do not establish runtime placement.`,
      "Each arrow links back to file and line in the companion .sources.json.",
    ],
  };
  const selectedKeys = new Set(selected.map(key));
  return {
    diagram,
    sources: {
      schemaVersion: 1,
      selection,
      source: input.source,
      scope: input.scope,
      files: unique(input.files),
      limits: input.evidence.limits ?? [],
      grouping:
        "Only calls/binds to distinct ordinary members of the same file-qualified class/interface, for the same exact source and kind. Counts are distinct methods, not call sites. Duplicate exact sites are removed.",
      nodes: nodes.map((node, index) => ({ ...node, declaration: identities[index] })),
      relationships: displayed,
      omissions: {
        unselectedSites: all.length - selectedKeys.size,
        coverage: omittedCoverage.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))),
        unresolvedInShownCallers: unresolved,
        unresolvedElsewhere: input.unresolved.length - unresolved.length,
        explanation:
          "Only the selected matched claims or exact outgoing edges are shown. Unresolved sites and unselected edges are not inferred. No selected sites are truncated.",
      },
    },
  };
}

async function main(args: string[]): Promise<void> {
  const [path, flag, value, prefix, option, captionsPath] = args;
  if (
    (args.length !== 4 && !(args.length === 6 && option === "--captions" && captionsPath)) ||
    (flag !== "--diagram" && flag !== "--from") ||
    !value ||
    !prefix
  ) {
    throw new Error(
      "Usage: node projection.ts GRAPH.json (--diagram ID | --from EXACT_DECLARATION) PREFIX [--captions FILE]",
    );
  }
  const input = JSON.parse(await readFile(path, "utf8")) as GraphInput;
  const { diagram, sources } = project(
    input,
    {
      mode: flag === "--diagram" ? "diagram" : "from",
      value,
    },
    captionsPath ? (JSON.parse(await readFile(captionsPath, "utf8")) as Captions) : undefined,
  );
  const scene = await compileDiagram(diagram);
  if (scene.width > 1920 || scene.height > 1200) {
    throw new Error(
      `View too large for readable display: ${scene.width}×${scene.height} (limit 1920×1200). Select a narrower view.`,
    );
  }
  const { png } = await render(scene);
  const json = JSON.stringify(scene, null, 2) + "\n";
  const provenance = JSON.stringify(sources, null, 2) + "\n";
  // Selection, layout and rendering must all succeed before any output is written.
  await writeFile(`${prefix}.png`, png);
  await writeFile(`${prefix}.json`, json);
  await writeFile(`${prefix}.sources.json`, provenance);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Projection failed");
    process.exitCode = 1;
  });
}
