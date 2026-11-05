import { registerGatewayToolPolicyTest } from "../helpers/openshell-sandbox-workflows.mjs";

// CI gives this workflow its own database and, in advisory QA, its own runner/cluster.
registerGatewayToolPolicyTest();
