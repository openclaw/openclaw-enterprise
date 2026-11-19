import type {
  CredentialSourceLoginMode,
  RuntimeFailureCause,
} from "../../packages/contracts/src/index.ts";

export type NativeProcessResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Pick<NodeJS.ErrnoException, "code">;
  stderr?: string;
  // A number exercises malformed process output.
  stdout?: string | number;
};

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

export type NativeStep<Operation extends "login" | "probe" = "login" | "probe"> = {
  operation: Operation;
  result: NativeProcessResult;
  timeout: number | undefined;
  elapsed: number | undefined;
};

export type LoginFailureCode = "LOGIN_FAILED" | "AUTHENTICATION_FAILED";
export type FailureClass =
  "network" | "tls" | "http_401_403" | "http_5xx" | "http_other" | "timeout" | "empty" | "unknown";

export type StartupExpectation = {
  phases: readonly (readonly ["codex-login" | "model-probe" | "native-spawn", "ok" | "failed"])[];
  code: "READY" | LoginFailureCode | "MODEL_PROBE_FAILED" | "MODEL_PROBE_TIMEOUT";
  check?: "login" | "model-probe";
  cause?: RuntimeFailureCause | undefined;
  provider?: { readonly status?: number; readonly code?: string } | undefined;
};

export type StartupOptions = {
  providerPat?: boolean;
  openShellOAuth?: boolean;
  loginMode?: CredentialSourceLoginMode;
  transportToken?: "raw" | "verifier";
  random?: number;
  lateWakeMs?: number;
  environment?: Readonly<NodeJS.ProcessEnv>;
};

type StartupChecks = {
  expect: StartupExpectation;
  retryAfterMs?: number;
  retryDelayMs?: number;
  loginPauses?: readonly number[];
  loginClasses?: readonly FailureClass[];
  failureClass?: FailureClass;
  probeCodes?: readonly StartupExpectation["code"][];
  probeFailureClasses?: readonly (FailureClass | undefined)[];
  probeCauses?: readonly (RuntimeFailureCause | undefined)[];
  lastProbeCause?: RuntimeFailureCause;
};

export type StartupScenario = StartupOptions &
  (
    | { protectedInference: "missing"; native: readonly [] }
    | (StartupChecks & { protectedInference?: "signed" } & (
          | { native: readonly NativeStep[] }
          | {
              native?: undefined;
              events: readonly JsonValue[];
              result?: Partial<NativeProcessResult>;
            }
        ))
  );
