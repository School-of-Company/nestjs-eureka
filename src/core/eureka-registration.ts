import type { EurekaClient } from './eureka-client';
import type { EurekaLogger } from './logger';
import type { ResolvedEurekaOptions } from './options';

type State = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

/** The lifecycle HTTP call currently in flight, so stop() can cancel it. */
interface ActiveOperation {
  kind: 'register' | 'renew';
  controller: AbortController;
}

/**
 * Lifecycle state machine for a single Eureka registration: register once,
 * heartbeat on a schedule, re-register on a 404 heartbeat response,
 * deregister on shutdown. No NestJS dependency.
 *
 * `stopped` is a terminal state: once reached (via a failed initial `start()`
 * in fail-fast mode, or a completed `stop()`), this instance cannot be
 * restarted — construct a new one instead. In background mode, `start()`
 * never fails because of a registration error.
 */
export class EurekaRegistration {
  private state: State = 'idle';
  private registered = false;
  /** Some register attempt may have created remote state (a timeout,
   *  transport failure, abort, or 5xx on some server) that no deregistration
   *  has been attempted for yet. Sticky: a renew 200/404 or a later
   *  successful register is an answer from one server, not proof that every
   *  server is clean — only `deregisterBestEffort()` clears it. Where the
   *  DELETE goes is `EurekaClient.deregister()`'s job (every server). */
  private registrationCleanupOwed = false;
  /** Whatever single Eureka HTTP call is currently in flight (the initial
   *  register, or the current heartbeat tick's renew/re-register). Assigned
   *  synchronously, before any `await` inside it runs. */
  private pendingOperation?: Promise<void>;
  /** Cancellation handle + identity of the HTTP call inside `pendingOperation`;
   *  `pendingOperation` stays the thing stop() awaits for sequencing. */
  private activeOperation?: ActiveOperation;
  private heartbeatTimer?: NodeJS.Timeout;
  private stopPromise?: Promise<void>;

  constructor(
    private readonly client: EurekaClient,
    private readonly heartbeatIntervalMs: number,
    private readonly logger: EurekaLogger,
    private readonly registrationMode: ResolvedEurekaOptions['registrationMode'],
  ) {}

  /**
   * Registers with Eureka and starts the heartbeat loop. In fail-fast mode,
   * rejects with the original registration error on failure — the caller
   * (Nest's `onApplicationBootstrap`) is expected to let that fail
   * application boot. If any attempt's outcome was unknown, a best-effort
   * deregistration is awaited before that rejection. In background mode, a failed registration is logged
   * and retried by the heartbeat loop, and this resolves anyway.
   */
  start(): Promise<void> {
    if (this.state === 'running') return Promise.resolve();
    if (this.state === 'starting') return this.pendingOperation!;
    if (this.state === 'stopping' || this.state === 'stopped') {
      return Promise.reject(
        new Error(
          'EurekaRegistration is stopped and cannot be restarted; create a new instance to retry.',
        ),
      );
    }

    this.state = 'starting';
    const operation = (async () => {
      try {
        await this.register();
        this.registered = true;
        // stop() may have already claimed ownership of stopping->stopped
        // while this register call was in flight — if so, leave the state
        // transition and the resulting DELETE entirely to stop()'s own
        // sequence (it will see `registered === true`).
        if (this.state !== 'starting') return;
        this.state = 'running';
        this.scheduleHeartbeat();
      } catch (error) {
        if (this.registrationMode === 'fail-fast') {
          // Only claim the `stopped` transition if it's still ours to claim —
          // stop() is the only path allowed to move `stopping -> stopped`,
          // and then it also owns the cleanup (no second DELETE from here).
          if (this.state === 'starting') {
            this.state = 'stopped';
            // A failed bootstrap means Nest never runs shutdown hooks, so
            // stop() may never be called: clean up here. Awaited, because
            // the process typically exits right after the rejection.
            if (this.registrationCleanupOwed) {
              // `.catch`: a throwing injected logger must never replace the
              // original registration error below.
              await this.deregisterBestEffort(
                'after a failed initial registration',
              ).catch(() => undefined);
            }
          }
          throw error; // the original start() caller always sees this
        }
        // Background mode: never reject. If stop() already landed (and
        // aborted this register), it owns the transition and the cleanup.
        if (this.state !== 'starting') return;
        this.logger.warn(
          `Eureka initial registration failed; retrying every ${this.heartbeatIntervalMs / 1000}s in the background: ${(error as Error).message}`,
        );
        this.state = 'running';
        // Retries deliberately go through the normal heartbeat tick
        // (renew first, register only on 404) rather than calling register()
        // directly: a failed POST may still have succeeded server-side (e.g.
        // the response timed out), and a successful renew is what proves
        // that and restores `registered = true`. Don't "simplify" this into
        // a direct register() retry or a second timer.
        this.scheduleHeartbeat();
      }
    })();
    this.pendingOperation = operation;
    return operation;
  }

  /** Idempotent, memoized, never rejects. Safe to call any number of times, concurrently or otherwise. */
  stop(): Promise<void> {
    this.stopPromise ??= this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    this.state = 'stopping';
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    // An interrupted register means an *unknown* remote outcome, not a
    // confirmed registration: the POST may already have been applied by
    // Eureka even though we cancel it before its response arrives. Nothing
    // after stop() will ever renew and reconcile that, so we DELETE
    // conservatively (a DELETE of an unknown instance is a 404, which
    // deregister() treats as success). Don't reduce this to `if (registered)`.
    // Usually `registrationCleanupOwed` is also set by then (an abort is a
    // status-less attempt); this stays as the backstop for a client/fetch
    // that doesn't surface the abort that way.
    const interruptedRegister = this.activeOperation?.kind === 'register';
    this.activeOperation?.controller.abort();
    if (this.pendingOperation) {
      // Only to sequence our own cleanup — never alters what the original
      // start()/tick() caller observes from the same promise.
      await this.pendingOperation.catch(() => undefined);
    }
    // `registered` must only be inspected *after* awaiting whatever was in
    // flight, never before — otherwise a register that's about to succeed
    // could be missed and left dangling on the server.
    if (
      this.registered ||
      this.registrationCleanupOwed ||
      interruptedRegister
    ) {
      await this.deregisterBestEffort('during shutdown');
    }
    this.state = 'stopped';
  }

  /** Runs at most once per instance across both call sites (fail-fast
   *  start() failure, doStop()) — see their ownership guards. Only throws if
   *  the injected logger's `warn` does. */
  private async deregisterBestEffort(context: string): Promise<void> {
    try {
      // Deliberately no cancellation signal: nothing is left to cancel it
      // for. With one configured server this is one request, bounded by
      // requestTimeoutMs; with several, deregister() attempts every one of
      // them sequentially (see #17), up to serviceUrls.length *
      // requestTimeoutMs in the worst case.
      await this.client.deregister();
    } catch (error) {
      this.logger.warn(
        `Eureka deregister failed ${context}: ${(error as Error).message}`,
      );
    } finally {
      // The attempt was made; retrying it later can't improve anything.
      this.registered = false;
      this.registrationCleanupOwed = false;
    }
  }

  /** Every register call goes through here so an ambiguous attempt is never missed. */
  private register(): Promise<void> {
    return this.runOperation('register', (signal) =>
      this.client.register(signal, () => {
        this.registrationCleanupOwed = true;
      }),
    );
  }

  private scheduleHeartbeat(): void {
    const timer = setTimeout(() => {
      // `tick()` is documented to never throw, but that guarantee is only as
      // good as the injected logger's own `warn`/`error` never throwing. If a
      // caller-supplied logger does throw, this `.catch()` is what stands
      // between that and an unhandled promise rejection (which, depending on
      // Node's configuration, can crash the host process) — `pendingOperation`
      // otherwise sits unobserved until `stop()` happens to await it.
      this.pendingOperation = this.tick().catch(() => undefined);
    }, this.heartbeatIntervalMs);
    timer.unref();
    this.heartbeatTimer = timer;
  }

  /** Runs one lifecycle HTTP call as the (single) cancellable active operation. */
  private async runOperation<T>(
    kind: ActiveOperation['kind'],
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operation: ActiveOperation = {
      kind,
      controller: new AbortController(),
    };
    this.activeOperation = operation;
    try {
      return await call(operation.controller.signal);
    } finally {
      if (this.activeOperation === operation) this.activeOperation = undefined;
    }
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.runOperation('renew', (signal) =>
        this.client.renew(signal),
      );
      // Record what the server just told us *before* checking whether stop()
      // landed during the renew — stop() reads `registered` right after this
      // settles. 'renewed' proves the server has our lease even if an earlier
      // register (the initial one in background mode, or a previous tick's
      // re-register below) failed client-side after succeeding server-side;
      // 'not-found' proves the server that answered doesn't. Deliberately
      // leaves `registrationCleanupOwed` alone: with several independent
      // servers, one server's answer can't clear an ambiguous register on
      // another.
      this.registered = result === 'renewed';
      if (this.state !== 'running') return; // stop() may have landed during the renew call
      if (result === 'not-found') {
        this.logger.warn(
          'Eureka heartbeat returned 404 (instance not found); re-registering',
        );
        try {
          await this.register();
          this.registered = true;
        } catch (error) {
          // Background retry path, not the fail-fast startup path: log and
          // keep the heartbeat loop running. The next tick will see 404
          // again and retry this one-shot re-register. Not logged when
          // stop() aborted it — that's a normal shutdown, not a failure.
          if (this.state === 'running') {
            this.logger.error(
              `Eureka re-registration after 404 failed: ${(error as Error).message}`,
            );
          }
        }
        if (this.state !== 'running') return; // stop() may have landed during the re-register call
      }
    } catch (error) {
      // Network/timeout/5xx on renew (or stop()'s own abort): keep the
      // schedule (no backoff). `registered` is deliberately left untouched —
      // only an explicit 404 proves Eureka doesn't know this instance. Only
      // warn while running: a shutdown-aborted renew isn't a failure.
      if (this.state === 'running') {
        this.logger.warn(
          `Eureka heartbeat failed: ${(error as Error).message}`,
        );
      }
    } finally {
      if (this.state === 'running') this.scheduleHeartbeat();
    }
  }
}
