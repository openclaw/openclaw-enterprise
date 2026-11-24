import { registerGitDenialCommandCases } from "./openshell-git-denial-command-cases.ts";
import { registerGitDenialHistoryCases } from "./openshell-git-denial-history-cases.ts";
import { registerGitDenialPolicyCases } from "./openshell-git-denial-policy-cases.ts";

registerGitDenialPolicyCases();
registerGitDenialHistoryCases();
registerGitDenialCommandCases();
