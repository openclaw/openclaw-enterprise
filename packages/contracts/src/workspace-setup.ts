/** The ordinary OpenClaw workspace files accepted only during Agent creation. */
export const INITIAL_WORKSPACE_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
] as const;
export type InitialWorkspaceFileName = (typeof INITIAL_WORKSPACE_FILE_NAMES)[number];
export type InitialWorkspaceFiles = Partial<Record<InitialWorkspaceFileName, string>>;

/** Private delivery state; never part of an Agent or immutable revision. */
export interface WorkspaceSetup {
  readonly id: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly defaultsId?: string;
  readonly files?: InitialWorkspaceFiles;
  readonly completed: boolean;
}

export function normalizeInitialWorkspaceFiles(value: unknown): InitialWorkspaceFiles | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Initial workspace files must be an object.");
  }
  const isWellFormed = (String.prototype as unknown as { isWellFormed: (this: string) => boolean })
    .isWellFormed;
  const files: InitialWorkspaceFiles = {};
  for (const [name, content] of Object.entries(value)) {
    if (!(INITIAL_WORKSPACE_FILE_NAMES as readonly string[]).includes(name)) {
      throw new TypeError("Initial workspace files contain an unsupported filename.");
    }
    if (
      typeof content !== "string" ||
      !isWellFormed.call(content) ||
      content.includes("\0") ||
      Buffer.byteLength(content, "utf8") > 16 * 1024
    ) {
      throw new TypeError(
        "Initial workspace file content must be valid Unicode without NUL and at most 16 KiB.",
      );
    }
    files[name as InitialWorkspaceFileName] = content;
  }
  return Object.keys(files).length === 0 ? undefined : Object.freeze(files);
}

export function normalizeWorkspaceDefaultsId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError("The workspace defaults identity must be a SHA-256 digest.");
  }
  return value;
}
