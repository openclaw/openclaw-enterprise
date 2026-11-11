/** External desired-state ownership is independent of any orchestrator or Compute Driver. */
export interface AgentExternalManagement {
  readonly sourceId: string;
  readonly principalId: string;
  readonly version: number;
  readonly suspended: boolean;
  readonly released: boolean;
  /** Private operation receipt; never include input fingerprints in public projections. */
  readonly request?: {
    readonly sourceGeneration: number;
    readonly retryNonce?: string;
    readonly key: string;
    readonly fingerprint: string;
    readonly revisionId?: string;
  };
}

export interface AgentManagementAdoption {
  readonly sourceId: string;
  readonly expectedConfigurationId: string;
  readonly expectedConfigurationGeneration: number;
  readonly expectedActiveRevisionId?: string;
  readonly expectedFingerprint: string;
  readonly expectedManagementVersion: number;
}

export interface AgentManagementRelease {
  readonly sourceId: string;
  readonly expectedVersion: number;
}

export interface AgentManagementApply {
  readonly sourceGeneration: number;
  readonly sourceId: string;
  readonly expectedVersion: number;
  readonly requestKey: string;
  readonly desiredRuntimeState: "running" | "stopped";
  readonly configuration: {
    readonly values: Readonly<import("./index.ts").OpenClawConfigurationDocument>;
    readonly secretBindings?: import("./index.ts").SecretBindings;
  };
  readonly harnessAuth?: import("./index.ts").HarnessAuthBinding;
  readonly forceDeployment?: boolean;
  readonly retryNonce?: string;
}
