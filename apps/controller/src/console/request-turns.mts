// Requests in one view that the API may refuse, and audit, each for the same reason, such as a
// revoked Installation administration (findings 2938, 2939). Until a request in the queue
// succeeds, the first is sent alone and each later one waits for every request before it to
// settle, so one refusal can answer the requests after it unsent. Once a request succeeds, the
// waiting requests and new ones are sent at once. When no request is pending, the queue starts
// over and `onIdle` runs, so a later action again sends its first request alone.
export type RequestInTurn = <T>(send: () => Promise<T>) => Promise<T>;

export function createRequestTurns(onIdle?: () => void): RequestInTurn {
  let pending = 0;
  let earlier!: Promise<unknown>;
  let open!: boolean;
  let opened!: () => void;
  let whenOpened!: Promise<void>;
  const reset = () => {
    earlier = Promise.resolve();
    open = false;
    whenOpened = new Promise((resolve) => {
      opened = resolve;
    });
  };
  reset();
  return <T,>(send: () => Promise<T>) => {
    pending += 1;
    const turn = (open ? Promise.resolve() : Promise.race([earlier, whenOpened])).then(send);
    const settled = turn.then(
      () => {
        open = true;
        opened();
      },
      () => undefined,
    );
    earlier = Promise.all([earlier, settled]);
    void settled.then(() => {
      pending -= 1;
      if (pending === 0) {
        reset();
        onIdle?.();
      }
    });
    return turn;
  };
}
