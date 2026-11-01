import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromHttp } from "@aws-sdk/credential-provider-http";
import { createHash } from "node:crypto";

export type AwsParameterInput = {
  readonly namespaceId: string;
  readonly secretId: string;
  readonly backendUid: string;
  readonly parameterArn: string;
};

const POD_IDENTITY_URI = "http://169.254.170.23/v1/credentials";
const POD_IDENTITY_TOKEN_FILE =
  "/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token";
const MAX_VALUE_BYTES = 65_536;
const READ_TIMEOUT_MS = 10_000;
const COMMERCIAL_REGIONS = new Set([
  "af-south-1",
  "ap-east-1",
  "ap-east-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-6",
  "ap-southeast-7",
  "ca-central-1",
  "ca-west-1",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "il-central-1",
  "me-central-1",
  "me-south-1",
  "mx-central-1",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
]);

export function parseAwsParameterArn(arn: string): { region: string; name: string } {
  const match = /^arn:aws:ssm:([a-z0-9-]+):[0-9]{12}:parameter\/([A-Za-z0-9_./-]+)$/.exec(arn);
  const region = match?.[1];
  const path = match?.[2];
  if (
    typeof arn !== "string" ||
    arn.length > 1011 ||
    match?.[0] !== arn ||
    region === undefined ||
    !COMMERCIAL_REGIONS.has(region) ||
    path === undefined ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    path.split("/").length > 15 ||
    /^(aws|ssm)/i.test(path)
  ) {
    throw new Error("AWS parameter binding requires an exact commercial SSM parameter ARN.");
  }
  return { region, name: `/${path}` };
}

function unavailable(): Error {
  return new Error("The AWS parameter credential input is unavailable.");
}

// The Pod Identity provider has no abort input. Stop awaiting it on withdrawal;
// a late HTTP result must not start STS or SSM work.
async function withinSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) {
    throw unavailable();
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(unavailable());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export async function readAwsParameter(
  input: AwsParameterInput,
  signal: AbortSignal,
): Promise<{ value: string; version: string }> {
  const { region } = parseAwsParameterArn(input.parameterArn);
  const effectiveSignal = AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
  let ssm: SSMClient | undefined;
  let sts: STSClient | undefined;
  try {
    if (
      effectiveSignal.aborted ||
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI !== POD_IDENTITY_URI ||
      process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE !== POD_IDENTITY_TOKEN_FILE ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
    ) {
      throw unavailable();
    }
    const credentials = await withinSignal(
      effectiveSignal,
      fromHttp({
        awsContainerCredentialsFullUri: POD_IDENTITY_URI,
        awsContainerCredentialsRelativeUri: "",
        awsContainerAuthorizationTokenFile: POD_IDENTITY_TOKEN_FILE,
        awsContainerAuthorizationToken: "",
        timeout: 2_000,
        maxRetries: 0,
      }),
    );
    if (effectiveSignal.aborted) {
      throw unavailable();
    }
    const common = {
      region,
      credentials,
      ignoreConfiguredEndpointUrls: true,
      useFipsEndpoint: false,
      useDualstackEndpoint: false,
      maxAttempts: 2,
      requestHandler: {
        connectionTimeout: 2_000,
        requestTimeout: 5_000,
        httpsAgent: { rejectUnauthorized: true },
      },
    };
    const identityClient = new STSClient({
      ...common,
      endpoint: `https://sts.${region}.amazonaws.com`,
    });
    sts = identityClient;
    const identity = await withinSignal(effectiveSignal, () =>
      identityClient.send(new GetCallerIdentityCommand({}), { abortSignal: effectiveSignal }),
    );
    // SSM supports shared cross-account parameters. Explicitly refuse that path;
    // matching the returned parameter ARN alone would not establish this boundary.
    if (identity.Account !== input.parameterArn.split(":")[4] || effectiveSignal.aborted) {
      throw unavailable();
    }
    const parameterClient = new SSMClient({
      ...common,
      endpoint: `https://ssm.${region}.amazonaws.com`,
    });
    ssm = parameterClient;
    const response = await withinSignal(effectiveSignal, () =>
      parameterClient.send(
        new GetParameterCommand({ Name: input.parameterArn, WithDecryption: true }),
        {
          abortSignal: effectiveSignal,
        },
      ),
    );
    const parameter = response.Parameter;
    const value = parameter?.Value;
    const version = parameter?.Version;
    if (
      effectiveSignal.aborted ||
      parameter?.ARN !== input.parameterArn ||
      parameter.Type !== "SecureString" ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version <= 0 ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0") ||
      !value.isWellFormed() ||
      Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES
    ) {
      throw unavailable();
    }
    const binding = createHash("sha256")
      .update(
        JSON.stringify([
          "aws-ssm-v1",
          input.namespaceId,
          input.secretId,
          input.backendUid,
          region,
          input.parameterArn,
        ]),
      )
      .digest("hex");
    return { value, version: `aws-ssm:${binding}:${version}` };
  } catch {
    // Provider errors can contain credential material. Do not retain their cause.
    throw unavailable();
  } finally {
    ssm?.destroy();
    sts?.destroy();
  }
}
