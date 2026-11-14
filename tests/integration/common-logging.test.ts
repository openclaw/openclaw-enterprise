import { registerDeliveryCases } from "./common-logging-delivery-cases.ts";
import { registerEventCases } from "./common-logging-event-cases.ts";
import { registerHttpCases } from "./common-logging-http-cases.ts";
import {
  registerStartupConfigurationCases,
  registerWorkerProcessCase,
} from "./common-logging-startup-cases.ts";
import {
  registerBootstrapAttemptCase,
  registerWorkerCases,
} from "./common-logging-worker-cases.ts";

registerStartupConfigurationCases();
registerEventCases();
registerHttpCases();
registerWorkerCases();
registerDeliveryCases();
registerBootstrapAttemptCase();
registerWorkerProcessCase();
