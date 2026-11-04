#!/usr/bin/env node

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
]);

const lanes = new Set(fullIntegrationLanes);
const branchEligibleLanes = new Set(["dev-up-k3d", "skipper-prepared-git-installed"]);
// TODO: Remove the cutover push route after integration-main verification is complete.
const cutoverRef = "refs/heads/dev/kevinlin/integration-main-cutover";
const credentialedLanes = new Set([
  "qa-matrix",
  "docker-model",
  "k3d-model",
  "production-tui",
  "k3d-otel",
  "gateway-routing",
  "slack",
  "openshell",
]);

export function selectLane({ eventName, inputLane, ref, repositoryFixture }) {
  if (eventName === "workflow_dispatch") {
    if (ref === cutoverRef && (inputLane !== "qa-matrix" || repositoryFixture !== "isolated")) {
      throw new Error("Cutover branch dispatch must select qa-matrix with the isolated fixture.");
    }
    return inputLane;
  }
  if (eventName === "push" && ref === cutoverRef) {
    return "all";
  }
  throw new Error(`Unsupported full integration event: ${eventName}`);
}

export function assertSourceRef(ref, lane, eventName = "workflow_dispatch", repositoryFixture) {
  if (eventName === "push" && ref === cutoverRef) {
    return;
  }
  if (
    eventName === "workflow_dispatch" &&
    ref === cutoverRef &&
    lane === "qa-matrix" &&
    repositoryFixture === "isolated"
  ) {
    return;
  }
  if (
    eventName === "workflow_dispatch" &&
    branchEligibleLanes.has(lane) &&
    /^refs\/heads\/.+/.test(ref ?? "")
  ) {
    return;
  }
  if (ref !== "refs/heads/main") {
    throw new Error("Full integration must run from main or the exact cutover push ref.");
  }
}

export function requiredEnvironmentsForLane(selected) {
  if (!lanes.has(selected)) {
    throw new Error(`Unknown lane: ${selected}`);
  }
  return selected === "all" || credentialedLanes.has(selected) ? ["integration-main"] : [];
}

function requiredReviewersRule(environment) {
  return environment.protection_rules?.find((rule) => rule.type === "required_reviewers");
}

function branchPolicies(policies) {
  return policies?.branch_policies ?? [];
}

export function validateEnvironmentPolicy(
  environmentName,
  environment,
  policies,
  sourceRef = "refs/heads/main",
) {
  const reviewers = requiredReviewersRule(environment);
  if ((reviewers?.reviewers ?? []).length > 0) {
    throw new Error(`Protected environment ${environmentName} must not require reviewers.`);
  }
  if (environment.can_admins_bypass !== undefined && environment.can_admins_bypass !== false) {
    throw new Error(`Protected environment ${environmentName} must disable administrator bypass.`);
  }
  const policy = environment.deployment_branch_policy;
  if (policy?.custom_branch_policies !== true || policy?.protected_branches !== false) {
    throw new Error(
      `Protected environment ${environmentName} must use custom deployment branch rules.`,
    );
  }
  const allowed =
    sourceRef === cutoverRef ? ["main", cutoverRef.slice("refs/heads/".length)] : ["main"];
  const branches = branchPolicies(policies);
  if (
    policies?.total_count !== branches.length ||
    branches.length !== allowed.length ||
    !allowed.every((name) =>
      branches.some((branch) => branch.name === name && branch.type === "branch"),
    )
  ) {
    throw new Error(
      `Protected environment ${environmentName} must allow only the selected main or cutover branch policy.`,
    );
  }
}

async function fetchGithubJson({ repository, token, path }) {
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
  return response.json();
}

export async function validateFullIntegrationPreflight({
  env = process.env,
  github = fetchGithubJson,
} = {}) {
  if (env.GITHUB_REF === cutoverRef) {
    if (
      env.GITHUB_REPOSITORY !== "openclaw/openclaw-enterprise" ||
      env.GITHUB_ACTOR !== "kevinlin-openai" ||
      env.GITHUB_TRIGGERING_ACTOR !== "kevinlin-openai"
    ) {
      throw new Error("Cutover proof requires the approved repository, actor and rerun actor.");
    }
  }
  const selected = selectLane({
    eventName: env.GITHUB_EVENT_NAME,
    inputLane: env.INPUT_LANE,
    ref: env.GITHUB_REF,
    repositoryFixture: env.INPUT_QA_REPOSITORY_FIXTURE,
  });
  assertSourceRef(env.GITHUB_REF, selected, env.GITHUB_EVENT_NAME, env.INPUT_QA_REPOSITORY_FIXTURE);
  const required = requiredEnvironmentsForLane(selected);
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
    validateEnvironmentPolicy(environmentName, environment, policies, env.GITHUB_REF);
  }
  return { selectedLane: selected, runAll: selected === "all" };
}

async function main() {
  const result = await validateFullIntegrationPreflight();
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `selected_lane=${result.selectedLane}\nrun_all=${result.runAll}\n`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
