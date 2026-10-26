// console-assets.ts serves OCC's packages/occ/src/deployment-failure-steps.ts at
// /console/deployment-failure-steps.mjs. These declarations repeat the signatures the Console uses.
export type DeploymentFailureStep = "deploy-again" | "logs" | "change";
export declare const DEPLOYMENT_FAILURE_STEPS: Readonly<Record<string, DeploymentFailureStep>>;
export declare function deploymentFailureStep(
  code: string | null | undefined,
): DeploymentFailureStep;
