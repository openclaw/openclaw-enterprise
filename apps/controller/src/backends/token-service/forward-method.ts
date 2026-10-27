/** Retain the receiver without exposing properties or prototypes attached to a Driver's method. */
export function forwardMethod<Receiver, Args extends unknown[], Result>(
  receiver: Receiver,
  method: (this: Receiver, ...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) => Reflect.apply(method, receiver, args);
}
