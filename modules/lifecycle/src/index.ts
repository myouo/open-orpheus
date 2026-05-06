export type FinalizerToken = object;

type FinalizationRegistryHandler = {
  heldValue: unknown;
  token: FinalizerToken;
  callback: (heldValue: unknown) => void;
};

type LifecycleState = {
  objectFinalizers: FinalizationRegistryHandler[];
  finalizationRegistry: FinalizationRegistry<FinalizationRegistryHandler>;
};

// We use a global symbol to store lifecycle state, so that multiple instances (CommonJS or ESM) of this module can coexist without interfering with each other.
const LIFECYCLE_KEY = Symbol.for("@open-orpheus/lifecycle");
const g = globalThis as typeof globalThis & {
  [LIFECYCLE_KEY]?: LifecycleState;
};

if (!g[LIFECYCLE_KEY]) {
  const objectFinalizers: FinalizationRegistryHandler[] = [];

  const finalizationRegistry = new FinalizationRegistry(
    (handler: FinalizationRegistryHandler) => {
      const idx = objectFinalizers.indexOf(handler);
      if (idx === -1) return; // already handled by finalize()
      objectFinalizers.splice(idx, 1);
      handler.callback(handler.heldValue);
    }
  );

  const finalize = () => {
    // Reverse a snapshot so last-registered is destroyed first (LIFO)
    const handlers = objectFinalizers.splice(0).reverse();
    for (const handler of handlers) {
      finalizationRegistry.unregister(handler);
      handler.callback(handler.heldValue);
    }
  };

  const signalHandler = (signal: NodeJS.Signals) => {
    finalize();
    if (process.listenerCount(signal) <= 1) {
      // Only this handler is left, so it's safe to exit
      process.exit(signal === "SIGINT" ? 130 : 143); // 128 + signal number, per convention
    }
  };

  // We expect the process MUST exit after these signals.
  process.prependListener("SIGINT", signalHandler);
  process.prependListener("SIGTERM", signalHandler);

  process.on("exit", finalize);

  g[LIFECYCLE_KEY] = { objectFinalizers, finalizationRegistry };
}

const { objectFinalizers, finalizationRegistry } = g[LIFECYCLE_KEY]!;

export function registerFinalizer<T>(
  target: object,
  heldValue: T,
  callback: (heldValue: T) => void
): FinalizerToken {
  const token = {};
  const finalizer = {
    heldValue,
    token,
    callback,
  } as FinalizationRegistryHandler;
  objectFinalizers.push(finalizer);
  finalizationRegistry.register(target, finalizer, finalizer);
  return token;
}

export function unregisterFinalizer(token: FinalizerToken): void {
  const idx = objectFinalizers.findIndex((h) => h.token === token);
  if (idx !== -1) {
    finalizationRegistry.unregister(objectFinalizers[idx]);
    objectFinalizers.splice(idx, 1);
  }
}

/**
 * An alias to `process.on("exit", callback)`.
 *
 * This library already catches exit signals, so `exit` event will always be called even
 * if the process is killed by a signal. The callback will be called after all finalizers are called.
 * @param callback
 */
export function onExit(callback: NodeJS.ExitListener): void {
  process.on("exit", callback);
}

/**
 * An alias to `process.off("exit", callback)`.
 *
 * See {@link onExit} for details.
 * @param callback
 */
export function offExit(callback: NodeJS.ExitListener): void {
  process.off("exit", callback);
}
