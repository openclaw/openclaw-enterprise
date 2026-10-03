#!/usr/bin/env node

export const fullIntegrationLanes = Object.freeze([
  "qa-matrix",
  "docker-model",
  "k3d-model",
  "gateway-routing",
  "production-tui",
  "slack",
  "provider-account",
  "openshell",
  "helper-timeout",
  "logging-collector",
  "k3d-otel",
  "all",
]);

const lanes = new Set(fullIntegrationLanes);
// TODO: include qa-matrix in `all` once the protected integration-qa
// environment and its QA secrets exist; until then only an explicit qa-matrix
// dispatch requires it, so `all` keeps passing preflight.
const explicitOnlyLanes = new Set(["qa-matrix"]);
const providerAccountEnvironment = "integration-provider-account";
const laneEnvironments = Object.freeze({
  "qa-matrix": "integration-qa",
  "docker-model": "integration-model",
  "k3d-model": "integration-model",
  "production-tui": "integration-model",
  "k3d-otel": "integration-otel",
  "gateway-routing": "integration-routing",
  slack: "integration-slack",
  "provider-account": providerAccountEnvironment,
  openshell: "integration-openshell",
});

export function selectLane({ eventName, inputLane }) {
  if (eventName === "workflow_dispatch") {
    return inputLane;
  }
  throw new Error(`Unsupported full integration event: ${eventName}`);
}

export function assertSourceRef(ref, lane) {
  if (lane === "k3d-model" && /^refs\/heads\/.+/.test(ref ?? "")) {
    return;
  }
  if (ref !== "refs/heads/main") {
    throw new Error("Full integration must run from main at the approved github.sha.");
  }
}

export function requiredEnvironmentsForLane(selected) {
  if (!lanes.has(selected)) {
    throw new Error(`Unknown lane: ${selected}`);
  }
  return [
    ...new Set(
      Object.entries(laneEnvironments)
        .filter(
          ([lane]) => (selected === "all" && !explicitOnlyLanes.has(lane)) || selected === lane,
        )
        .map(([, environment]) => environment),
    ),
  ];
}

function requiredReviewersRule(environment) {
  return environment.protection_rules?.find((rule) => rule.type === "required_reviewers");
}

function branchPolicies(policies) {
  return policies?.branch_policies ?? [];
}

function hasMainBranchPolicy(policies) {
  return branchPolicies(policies).some((branch) => branch.name === "main");
}

function assertCustomMainOnlyPolicy(environmentName, environment, policies) {
  const policy = environment.deployment_branch_policy;
  if (policy?.custom_branch_policies !== true || policy?.protected_branches !== false) {
    throw new Error(`Protected environment ${environmentName} must use custom main-only policy.`);
  }
  const branches = branchPolicies(policies);
  if (
    policies?.total_count !== branches.length ||
    branches.length !== 1 ||
    branches[0]?.name !== "main" ||
    branches[0]?.type !== "branch"
  ) {
    throw new Error(`Protected environment ${environmentName} must allow only the main branch.`);
  }
}

export function validateEnvironmentPolicy(environmentName, environment, policies) {
  if (environmentName === providerAccountEnvironment) {
    const reviewers = requiredReviewersRule(environment);
    if ((reviewers?.reviewers ?? []).length > 0) {
      throw new Error(`Protected environment ${environmentName} must not require reviewers.`);
    }
    assertCustomMainOnlyPolicy(environmentName, environment, policies);
    return;
  }

  const requiredReviewers = requiredReviewersRule(environment);
  if (!requiredReviewers) {
    throw new Error(`Protected environment ${environmentName} has no required reviewers.`);
  }
  if (requiredReviewers.prevent_self_review !== true) {
    throw new Error(`Protected environment ${environmentName} does not prevent self-review.`);
  }
  const policy = environment.deployment_branch_policy;
  if (policy?.protected_branches === true) {
    return;
  }
  if (policy?.custom_branch_policies !== true) {
    throw new Error(
      `Protected environment ${environmentName} is not restricted to protected branches or main.`,
    );
  }
  if (!hasMainBranchPolicy(policies)) {
    throw new Error(
      `Protected environment ${environmentName} has no main deployment branch policy.`,
    );
  }
}

function needsBranchPolicies(environmentName, environment) {
  return (
    environmentName === providerAccountEnvironment ||
    environment.deployment_branch_policy?.custom_branch_policies === true
  );
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
  assertSourceRef(env.GITHUB_REF, env.INPUT_LANE);
  const selected = selectLane({ eventName: env.GITHUB_EVENT_NAME, inputLane: env.INPUT_LANE });
  const required = requiredEnvironmentsForLane(selected);
  for (const environmentName of required) {
    const environment = await github({
      repository: env.GITHUB_REPOSITORY,
      token: env.GITHUB_TOKEN,
      path: `/environments/${environmentName}`,
    });
    const policies = needsBranchPolicies(environmentName, environment)
      ? await github({
          repository: env.GITHUB_REPOSITORY,
          token: env.GITHUB_TOKEN,
          path: `/environments/${environmentName}/deployment-branch-policies`,
        })
      : undefined;
    validateEnvironmentPolicy(environmentName, environment, policies);
    if (
      env.GITHUB_REF !== "refs/heads/main" &&
      (environment.deployment_branch_policy?.custom_branch_policies !== true ||
        !branchPolicies(policies).some(
          (branch) =>
            branch.type === "branch" && branch.name === env.GITHUB_REF.slice("refs/heads/".length),
        ))
    ) {
      throw new Error(`Protected environment ${environmentName} must allow this exact branch.`);
    }
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
