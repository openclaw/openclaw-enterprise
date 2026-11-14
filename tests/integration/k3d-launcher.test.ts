import { registerLauncherModelCases } from "./k3d-launcher-model-cases.ts";
import { registerLauncherLifecycleCases } from "./k3d-launcher-lifecycle-cases.ts";
import { registerLauncherStateCases } from "./k3d-launcher-state-cases.ts";
import { registerLauncherDispatchCases } from "./k3d-launcher-dispatch-cases.ts";
import { registerNativePreparationCases } from "./k3d-launcher-admission-cases.ts";
import { registerNativeDestinationCases } from "./k3d-launcher-destination-cases.ts";

registerLauncherModelCases();
registerLauncherLifecycleCases();
registerLauncherStateCases();
registerLauncherDispatchCases();
registerNativePreparationCases();
registerNativeDestinationCases();
