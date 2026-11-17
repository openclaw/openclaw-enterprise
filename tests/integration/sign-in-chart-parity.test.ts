import { describe } from "node:test";
import { registerProviderCases } from "./sign-in-chart-provider-cases.ts";
import { registerProxyAndEgressCases } from "./sign-in-chart-proxy-egress-cases.ts";
import { registerUrlCases } from "./sign-in-chart-url-cases.ts";
import { registerEnrollmentCases } from "./sign-in-chart-enrollment-cases.ts";

describe("sign-in chart parity", { concurrency: true }, () => {
  registerProviderCases();
  registerProxyAndEgressCases();
  registerUrlCases();
});

registerEnrollmentCases();
