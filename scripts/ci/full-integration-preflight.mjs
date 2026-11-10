#!/usr/bin/env node

import { classify } from "./impact.mjs";

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
const repository = "openclaw/openclaw-enterprise";
const approvalEnvironment = "integration-main-approval";
const approvalEnvironmentId = 26285522718;
const approvedTeamId = 19674117;
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

export function selectLane({ eventName, inputLane, ref, impactMode = "full" }) {
  if (eventName === "push" && ref === "refs/heads/main") {
    return impactMode === "docs" ? "docs" : "all";
  }
  if (eventName === "workflow_dispatch") {
    return inputLane;
  }
  throw new Error(`Unsupported full integration event: ${eventName}`);
}

export function assertSourceRef(ref) {
  if (ref !== "refs/heads/main") {
    throw new Error("Full integration must run from main at the approved github.sha.");
  }
}

function assertRunContext(env) {
  assertSourceRef(env.GITHUB_REF);
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF_TYPE !== "branch") {
    throw new Error("Full integration requires this repository and the main branch.");
  }
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_RUN_ATTEMPT !== "1") {
    throw new Error("Manual integration reruns are refused; start a new approved dispatch.");
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

function assertMainOnlyPolicy(environmentName, environment, policies) {
  if (environment.can_admins_bypass !== false) {
    throw new Error(`Protected environment ${environmentName} must disable administrator bypass.`);
  }
  const policy = environment.deployment_branch_policy;
  if (policy?.custom_branch_policies !== true || policy?.protected_branches !== false) {
    throw new Error(`Protected environment ${environmentName} must use custom main-only policy.`);
  }
  const branches = branchPolicies(policies);
  if (
    policies?.total_count !== 1 ||
    branches.length !== 1 ||
    branches[0]?.name !== "main" ||
    branches[0]?.type !== "branch"
  ) {
    throw new Error(`Protected environment ${environmentName} must allow only the main branch.`);
  }
}

export function validateEnvironmentPolicy(environmentName, environment, policies) {
  const reviewers = requiredReviewersRule(environment);
  if ((reviewers?.reviewers ?? []).length > 0) {
    throw new Error(`Protected environment ${environmentName} must not require reviewers.`);
  }
  assertMainOnlyPolicy(environmentName, environment, policies);
}

function positiveId(value) {
  return (
    typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
  );
}

async function validateManualApproval(env, github) {
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
  const read = (path) => github({ repository, token: env.GITHUB_TOKEN, path });
  const environment = await read(`/environments/${approvalEnvironment}`);
  const policies = await read(`/environments/${approvalEnvironment}/deployment-branch-policies`);
  assertMainOnlyPolicy(approvalEnvironment, environment, policies);
  const rules = environment.protection_rules?.filter((rule) => rule.type === "required_reviewers");
  const rule = rules?.[0];
  if (
    environment.id !== approvalEnvironmentId ||
    environment.name !== approvalEnvironment ||
    rules?.length !== 1 ||
    rule.prevent_self_review !== false ||
    rule.reviewers?.length !== 1 ||
    rule.reviewers[0]?.type !== "Team" ||
    rule.reviewers[0]?.reviewer?.id !== approvedTeamId
  ) {
    throw new Error(
      "Manual integration approval must use only the configured team and environment.",
    );
  }
  const reviews = await read(`/actions/runs/${env.GITHUB_RUN_ID}/approvals`);
  if (!Array.isArray(reviews)) {
    throw new Error("Manual integration approval history is unavailable.");
  }
  const targeted = reviews.filter((review) =>
    review.environments?.some((item) => item.id === approvalEnvironmentId),
  );
  const review = targeted[0];
  if (
    targeted.length !== 1 ||
    review.state !== "approved" ||
    !review.environments.some(
      (item) => item.id === approvalEnvironmentId && item.name === approvalEnvironment,
    ) ||
    review.user?.id !== Number(env.GITHUB_ACTOR_ID) ||
    review.user?.type !== "User" ||
    typeof review.user?.login !== "string" ||
    review.user.login.toLowerCase() !== env.GITHUB_ACTOR.toLowerCase()
  ) {
    throw new Error("Manual integration requires this dispatcher's approved environment review.");
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
  impactMode = "full",
} = {}) {
  assertRunContext(env);
  const selected = selectLane({
    eventName: env.GITHUB_EVENT_NAME,
    inputLane: env.INPUT_LANE,
    ref: env.GITHUB_REF,
    impactMode,
  });
  // Validate selection before any authorization or protected-environment reads.
  const required = requiredEnvironmentsForLane(selected === "docs" ? "all" : selected);
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
  return { selectedLane: selected, runAll: selected === "all" };
}

async function main() {
  const result = await validateFullIntegrationPreflight({ impactMode: classify().mode });
  console.log(
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
      ? "Full Integration authorized by the dispatcher's required team approval."
      : "Full Integration authorized by a main push.",
  );
  if (result.selectedLane === "docs") {
    console.log("Verified documentation-only main push: Full Integration lanes are not selected.");
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
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
