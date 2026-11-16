import { registerRefreshCases } from "./credential-source-occ-refresh.ts";
import { registerSourceMutationCases } from "./credential-source-occ-source-mutations.ts";
import { registerWithdrawalCases } from "./credential-source-occ-withdrawals.ts";
import { registerHarnessAccessCases } from "./credential-source-occ-harness-access.ts";
import { registerDeletionCases } from "./credential-source-occ-deletion.ts";
import { registerAgentAdmissionCases } from "./credential-source-occ-agent-admission.ts";
import { registerSourceDisclosureCase } from "./credential-source-occ-source-disclosure.ts";

registerRefreshCases();
registerSourceMutationCases();
registerWithdrawalCases();
registerHarnessAccessCases();
registerDeletionCases();
registerAgentAdmissionCases();
registerSourceDisclosureCase();
