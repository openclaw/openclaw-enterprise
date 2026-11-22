export interface CleanupRegistrar {
  after(cleanup: () => void | Promise<void>): void;
}
