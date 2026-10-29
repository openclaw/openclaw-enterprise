import type { Driver } from "./driver.ts";
import type { ServiceAccount, ServiceAccountCredential } from "./index.ts";

export interface ServiceAccountDriver extends Driver {
  readonly capability: "service_account";
  create(account: ServiceAccount): Promise<void>;
  createCredential(account: ServiceAccount): Promise<ServiceAccountCredential>;
  delete(account: ServiceAccount): Promise<void>;
}
