import { WORKSPACE_FILE_NAMES } from "@openclaw-enterprise/contracts";
import type { AgentRevision, WorkspaceFileName } from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  type ActiveAgentRevisionSelection,
  type OpenClawController,
} from "@openclaw-enterprise/occ";

// A recorded pre-stop boundary allows the predecessor to serve until the worker stops it.
// Older deployments can have an exclusive successor without a recorded boundary.
export function gatewayPredecessorUnavailable(
  controller: OpenClawController,
  { predecessorPhase, successor }: ActiveAgentRevisionSelection,
): boolean {
  if (predecessorPhase !== undefined || successor === undefined) {
    return predecessorPhase === "stopping";
  }
  let compute;
  try {
    compute = controller.selectedDriver("compute");
  } catch {
    throw new DependencyUnavailableError("The selected Compute Driver is unavailable.");
  }
  return (
    successor.compute.id === compute.id &&
    successor.compute.implementation === compute.implementation &&
    compute.requiresStoppedPredecessors?.(successor) === true
  );
}

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
  /** Recheck the OCC selection on the connected socket before sending a file RPC. */
  readonly isRevisionCurrent?: () => Promise<boolean>;
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
