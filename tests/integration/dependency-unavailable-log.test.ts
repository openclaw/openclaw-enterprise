import { registerDependencyUnavailableFieldsCases } from "./dependency-unavailable-fields-cases.ts";
import { registerDependencyUnavailableHttpCases } from "./dependency-unavailable-http-cases.ts";
import { registerDependencyUnavailableOpenShellCase } from "./dependency-unavailable-openshell-case.ts";

// What a Kubernetes client error can carry: the request and the answer's body.
const CLIENT_TEXT =
  "POST /api/v1/namespaces/t/configmaps Authorization: Bearer clienttoken0123456789";

registerDependencyUnavailableHttpCases(CLIENT_TEXT);
registerDependencyUnavailableOpenShellCase(CLIENT_TEXT);
registerDependencyUnavailableFieldsCases(CLIENT_TEXT);
