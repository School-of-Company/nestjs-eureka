import type { EurekaClient } from './eureka-client';
import type { EurekaLogger } from './logger';

type State = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

/**
 * Lifecycle state machine for a single Eureka registration: register once,
 * heartbeat on a schedule, re-register on a 404 heartbeat response,
 * deregister on shutdown. No NestJS dependency — see `.claude/rules/architecture.md`.
 *
 * `stopped` is a terminal state: once reached (whether via a failed initial
 * `start()` or a completed `stop()`), this instance cannot be restarted —
 * construct a new one instead. This matches the library's fail-fast startup
 * contract.
 */
export class EurekaRegistration {
  private state: State = 'idle';
  private registered = false;
  /** Whatever single Eureka HTTP call is currently in flight (the initial
   *  register, or the current heartbeat tick's renew/re-register). Assigned
   *  synchronously, before any `await` inside it runs. */
  private pendingOperation?: Promise<void>;
  private heartbeatTimer?: NodeJS.Timeout;
  private stopPromise?: Promise<void>;

  constructor(
    private readonly client: EurekaClient,
    private readonly heartbeatIntervalMs: number,
    private readonly logger: EurekaLogger,
  ) {}

  /**
   * Registers with Eureka and starts the heartbeat loop. Rejects with the
   * original registration error on failure (fail-fast) — the caller (Nest's
   * `onApplicationBootstrap`) is expected to let that fail application boot.
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
        await this.client.register();
        this.registered = true;
        // stop() may have already claimed ownership of stopping->stopped
        // while this register call was in flight — if so, leave the state
        // transition and the resulting DELETE entirely to stop()'s own
        // sequence (it will see `registered === true`).
        if (this.state !== 'starting') return;
        this.state = 'running';
        this.scheduleHeartbeat();
      } catch (error) {
        // Only claim the `stopped` transition if it's still ours to claim —
        // stop() is the only path allowed to move `stopping -> stopped`.
        if (this.state === 'starting') this.state = 'stopped';
        throw error; // the original start() caller always sees this
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
    if (this.pendingOperation) {
      // Only to sequence our own cleanup — never alters what the original
      // start()/tick() caller observes from the same promise.
      await this.pendingOperation.catch(() => undefined);
    }
    // `registered` must only be inspected *after* awaiting whatever was in
    // flight, never before — otherwise a register that's about to succeed
    // could be missed and left dangling on the server.
    if (this.registered) {
      try {
        await this.client.deregister();
      } catch (error) {
        this.logger.warn(
          `Eureka deregister failed during shutdown: ${(error as Error).message}`,
        );
      }
      this.registered = false;
    }
    this.state = 'stopped';
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

  private async tick(): Promise<void> {
    try {
      const result = await this.client.renew();
      if (this.state !== 'running') return; // stop() may have landed during the renew call
      if (result === 'renewed') {
        // A successful renew is itself proof the server currently has our
        // lease — restate it even if a previous tick's one-shot re-register
        // (below) had failed client-side (e.g. timed out) after actually
        // succeeding server-side. Without this, `registered` could get stuck
        // `false` forever and `stop()` would skip a DELETE that was owed.
        this.registered = true;
      } else {
        // Eureka no longer has us — reflect that immediately, independent of
        // whether the one-shot re-register below succeeds.
        this.registered = false;
        this.logger.warn(
          'Eureka heartbeat returned 404 (instance not found); re-registering',
        );
        try {
          await this.client.register();
          this.registered = true;
        } catch (error) {
          // Background retry path, not the fail-fast startup path: log and
          // keep the heartbeat loop running. The next tick will see 404
          // again and retry this one-shot re-register.
          this.logger.error(
            `Eureka re-registration after 404 failed: ${(error as Error).message}`,
          );
        }
        if (this.state !== 'running') return; // stop() may have landed during the re-register call
      }
    } catch (error) {
      // Network/timeout/5xx on renew: log and keep the schedule (no backoff in v1).
      this.logger.warn(`Eureka heartbeat failed: ${(error as Error).message}`);
    } finally {
      if (this.state === 'running') this.scheduleHeartbeat();
    }
  }
}
