/** Durable identity of the selected private credential store. */
export interface CredentialServiceInstance {
  readonly id: string;
  readonly driverId: string;
  readonly storeIdentity: string;
}
