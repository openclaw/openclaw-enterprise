import test from "node:test";
import { requiresPostgres } from "../helpers/postgres-platform-state.ts";
import {
  persistNamespaceLifecycle,
  refuseUninitializedInstallation,
} from "./postgres-state-admission-cases.ts";
import {
  browseUnreadableState,
  refuseUnreadableDeployment,
  selectNativeAdminRevision,
} from "./postgres-state-browsing-cases.ts";
import { verifyPostgresStateConformance } from "./postgres-state-conformance-case.ts";
import { persistGuardedDeployment } from "./postgres-state-guarded-deployment-case.ts";
import { persistPluginState } from "./postgres-state-plugin-case.ts";
import {
  checkpointProvisioning,
  completeProvisioning,
  replayProvisioning,
} from "./postgres-state-provisioning-cases.ts";
import { drainApiOnSigterm, recheckNamespaceRestriction } from "./postgres-state-worker-cases.ts";

// These cases share the prepared file database. The startup refusal precedes bootstrap.
test(
  "PostgreSQL rejects platform writes until the singleton Installation is bootstrapped",
  requiresPostgres,
  refuseUninitializedInstallation,
);
test(
  "real OCC Namespace lifecycle persists provisioning, readiness, deletion, and its tombstone",
  requiresPostgres,
  persistNamespaceLifecycle,
);
test(
  "PostgreSQL Agent provisioning persistence replays requests and fences checkpoints",
  requiresPostgres,
  replayProvisioning,
);
test(
  "PostgreSQL Agent provisioning success completes its queue row atomically",
  requiresPostgres,
  completeProvisioning,
);
test(
  "PostgreSQL Agent provisioning direct checkpoint still moves ordinary progress",
  requiresPostgres,
  checkpointProvisioning,
);
test(
  "PostgreSQL platform state satisfies memory adapter ownership, immutability, and atomicity",
  requiresPostgres,
  verifyPostgresStateConformance,
);
test(
  "PostgreSQL persists Agent plugin desired state and immutable revision snapshots atomically",
  requiresPostgres,
  persistPluginState,
);
test(
  "PostgreSQL browsing isolates unreadable saved Agent and revision configuration",
  requiresPostgres,
  browseUnreadableState,
);
test(
  "PostgreSQL native admin ignores unreadable older revisions when checking for a successor",
  requiresPostgres,
  selectNativeAdminRevision,
);
test(
  "PostgreSQL deployment refuses with 503 and creates nothing when an earlier revision is unreadable",
  requiresPostgres,
  refuseUnreadableDeployment,
);
test(
  "the PostgreSQL worker reloads exact Namespace restrictions and never dispatches revoked provisioning",
  requiresPostgres,
  recheckNamespaceRestriction,
);
test(
  "API SIGTERM finishes an in-flight keep-alive request and exits within the Pod grace",
  requiresPostgres,
  drainApiOnSigterm,
);
test(
  "PostgreSQL guarded first deployment persists one private receipt and one reconcile work",
  requiresPostgres,
  persistGuardedDeployment,
);
