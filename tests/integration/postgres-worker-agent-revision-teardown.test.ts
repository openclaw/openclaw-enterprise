import { after } from "node:test";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { testRepositoryAdmission } from "./postgres-worker-agent-revision-teardown-admission.ts";
import { testActiveRevisionAuthority } from "./postgres-worker-agent-revision-teardown-authority.ts";
import { testMaterialRepair } from "./postgres-worker-agent-revision-teardown-material.ts";
import { testRepositoryCleanup } from "./postgres-worker-agent-revision-teardown-cleanup.ts";
import { testDeadlineWithdrawal } from "./postgres-worker-agent-revision-teardown-withdrawal.ts";

// Repository sessions through admission, maintenance and cleanup. Agent stop, its Gateway drain,
// Agent deletion and Namespace teardown are in the -stop sibling. Deployment and dispatch are in
// postgres-worker-agent-revision.test.mjs, persisted deploy, Stop and delete are in the -lifecycle
// sibling, and credential-source withdrawals are in the -credential-sources sibling.

const { setup, cleanup } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

testRepositoryAdmission(setup);
testActiveRevisionAuthority(setup);
testMaterialRepair(setup);
testRepositoryCleanup(setup);
testDeadlineWithdrawal(setup);
