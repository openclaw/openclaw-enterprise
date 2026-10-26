import type { Namespace } from "@openclaw-enterprise/contracts";
import type { RequestOptions } from "./api-client.mjs";
import type { createDraftStore } from "./drafts.mjs";
import type { createNavigation } from "./navigation.mjs";
import type { createShell } from "./shell.mjs";

export type LeaveGuard = Parameters<ReturnType<typeof createShell>["setLeaveGuard"]>[0];
export type TabNavigation = (url: URL) => boolean | "blocked";

type DraftStore = ReturnType<typeof createDraftStore>;
type Navigation = ReturnType<typeof createNavigation>;

/** What a page can do for as long as the Console keeps its view mounted. */
export interface ConsolePageContext extends Pick<Navigation, "navigate" | "pageUrl"> {
  view: HTMLElement;
  url: URL;
  namespace: Namespace | undefined;
  namespaceId: string | null;
  operatorId: string;
  installationAdmin: boolean | null;
  deniedReads: {
    has(path: string): boolean;
    remember(path: string): void;
    forget(path: string): void;
  };
  drafts: ReturnType<DraftStore["scope"]>;
  suspendDrafts: DraftStore["suspend"];
  request(
    path: string,
    options?: RequestOptions & {
      readOnly?: boolean;
      revalidate?: boolean;
      rereadOnResume?: boolean;
    },
  ): Promise<unknown>;
  mutationVersion(): number;
  isCurrent(): boolean;
  onResume(handler: () => void): void;
  onRevalidate(check: () => Promise<unknown>): () => void;
  onExpired(): void;
  setTitle(title: string): void;
  setTabNavigation(handler: TabNavigation): void;
  setPageActions(node: HTMLElement): void;
  setLeaveGuard(guard: LeaveGuard): void;
  setWriteInFlight(check: () => boolean): void;
  /** The Namespace permission answer's secrets.create; undefined when it is unknown. */
  secretsCreateAllowed?(): Promise<boolean | undefined>;
  /** Run after an Agent detail page that loaded behind a stand-in is visible. */
  revealed?(then?: () => void): void;
}
