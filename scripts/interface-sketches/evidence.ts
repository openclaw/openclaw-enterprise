import type { CouplingEdge } from "./coupling.ts";
import type { Diagram } from "./diagram.ts";
import { validateDiagram } from "./diagram.ts";
import platformRoles from "./examples/platform-roles.ts";
import currentGit from "./examples/current-git.ts";
import currentGitSetup from "./examples/current-git-setup.ts";
import genericExchange from "./examples/generic-exchange.ts";
import credentialPullProposal from "./examples/credential-pull-proposal.ts";

export type DiagramClassification =
  "contract" | "source-preview" | "conditional-composition" | "proposal";
export type EvidencePointer =
  | { kind: "node"; id: string; title: string; group?: string; groupTitle?: string }
  | { kind: "edge"; from: string; to: string; label: string; edgeKind?: "setup" | "conditional" };
export type RequiredCoupling = Pick<CouplingEdge, "from" | "kind" | "to">;
export interface EvidenceClaim {
  description: string;
  pointer: EvidencePointer;
  required: readonly RequiredCoupling[];
}
export interface EvidenceDiagram {
  id: string;
  source: string;
  classification: DiagramClassification;
  diagram: Diagram;
  claims: readonly EvidenceClaim[];
}

export const staticAnalysisLimits = [
  "Matches establish only compiler-resolved static coupling in the selected source files.",
  "Nested handlers are attributed lexically, not as runtime control flow.",
  "Semantic, dynamic and deployment assertions are not established by static analysis.",
  "No runtime execution, replacement Driver identity, complete reachability, provider contact or formal security verification is established.",
  "Unmapped elements and conditional edges are not automatically verified; proposals remain proposals.",
] as const;

const production = "apps/controller/src/composition/production.ts";
const installation = "apps/controller/src/composition/egress-authority.ts";
const controller = "packages/occ/src/index.ts";
const proxy = "packages/occ/src/credential-proxy.ts";
const exchange = "packages/contracts/src/credential-proxy-exchange.ts";
const listener = "apps/controller/src/drivers/egress-proxy/openshell-authority.ts";
const installed = "packages/occ/src/installed-driver.ts";
const driver = "packages/contracts/src/credential-proxy.ts";
const git = "apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
const gitContract = "packages/contracts/src/protected-repository-git.ts";
const methods = ["resolve", "authorizeSend", "beginResponse", "renewResponse", "protectResponse"];
const coupling = (from: string, kind: CouplingEdge["kind"], to: string): RequiredCoupling => ({
  from,
  kind,
  to,
});
const gitBinding = coupling(
  `${installed}#InstalledDriver.requireRepositoryGitTransport`,
  "binds",
  `${driver}#CredentialProxyDriver.bindRepositoryGit`,
);

/** Explicit claims cover only these source relationships, never whole diagrams. */
export const evidenceCatalog: readonly EvidenceDiagram[] = [
  {
    id: "platform-roles",
    source: "scripts/interface-sketches/examples/platform-roles.ts",
    classification: "contract",
    diagram: platformRoles,
    claims: [
      {
        description:
          "The installed Driver exposes a repository Git method binding; this does not identify a runtime sender.",
        pointer: {
          kind: "edge",
          from: "authority",
          to: "proxy",
          label:
            "For protected Git, the worker supplies the authority\nCredentialProxyDriver.bindRepositoryGit(authority)",
          edgeKind: "setup",
        },
        required: [
          gitBinding,
          coupling(
            "apps/controller/src/composition/repository-credentials/transport.ts#bindRepositoryGitTransport",
            "calls",
            `${installed}#InstalledDriver.requireRepositoryGitTransport`,
          ),
        ],
      },
    ],
  },
  {
    id: "current-git",
    source: "scripts/interface-sketches/examples/current-git.ts",
    classification: "source-preview",
    diagram: currentGit,
    claims: [
      {
        description:
          "The Git adapter contains a typed installation-authority call, distinct from generic exchange calls; an allow or delivery is not proved.",
        pointer: { kind: "edge", from: "adapter", to: "owner", label: "Get local decision" },
        required: [
          coupling(
            `${git}#protectedOpenShellGitOwner`,
            "calls",
            `${gitContract}#GitHubInstallationAuthority.authorize`,
          ),
        ],
      },
    ],
  },
  {
    id: "current-git-setup",
    source: "scripts/interface-sketches/examples/current-git-setup.ts",
    classification: "source-preview",
    diagram: currentGitSetup,
    claims: [
      {
        description:
          "The repository Git binding exists separately from bindExchange; this does not prove provisioning or installation readback.",
        pointer: {
          kind: "edge",
          from: "proxy-driver",
          to: "adapter",
          label: "Binds transport",
          edgeKind: "setup",
        },
        required: [
          gitBinding,
          coupling(
            "apps/controller/src/composition/repository-credentials/transport.ts#bindRepositoryGitTransport",
            "calls",
            `${installed}#InstalledDriver.requireRepositoryGitTransport`,
          ),
        ],
      },
    ],
  },
  {
    id: "generic-exchange",
    source: "scripts/interface-sketches/examples/generic-exchange.ts",
    classification: "conditional-composition",
    diagram: genericExchange,
    claims: [
      {
        description:
          "Production composition calls exchange installation, whose controller factory constructs the concrete CredentialProxy implementing CredentialProxyExchange.",
        pointer: {
          kind: "node",
          id: "exchange",
          title: "OCC exchange authority",
          group: "api",
          groupTitle: "Controller API process",
        },
        required: [
          coupling(
            `${production}#composeProduction`,
            "calls",
            `${installation}#installEgressAuthority`,
          ),
          coupling(
            `${installation}#installEgressAuthority`,
            "calls",
            `${driver}#CredentialProxyDriver.bindExchange`,
          ),
          coupling(
            `${installation}#installEgressAuthority`,
            "calls",
            `${controller}#OpenClawController.createCredentialProxy`,
          ),
          coupling(
            `${controller}#OpenClawController.createCredentialProxy`,
            "constructs",
            `${proxy}#CredentialProxy`,
          ),
          coupling(`${proxy}#CredentialProxy`, "implements", `${exchange}#CredentialProxyExchange`),
        ],
      },
      {
        description:
          "Installation binds five concrete methods and the listener contains five typed contract calls; this is lexical coupling, not execution or authenticated transport proof.",
        pointer: { kind: "edge", from: "listener", to: "exchange", label: "Five bound methods" },
        required: methods.flatMap((method) => [
          coupling(
            `${installation}#installEgressAuthority`,
            "binds",
            `${proxy}#CredentialProxy.${method}`,
          ),
          coupling(
            `${listener}#createOpenShellEgressAuthority`,
            "calls",
            `${exchange}#CredentialProxyExchange.${method}`,
          ),
        ]),
      },
    ],
  },
  {
    id: "credential-pull-proposal",
    source: "scripts/interface-sketches/examples/credential-pull-proposal.ts",
    classification: "proposal",
    diagram: credentialPullProposal,
    claims: [],
  },
];

export const sourceFiles: string[] = [
  ...new Set(
    evidenceCatalog.flatMap((entry) =>
      entry.claims.flatMap((claim) =>
        claim.required.flatMap((edge) => [edge.from.split("#")[0]!, edge.to.split("#")[0]!]),
      ),
    ),
  ),
].sort();

export interface ClaimResult {
  diagram: string;
  description: string;
  pointer: EvidencePointer;
  status: "static-match" | "missing-evidence" | "invalid" | "not-established";
  matches: CouplingEdge[];
  missing: RequiredCoupling[];
}
export interface ElementCoverage {
  pointer: EvidencePointer;
  status: "mapped" | "unmapped" | "not-established";
}
export interface EvidenceResult {
  claims: ClaimResult[];
  problems: string[];
  diagrams: {
    id: string;
    source: string;
    classification: DiagramClassification;
    coverage: ElementCoverage[];
  }[];
  limits: readonly string[];
}

function samePointer(a: EvidencePointer, b: EvidencePointer): boolean {
  if (a.kind === "node" && b.kind === "node") {
    return (
      a.id === b.id && a.title === b.title && a.group === b.group && a.groupTitle === b.groupTitle
    );
  }
  return (
    a.kind === "edge" &&
    b.kind === "edge" &&
    a.from === b.from &&
    a.to === b.to &&
    a.label === b.label &&
    a.edgeKind === b.edgeKind
  );
}
function pointers(diagram: Diagram): EvidencePointer[] {
  return [
    ...diagram.nodes.map((node): EvidencePointer => ({
      kind: "node",
      id: node.id,
      title: node.title,
      group: node.group,
      groupTitle: diagram.groups.find((g) => g.id === node.group)?.title,
    })),
    ...diagram.edges.map((edge): EvidencePointer => ({
      kind: "edge",
      from: edge.from,
      to: edge.to,
      label: edge.label,
      edgeKind: edge.kind,
    })),
  ];
}

/** Configurable for other trusted catalogs. No inference from text, labels or token matches. */
export function verifyClaimCatalog(
  edges: readonly CouplingEdge[],
  catalog: readonly EvidenceDiagram[],
): EvidenceResult {
  const result: EvidenceResult = {
    claims: [],
    problems: [],
    diagrams: [],
    limits: staticAnalysisLimits,
  };
  for (const entry of catalog) {
    let valid = true;
    try {
      validateDiagram(entry.diagram);
      if (catalog.filter((other) => other.id === entry.id).length !== 1) {
        throw new Error("ambiguous diagram id");
      }
    } catch (error) {
      valid = false;
      result.problems.push(`${entry.id}: ${String(error)}`);
    }
    const elements = pointers(entry.diagram);
    for (const claim of entry.claims) {
      const checked: ClaimResult = {
        diagram: entry.id,
        description: claim.description,
        pointer: claim.pointer,
        status: "invalid",
        matches: [],
        missing: [],
      };
      result.claims.push(checked);
      if (
        !valid ||
        elements.filter((pointer) => samePointer(pointer, claim.pointer)).length !== 1
      ) {
        result.problems.push(
          `${entry.id}: stale, missing or ambiguous endpoint for ${claim.description}`,
        );
        continue;
      }
      if (
        entry.classification === "proposal" ||
        (claim.pointer.kind === "edge" && claim.pointer.edgeKind === "conditional")
      ) {
        checked.status = "not-established";
        continue;
      }
      if (claim.required.length === 0) {
        result.problems.push(`${entry.id}: no required compiler edges for ${claim.description}`);
        continue;
      }
      for (const required of claim.required) {
        const matches = edges.filter(
          (edge) =>
            edge.from === required.from && edge.kind === required.kind && edge.to === required.to,
        );
        if (matches.length === 0) {
          checked.missing.push(required);
          result.problems.push(
            `${entry.id}: missing ${required.from} ${required.kind} ${required.to}`,
          );
        } else {
          checked.matches.push(...matches);
        }
      }
      checked.status = checked.missing.length ? "missing-evidence" : "static-match";
      checked.matches.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    result.diagrams.push({
      id: entry.id,
      source: entry.source,
      classification: entry.classification,
      coverage: elements.map((pointer): ElementCoverage => {
        if (
          entry.classification === "proposal" ||
          (pointer.kind === "edge" && pointer.edgeKind === "conditional")
        ) {
          return { pointer, status: "not-established" };
        }
        const mapped = entry.claims.some((claim) => samePointer(pointer, claim.pointer));
        return { pointer, status: mapped ? "mapped" : "unmapped" };
      }),
    });
  }
  result.problems.sort();
  return result;
}

export function verifyEvidence(edges: readonly CouplingEdge[]): EvidenceResult {
  return verifyClaimCatalog(edges, evidenceCatalog);
}

export function formatEvidenceReport(result: EvidenceResult): string {
  const matched = result.claims.filter((claim) => claim.status === "static-match").length;
  return [
    `${matched}/${result.claims.length} explicit static coupling claims matched; ${result.problems.length} problems.`,
    ...result.diagrams.map(
      (entry) =>
        `${entry.id} (${entry.classification}): ${entry.coverage.filter((item) => item.status === "unmapped").length} unmapped elements; ${entry.coverage.filter((item) => item.status === "not-established").length} not established.`,
    ),
    ...result.problems,
    ...result.limits,
  ].join("\n");
}
