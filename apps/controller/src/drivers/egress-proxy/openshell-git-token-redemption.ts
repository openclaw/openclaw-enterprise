import { isDeepStrictEqual } from "node:util";
import type { RequestCredentialGrant } from "@openclaw-enterprise/contracts";
import type {
  PreparedGitGrantApproval,
  PreparedGitGrantRequest,
  PreparedGitRedemption,
} from "../repo/github/access/prepared-git-redemption.ts";
import type {
  OpenShellOnlineGitBinding,
  OpenShellOnlineGitIdentity,
} from "./openshell-online-git-authority.ts";

const pendingLimit = 512;
const authenticationLimit = 64;

type PendingGrant = {
  readonly request: PreparedGitGrantRequest;
  readonly binding: OpenShellOnlineGitBinding;
  readonly approval: PreparedGitGrantApproval;
  readonly workspace: string;
  deadline: number;
  ready: boolean;
};

function pendingKey({
  recipientId,
  bindingId,
  requestId,
}: PreparedGitGrantApproval | RequestCredentialGrant) {
  return JSON.stringify([recipientId, bindingId, requestId]);
}

/** Joins the two authenticated transport calls at the worker holding the execution's fence.
 * The store independently commits the approval, assertion replay claim and material use. */
export class OpenShellGitGrantExchange {
  private readonly pending = new Map<string, PendingGrant>();
  private readonly owner: PreparedGitRedemption;
  private readonly lookup: (
    identity: OpenShellOnlineGitIdentity,
    signal: AbortSignal,
  ) => Promise<OpenShellOnlineGitBinding | undefined>;
  private authenticating = 0;

  constructor(
    owner: PreparedGitRedemption,
    lookup: (
      identity: OpenShellOnlineGitIdentity,
      signal: AbortSignal,
    ) => Promise<OpenShellOnlineGitBinding | undefined>,
  ) {
    this.owner = owner;
    this.lookup = lookup;
  }

  acquireAuthentication = (): (() => void) | undefined => {
    if (this.authenticating >= authenticationLimit) {
      return;
    }
    this.authenticating++;
    let held = true;
    return () => {
      if (held) {
        held = false;
        this.authenticating--;
      }
    };
  };

  async approve(
    request: PreparedGitGrantRequest,
    binding: OpenShellOnlineGitBinding,
    identity: OpenShellOnlineGitIdentity,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const credentialIdentity =
      request.operation === "github-graphql"
        ? binding.pullApiCredentialIdentity
        : binding.grantCredentialIdentity;
    if (!credentialIdentity || !binding.installed.route) {
      return;
    }
    const now = Date.now();
    for (const [key, { deadline }] of this.pending) {
      if (deadline <= now) {
        this.pending.delete(key);
      }
    }
    const approval = {
      recipientId: identity.sandboxId,
      bindingId: identity.bindingId,
      requestId: identity.requestId,
      credentialIdentity,
    };
    const key = pendingKey(approval);
    const deadline = Date.parse(request.deadlineAt);
    if (
      signal.aborted ||
      !(deadline > now) ||
      this.pending.size >= pendingLimit ||
      this.pending.has(key)
    ) {
      return;
    }
    const pending = {
      request,
      binding,
      approval,
      workspace: identity.workspace,
      deadline,
      ready: false,
    };
    this.pending.set(key, pending);
    try {
      const replyBy = await this.owner.approve(
        request,
        { route: binding.installed.route },
        approval,
        signal,
      );
      if (!replyBy || signal.aborted || this.pending.get(key) !== pending) {
        return;
      }
      pending.deadline = Date.parse(replyBy);
      pending.ready = pending.deadline > Date.now();
      return pending.ready ? replyBy : undefined;
    } finally {
      if (!pending.ready && this.pending.get(key) === pending) {
        this.pending.delete(key);
      }
    }
  }

  redeem = async (grant: RequestCredentialGrant, signal: AbortSignal) => {
    const key = pendingKey(grant);
    const pending = this.pending.get(key);
    const deadline = Math.min(pending?.deadline ?? 0, Date.parse(grant.deadlineAt));
    if (
      !pending?.ready ||
      signal.aborted ||
      !(deadline > Date.now()) ||
      grant.clientAssertion?.credentialIdentity !== pending.approval.credentialIdentity
    ) {
      return;
    }
    const release = this.acquireAuthentication();
    if (!release) {
      return;
    }
    // Consume the local association before awaiting. A lost check/commit is never retried.
    this.pending.delete(key);
    try {
      const live = await this.lookup(
        {
          sandboxId: grant.recipientId,
          bindingId: grant.bindingId,
          requestId: grant.requestId,
          workspace: pending.workspace,
        },
        signal,
      );
      const route = live?.installed.route;
      if (
        !route ||
        !isDeepStrictEqual(live, pending.binding) ||
        signal.aborted ||
        !(deadline > Date.now())
      ) {
        return;
      }
      return await this.owner.redeem(
        { ...pending.request, deadlineAt: new Date(deadline).toISOString() },
        { route },
        grant,
        signal,
      );
    } finally {
      release();
    }
  };
}
