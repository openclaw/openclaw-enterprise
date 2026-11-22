/** Durable identity of the selected private credential store. */
export interface TokenServiceInstance {
  readonly id: string;
  readonly driverId: string;
  readonly storeIdentity: string;
}
