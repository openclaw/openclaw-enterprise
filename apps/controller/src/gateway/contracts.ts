import { WORKSPACE_FILE_NAMES } from "@openclaw-enterprise/contracts";
import type {
  AgentGatewayPerson,
  AgentRevision,
  WorkspaceFileName,
} from "@openclaw-enterprise/contracts";

const ALLOWED_WORKSPACE_FILES = new Set<string>(WORKSPACE_FILE_NAMES);

export interface ControllerWorkspaceFileData {
  readonly name: WorkspaceFileName;
  readonly content: string;
  readonly size?: number;
}

export interface ControllerWorkspaceFileMetadata {
  readonly name: WorkspaceFileName;
  readonly size?: number;
}

export interface ControllerWorkspaceFileReadRequest {
  readonly revision: Readonly<AgentRevision>;
  readonly filename: WorkspaceFileName;
  readonly signal: AbortSignal;
  readonly deadline: Date;
}

export interface ControllerWorkspaceFileWriteRequest extends ControllerWorkspaceFileReadRequest {
  readonly content: string;
}

export type ControllerWorkspaceFileReadResult =
  | {
      readonly status: "ok";
      readonly file: ControllerWorkspaceFileData;
    }
  | {
      readonly status: "missing";
    }
  | {
      readonly status: "unavailable";
    };

export type ControllerWorkspaceFileWriteResult =
  | {
      readonly status: "ok";
      readonly file: ControllerWorkspaceFileMetadata;
    }
  | {
      readonly status: "missing";
    }
  | {
      readonly status: "unavailable";
    };

export interface ControllerWorkspaceFilesAccess {
  read(request: ControllerWorkspaceFileReadRequest): Promise<ControllerWorkspaceFileReadResult>;
  write(request: ControllerWorkspaceFileWriteRequest): Promise<ControllerWorkspaceFileWriteResult>;
}

export class ControllerWorkspaceFileUnknownOutcomeError extends Error {
  override readonly cause: unknown;

  constructor(
    message = "The workspace file write outcome is unknown.",
    options: { readonly cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ControllerWorkspaceFileUnknownOutcomeError";
    this.cause = options.cause;
  }
}

export function isAllowedWorkspaceFileName(name: string): name is WorkspaceFileName {
  return ALLOWED_WORKSPACE_FILES.has(name);
}

export interface ControllerGatewayPeopleRequest {
  readonly revision: Readonly<AgentRevision>;
  readonly signal: AbortSignal;
  readonly deadline: Date;
}

export interface ControllerGatewayPeopleAccess {
  list(request: ControllerGatewayPeopleRequest): Promise<readonly AgentGatewayPerson[]>;
  avatar(
    request: ControllerGatewayPeopleRequest & { readonly profileId: string },
  ): Promise<{ readonly mime: string; readonly bytes: Uint8Array } | undefined>;
}
