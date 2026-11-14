#!/usr/bin/env node

import type { decideAdmission } from "./full-integration-admission.ts";

export const fullIntegrationLanes = Object.freeze([
  "qa-matrix",
  "docker-model",
  "k3d-model",
  "gateway-routing",
  "production-tui",
  "slack",
  "openshell",
  "helper-timeout",
  "dev-up-k3d",
  "skipper-prepared-git-installed",
  "logging-collector",
  "k3d-otel",
  "all",
] as const);

type FullIntegrationLane = (typeof fullIntegrationLanes)[number];
type ScheduleSkipReason = Extract<ReturnType<typeof decideAdmission>, { result: "skip" }>["reason"];
type PreflightResult =
  | { selectedLane: "all"; runAll: true }
  | { selectedLane: Exclude<FullIntegrationLane, "all"> | "docs"; runAll: false }
  | { selectedLane: "skip"; runAll: false; reason: ScheduleSkipReason };

type LaneInput = {
  eventName?: string | undefined;
  inputLane?: string | undefined;
  ref?: string | undefined;
  impactMode?: string;
};

type GithubRequest = {
  repository: string | undefined;
  token: string | undefined;
  path: string;
};

export type GithubReader = (request: GithubRequest) => Promise<unknown>;

type PreflightInput = {
  env?: NodeJS.ProcessEnv;
  github?: GithubReader;
  impactMode?: string;
};

const lanes = new Set<string | undefined>(fullIntegrationLanes);
const repository = "openclaw/openclaw-enterprise";
const approvalEnvironment = "integration-main-approval";
const approvalEnvironmentId = 26285522718;
const approvedTeamId = 19674117;
const credentialedLanes = new Set<FullIntegrationLane>([
  "qa-matrix",
  "docker-model",
  "k3d-model",
  "production-tui",
  "k3d-otel",
  "gateway-routing",
  "slack",
  "openshell",
]);

export function selectLane({ eventName, inputLane, ref, impactMode = "full" }: LaneInput) {
  if (eventName === "push" && ref === "refs/heads/main") {
    return impactMode === "docs" ? "docs" : "all";
  }
  if (eventName === "schedule" && ref === "refs/heads/main") {
    return "all";
  }
  if (eventName === "workflow_dispatch") {
    return inputLane;
  }
  throw new Error(`Unsupported full integration event: ${eventName}`);
}

export function assertSourceRef(ref: string | undefined) {
  if (ref !== "refs/heads/main") {
    throw new Error("Full integration must run from main at the approved github.sha.");
  }
}

function assertRunContext(env: NodeJS.ProcessEnv) {
  assertSourceRef(env.GITHUB_REF);
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF_TYPE !== "branch") {
    throw new Error("Full integration requires this repository and the main branch.");
  }
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_RUN_ATTEMPT !== "1") {
    throw new Error("Manual integration reruns are refused; start a new approved dispatch.");
  }
  if (env.GITHUB_EVENT_NAME === "schedule" && env.GITHUB_RUN_ATTEMPT !== "1") {
    throw new Error("Scheduled integration reruns are refused; start a new approved dispatch.");
  }
}

function assertLane(selected: string | undefined): asserts selected is FullIntegrationLane {
  if (!lanes.has(selected)) {
    throw new Error(`Unknown lane: ${selected}`);
  }
}

function environmentsForLane(selected: FullIntegrationLane | "docs") {
  return selected === "all" || selected === "docs" || credentialedLanes.has(selected)
    ? ["integration-main"]
    : [];
}

export function requiredEnvironmentsForLane(selected: string | undefined) {
  assertLane(selected);
  return environmentsForLane(selected);
}

// Read API fields at the point the policy uses them. Missing objects and
// malformed arrays must fail in the same order as the policy checks.
function field(value: unknown, name: string | number): unknown {
  if (value == null) {
    throw new TypeError(`Cannot read properties of ${value} (reading '${name}')`);
  }
  return Reflect.get(Object(value), String(name));
}

function optionalField(value: unknown, name: string | number): unknown {
  return value == null ? undefined : field(value, name);
}

function array(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function assertMainOnlyPolicy(environmentName: string, environment: unknown, policies: unknown) {
  if (field(environment, "can_admins_bypass") !== false) {
    throw new Error(`Protected environment ${environmentName} must disable administrator bypass.`);
  }
  const policy = field(environment, "deployment_branch_policy");
  if (
    optionalField(policy, "custom_branch_policies") !== true ||
    optionalField(policy, "protected_branches") !== false
  ) {
    throw new Error(`Protected environment ${environmentName} must use custom main-only policy.`);
  }
  const branches = optionalField(policies, "branch_policies") ?? [];
  if (
    optionalField(policies, "total_count") !== 1 ||
    field(branches, "length") !== 1 ||
    optionalField(field(branches, 0), "name") !== "main" ||
    optionalField(field(branches, 0), "type") !== "branch"
  ) {
    throw new Error(`Protected environment ${environmentName} must allow only the main branch.`);
  }
}

export function validateEnvironmentPolicy(
  environmentName: string,
  environment: unknown,
  policies: unknown,
) {
  const rules = field(environment, "protection_rules");
  if (rules != null && !array(rules)) {
    throw new TypeError("environment.protection_rules?.find is not a function");
  }
  const reviewers = rules?.find((rule) => field(rule, "type") === "required_reviewers");
  if (Number(field(optionalField(reviewers, "reviewers") ?? [], "length")) > 0) {
    throw new Error(`Protected environment ${environmentName} must not require reviewers.`);
  }
  assertMainOnlyPolicy(environmentName, environment, policies);
}

function positiveId(value: string | undefined) {
  return (
    typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
  );
}

function hasApprovedTeam(rule: unknown) {
  if (field(rule, "prevent_self_review") !== false) {
    return false;
  }
  const reviewers = field(rule, "reviewers");
  if (optionalField(reviewers, "length") !== 1) {
    return false;
  }
  const reviewer = field(reviewers, 0);
  return (
    optionalField(reviewer, "type") === "Team" &&
    optionalField(field(reviewer, "reviewer"), "id") === approvedTeamId
  );
}

async function validateManualApproval(env: NodeJS.ProcessEnv, github: GithubReader) {
  if (
    !positiveId(env.GITHUB_ACTOR_ID) ||
    !positiveId(env.GITHUB_RUN_ID) ||
    !env.GITHUB_ACTOR ||
    !env.GITHUB_TRIGGERING_ACTOR ||
    env.GITHUB_ACTOR.toLowerCase() !== env.GITHUB_TRIGGERING_ACTOR.toLowerCase()
  ) {
    throw new Error(
      "Manual integration requires the same identified dispatcher and triggering actor.",
    );
  }
  const read = (path: string) => github({ repository, token: env.GITHUB_TOKEN, path });
  const environment = await read(`/environments/${approvalEnvironment}`);
  const policies = await read(`/environments/${approvalEnvironment}/deployment-branch-policies`);
  assertMainOnlyPolicy(approvalEnvironment, environment, policies);
  const protectionRules = field(environment, "protection_rules");
  if (protectionRules != null && !array(protectionRules)) {
    throw new TypeError("environment.protection_rules?.filter is not a function");
  }
  const rules = protectionRules?.filter((rule) => field(rule, "type") === "required_reviewers");
  if (
    field(environment, "id") !== approvalEnvironmentId ||
    field(environment, "name") !== approvalEnvironment ||
    rules?.length !== 1 ||
    !hasApprovedTeam(rules[0])
  ) {
    throw new Error(
      "Manual integration approval must use only the configured team and environment.",
    );
  }
  const reviews = await read(`/actions/runs/${env.GITHUB_RUN_ID}/approvals`);
  if (!array(reviews)) {
    throw new Error("Manual integration approval history is unavailable.");
  }
  const targeted = reviews.flatMap((review) => {
    const environments = field(review, "environments");
    if (environments == null) {
      return [];
    }
    if (!array(environments)) {
      throw new TypeError("review.environments?.some is not a function");
    }
    return environments.some((item) => field(item, "id") === approvalEnvironmentId)
      ? [{ review, environments }]
      : [];
  });
  const [target] = targeted;
  if (
    targeted.length !== 1 ||
    !target ||
    field(target.review, "state") !== "approved" ||
    !target.environments.some(
      (item) =>
        field(item, "id") === approvalEnvironmentId && field(item, "name") === approvalEnvironment,
    ) ||
    !matchesDispatcher(field(target.review, "user"), Number(env.GITHUB_ACTOR_ID), env.GITHUB_ACTOR)
  ) {
    throw new Error("Manual integration requires this dispatcher's approved environment review.");
  }
}

function matchesDispatcher(user: unknown, actorId: number, actor: string) {
  if (optionalField(user, "id") !== actorId || optionalField(user, "type") !== "User") {
    return false;
  }
  const login = field(user, "login");
  return typeof login === "string" && login.toLowerCase() === actor.toLowerCase();
}

async function fetchGithubJson({ repository, token, path }: GithubRequest): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "openclaw-enterprise-full-integration",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} returned ${response.status}.`);
  }
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    // An unreadable JSON value is invalid metadata, not a failed request.
    // Discard parser text and response bytes before the caller diagnoses it.
    return null;
  }
}

export async function validateFullIntegrationPreflight({
  env = process.env,
  github = fetchGithubJson,
  impactMode = "full",
}: PreflightInput = {}): Promise<PreflightResult> {
  assertRunContext(env);
  const read = (path: string) =>
    github({ repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, path });
  const scheduled = env.GITHUB_EVENT_NAME === "schedule";
  if (scheduled) {
    const { decideAdmission } = await import("./full-integration-admission.ts");
    const { readScheduleHistory } = await import("./full-integration-schedule-history.ts");
    const now = Date.now();
    const eventSha = env.GITHUB_SHA ?? "";
    const history = await readScheduleHistory(read, eventSha, Number(env.GITHUB_RUN_ID), now);
    const decision = decideAdmission({ ...history, now, eventSha });
    if (decision.result === "hold") {
      const failure = "failure" in history ? history.failure : undefined;
      const detail = failure ? ` (${failure.operation}: ${failure.kind})` : "";
      throw new Error(`Full Integration schedule could not verify admission metadata${detail}.`);
    }
    if (decision.result === "skip") {
      return { selectedLane: "skip", runAll: false, reason: decision.reason };
    }
  }
  const selected = selectLane({
    eventName: env.GITHUB_EVENT_NAME,
    inputLane: env.INPUT_LANE,
    ref: env.GITHUB_REF,
    impactMode,
  });
  // Validate selection before any authorization or protected-environment reads.
  if (selected !== "docs") {
    assertLane(selected);
  }
  const required = environmentsForLane(selected);
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    await validateManualApproval(env, github);
  }
  for (const environmentName of required) {
    const environment = await github({
      repository: env.GITHUB_REPOSITORY,
      token: env.GITHUB_TOKEN,
      path: `/environments/${environmentName}`,
    });
    const policies = await github({
      repository: env.GITHUB_REPOSITORY,
      token: env.GITHUB_TOKEN,
      path: `/environments/${environmentName}/deployment-branch-policies`,
    });
    validateEnvironmentPolicy(environmentName, environment, policies);
  }
  if (scheduled) {
    const current = await read("/git/ref/heads/main");
    const object =
      optionalField(current, "ref") === "refs/heads/main" ? field(current, "object") : undefined;
    const currentSha =
      optionalField(object, "type") === "commit" ? field(object, "sha") : undefined;
    if (!/^[0-9a-f]{40}$/.test(String(currentSha ?? ""))) {
      throw new Error("Full Integration schedule could not verify the current main revision.");
    }
    if (currentSha !== env.GITHUB_SHA) {
      return { selectedLane: "skip", runAll: false, reason: "stale-event" };
    }
  }
  return selected === "all"
    ? { selectedLane: selected, runAll: true }
    : { selectedLane: selected, runAll: false };
}

async function main() {
  const result = await validateFullIntegrationPreflight();
  if (result.selectedLane === "skip") {
    const message = `Full Integration schedule skipped: ${result.reason}.`;
    console.log(
      process.env.GITHUB_ACTIONS === "true"
        ? `::notice title=Full Integration schedule::${message}`
        : message,
    );
  } else {
    console.log(
      process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
        ? "Full Integration authorized by the dispatcher's required team approval."
        : "Full Integration authorized by scheduled admission.",
    );
  }
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `selected_lane=${result.selectedLane}\nrun_all=${result.runAll}\n`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(field(error, "message"));
    process.exit(1);
  });
}
