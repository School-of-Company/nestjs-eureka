import type { EurekaClient, RenewResult } from './eureka-client';
import { EurekaRegistration } from './eureka-registration';
import type { EurekaLogger } from './logger';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createClientMock() {
  return {
    register: jest.fn<Promise<void>, [AbortSignal?]>(),
    renew: jest.fn<Promise<RenewResult>, [AbortSignal?]>(),
    deregister: jest.fn<Promise<void>, []>(),
  };
}

/** Like a real fetch that never gets a response: settles only when its signal aborts. */
function hangUntilAborted<T>() {
  return (signal?: AbortSignal) =>
    new Promise<T>((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => reject(new Error('Eureka request failed')),
        { once: true },
      );
    });
}
type ClientMock = ReturnType<typeof createClientMock>;

function createLoggerMock(): jest.Mocked<EurekaLogger> {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function newRegistration(
  client: ClientMock,
  heartbeatIntervalMs: number,
  logger: EurekaLogger,
  registrationMode: 'fail-fast' | 'background' = 'fail-fast',
) {
  return new EurekaRegistration(
    client as unknown as EurekaClient,
    heartbeatIntervalMs,
    logger,
    registrationMode,
  );
}

describe('EurekaRegistration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('heartbeat cadence', () => {
    it('registers once on start(), then renews on schedule', async () => {
      const client = createClientMock();
      client.register.mockResolvedValue(undefined);
      client.renew.mockResolvedValue('renewed');
      const registration = newRegistration(client, 1000, createLoggerMock());

      await registration.start();
      expect(client.register).toHaveBeenCalledTimes(1);
      expect(client.renew).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1000);
      expect(client.renew).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1000);
      expect(client.renew).toHaveBeenCalledTimes(2);
    });

    it('never overlaps heartbeats when a renew call is slow', async () => {
      const client = createClientMock();
      client.register.mockResolvedValue(undefined);
      const renewDeferred = createDeferred<RenewResult>();
      client.renew.mockReturnValue(renewDeferred.promise);
      const registration = newRegistration(client, 1000, createLoggerMock());
      await registration.start();

      await jest.advanceTimersByTimeAsync(1000);
      expect(client.renew).toHaveBeenCalledTimes(1);

      // Far past another interval, but the in-flight renew hasn't settled yet.
      await jest.advanceTimersByTimeAsync(5000);
      expect(client.renew).toHaveBeenCalledTimes(1);

      renewDeferred.resolve('renewed');
      await jest.advanceTimersByTimeAsync(1000);
      expect(client.renew).toHaveBeenCalledTimes(2);
    });

    it('stop() prevents all future heartbeat work', async () => {
      const client = createClientMock();
      client.register.mockResolvedValue(undefined);
      client.renew.mockResolvedValue('renewed');
      client.deregister.mockResolvedValue(undefined);
      const registration = newRegistration(client, 1000, createLoggerMock());
      await registration.start();
      await registration.stop();

      await jest.advanceTimersByTimeAsync(10_000);

      expect(client.renew).not.toHaveBeenCalled();
    });
  });

  describe('404 -> re-register', () => {
    it('re-registers once when renew reports not-found, and continues heartbeating', async () => {
      const client = createClientMock();
      client.register.mockResolvedValue(undefined);
      const logger = createLoggerMock();
      const registration = newRegistration(client, 1000, logger);
      await registration.start();

      client.renew.mockResolvedValue('not-found');
      await jest.advanceTimersByTimeAsync(1000);

      expect(client.register).toHaveBeenCalledTimes(2); // initial + re-register
      expect(logger.warn).toHaveBeenCalled();

      client.renew.mockResolvedValue('renewed');
      await jest.advanceTimersByTimeAsync(1000);
      expect(client.renew).toHaveBeenCalledTimes(2);
    });

    it('keeps the heartbeat loop running when a re-register fails without a concurrent stop()', async () => {
      const client = createClientMock();
      client.register.mockResolvedValueOnce(undefined);
      const logger = createLoggerMock();
      const registration = newRegistration(client, 1000, logger);
      await registration.start();

      client.renew.mockResolvedValue('not-found');
      client.register.mockRejectedValueOnce(new Error('still unreachable'));
      await jest.advanceTimersByTimeAsync(1000);

      expect(logger.error).toHaveBeenCalled();
      expect(client.register).toHaveBeenCalledTimes(2);

      client.register.mockResolvedValueOnce(undefined);
      await jest.advanceTimersByTimeAsync(1000);

      expect(client.register).toHaveBeenCalledTimes(3);
    });

    it('restores registered=true on the next successful renew, even after a re-register attempt failed client-side (regression: a stuck-false `registered` would make stop() skip a DELETE that was owed)', async () => {
      const client = createClientMock();
      client.register.mockResolvedValueOnce(undefined);
      client.deregister.mockResolvedValue(undefined);
      const registration = newRegistration(client, 1000, createLoggerMock());
      await registration.start();

      // Tick 1: 404 -> one-shot re-register attempt fails client-side (e.g. a
      // timeout) even though the server may well have processed it.
      client.renew.mockResolvedValueOnce('not-found');
      client.register.mockRejectedValueOnce(new Error('timed out'));
      await jest.advanceTimersByTimeAsync(1000);

      // Tick 2: the server confirms we're actually registered after all.
      client.renew.mockResolvedValueOnce('renewed');
      await jest.advanceTimersByTimeAsync(1000);

      await registration.stop();

      expect(client.deregister).toHaveBeenCalledTimes(1);
    });

    it('keeps the heartbeat loop running when renew itself throws (network error/5xx), not just on a 404', async () => {
      const client = createClientMock();
      client.register.mockResolvedValue(undefined);
      const logger = createLoggerMock();
      const registration = newRegistration(client, 1000, logger);
      await registration.start();

      client.renew.mockRejectedValueOnce(new Error('ECONNRESET'));
      await jest.advanceTimersByTimeAsync(1000);
      expect(logger.warn).toHaveBeenCalled();

      client.renew.mockResolvedValueOnce('renewed');
      await jest.advanceTimersByTimeAsync(1000);
      expect(client.renew).toHaveBeenCalledTimes(2);
    });
  });

  describe('logger robustness', () => {
    it('never leaves an unhandled rejection even if the injected logger itself throws', async () => {
      const client = createClientMock();
      client.register.mockResolvedValue(undefined);
      client.deregister.mockResolvedValue(undefined);
      const throwingLogger: EurekaLogger = {
        log: jest.fn(),
        warn: jest.fn(() => {
          throw new Error('logger is broken');
        }),
        error: jest.fn(() => {
          throw new Error('logger is broken');
        }),
      };
      const registration = newRegistration(client, 1000, throwingLogger);
      await registration.start();

      // Triggers a `logger.warn` call inside `tick()`; if the resulting
      // rejection weren't caught, this would surface as an unhandled
      // rejection (and, in a real process, could crash it) rather than
      // merely being observable via `stop()`.
      client.renew.mockResolvedValue('not-found');
      await jest.advanceTimersByTimeAsync(1000);

      await expect(registration.stop()).resolves.toBeUndefined();
    });
  });

  describe('start() failure is terminal (fail-fast)', () => {
    it('rejects with the original error and moves to a terminal state', async () => {
      const client = createClientMock();
      const error = new Error('registration failed');
      client.register.mockRejectedValue(error);
      const registration = newRegistration(client, 1000, createLoggerMock());

      await expect(registration.start()).rejects.toBe(error);
      await expect(registration.start()).rejects.toThrow(/cannot be restarted/);
    });

    it('behaves identically regardless of how the caller awaits/catches the failure', async () => {
      const client = createClientMock();
      client.register.mockRejectedValue(new Error('boom'));
      const registration = newRegistration(client, 1000, createLoggerMock());

      await registration.start().catch(() => undefined);
      await expect(registration.start()).rejects.toThrow(/cannot be restarted/);
    });
  });

  describe('start()/stop() ownership races', () => {
    it('stop() during an in-flight initial register that then succeeds still sends exactly one DELETE', async () => {
      const client = createClientMock();
      const registerDeferred = createDeferred<void>();
      client.register.mockReturnValue(registerDeferred.promise);
      client.deregister.mockResolvedValue(undefined);
      const registration = newRegistration(client, 1000, createLoggerMock());

      const startPromise = registration.start();
      const stopPromise = registration.stop();
      registerDeferred.resolve();

      await startPromise;
      await stopPromise;

      expect(client.deregister).toHaveBeenCalledTimes(1);
    });

    it('stop() during an in-flight initial register that then fails: start() still rejects with the original error, stop() resolves cleanly with one best-effort DELETE (outcome unknown, no deadlock)', async () => {
      const client = createClientMock();
      const registerDeferred = createDeferred<void>();
      client.register.mockReturnValue(registerDeferred.promise);
      client.deregister.mockResolvedValue(undefined);
      const registerError = new Error('eureka unreachable');
      const registration = newRegistration(client, 1000, createLoggerMock());

      const startPromise = registration.start();
      const stopPromise = registration.stop();
      registerDeferred.reject(registerError);

      await expect(startPromise).rejects.toBe(registerError);
      await expect(stopPromise).resolves.toBeUndefined();
      expect(client.deregister).toHaveBeenCalledTimes(1);
    });

    it('stop() during a 404-triggered re-register that then succeeds waits for it, then sends exactly one DELETE', async () => {
      const client = createClientMock();
      client.register.mockResolvedValueOnce(undefined);
      const registration = newRegistration(client, 1000, createLoggerMock());
      await registration.start();

      client.renew.mockResolvedValue('not-found');
      const reRegisterDeferred = createDeferred<void>();
      client.register.mockReturnValueOnce(reRegisterDeferred.promise);
      client.deregister.mockResolvedValue(undefined);

      await jest.advanceTimersByTimeAsync(1000);
      // Confirm the re-register is genuinely in flight (not already settled)
      // before stop() is called — otherwise this test wouldn't actually be
      // exercising the race it claims to.
      expect(client.register).toHaveBeenCalledTimes(2);

      const stopPromise = registration.stop();
      reRegisterDeferred.resolve();
      await stopPromise;

      expect(client.deregister).toHaveBeenCalledTimes(1);
    });

    it('stop() during a 404-triggered re-register that fails sends one best-effort DELETE (outcome unknown)', async () => {
      const client = createClientMock();
      client.register.mockResolvedValueOnce(undefined);
      client.deregister.mockResolvedValue(undefined);
      const registration = newRegistration(client, 1000, createLoggerMock());
      await registration.start();

      client.renew.mockResolvedValue('not-found');
      const reRegisterDeferred = createDeferred<void>();
      client.register.mockReturnValueOnce(reRegisterDeferred.promise);

      await jest.advanceTimersByTimeAsync(1000);

      const stopPromise = registration.stop();
      reRegisterDeferred.reject(new Error('still unreachable'));

      await expect(stopPromise).resolves.toBeUndefined();
      expect(client.deregister).toHaveBeenCalledTimes(1);
    });
  });

  describe('idempotency', () => {
    it('concurrent stop() calls share one execution and send exactly one DELETE', async () => {
      const client = createClientMock();
      client.register.mockResolvedValue(undefined);
      client.deregister.mockResolvedValue(undefined);
      const registration = newRegistration(client, 1000, createLoggerMock());
      await registration.start();

      await Promise.all([registration.stop(), registration.stop()]);

      expect(client.deregister).toHaveBeenCalledTimes(1);
    });

    it('repeated stop() after a successful shutdown resolves without an extra DELETE', async () => {
      const client = createClientMock();
      client.register.mockResolvedValue(undefined);
      client.deregister.mockResolvedValue(undefined);
      const registration = newRegistration(client, 1000, createLoggerMock());
      await registration.start();
      await registration.stop();

      await expect(registration.stop()).resolves.toBeUndefined();
      expect(client.deregister).toHaveBeenCalledTimes(1);
    });

    it('concurrent start() calls share a single register() call', async () => {
      const client = createClientMock();
      const registerDeferred = createDeferred<void>();
      client.register.mockReturnValue(registerDeferred.promise);
      const registration = newRegistration(client, 1000, createLoggerMock());

      const [a, b] = [registration.start(), registration.start()];
      registerDeferred.resolve();
      await Promise.all([a, b]);

      expect(client.register).toHaveBeenCalledTimes(1);
    });

    it('deregister failing during stop() logs a warning and still resolves', async () => {
      const client = createClientMock();
      client.register.mockResolvedValue(undefined);
      const deregisterError = new Error('server unreachable');
      client.deregister.mockRejectedValue(deregisterError);
      const logger = createLoggerMock();
      const registration = newRegistration(client, 1000, logger);
      await registration.start();

      await expect(registration.stop()).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('server unreachable'),
      );
    });

    it('stop() after a failed start() resolves without sending a DELETE', async () => {
      const client = createClientMock();
      client.register.mockRejectedValue(new Error('registration failed'));
      const registration = newRegistration(client, 1000, createLoggerMock());

      await expect(registration.start()).rejects.toThrow('registration failed');
      await expect(registration.stop()).resolves.toBeUndefined();

      expect(client.deregister).not.toHaveBeenCalled();
    });

    it('no heartbeat is ever scheduled when stop() lands during the in-flight initial register', async () => {
      const client = createClientMock();
      const registerDeferred = createDeferred<void>();
      client.register.mockReturnValue(registerDeferred.promise);
      const registration = newRegistration(client, 1000, createLoggerMock());

      const startPromise = registration.start();
      const stopPromise = registration.stop();
      registerDeferred.resolve();
      await startPromise;
      await stopPromise;

      await jest.advanceTimersByTimeAsync(10_000);
      expect(client.renew).not.toHaveBeenCalled();
    });

    it('start() while already running is a no-op', async () => {
      const client = createClientMock();
      client.register.mockResolvedValue(undefined);
      const registration = newRegistration(client, 1000, createLoggerMock());
      await registration.start();

      await registration.start();

      expect(client.register).toHaveBeenCalledTimes(1);
    });
  });

  describe('shutdown cancellation', () => {
    it('stop() aborts a hanging renew instead of waiting for it, then DELETEs with no cancellation signal', async () => {
      const client = createClientMock();
      client.register.mockResolvedValue(undefined);
      client.renew.mockImplementation(hangUntilAborted<RenewResult>());
      client.deregister.mockResolvedValue(undefined);
      const logger = createLoggerMock();
      const registration = newRegistration(client, 1000, logger);
      await registration.start();

      await jest.advanceTimersByTimeAsync(1000);
      expect(client.renew).toHaveBeenCalledTimes(1);
      const renewSignal = client.renew.mock.calls[0][0]!;
      expect(renewSignal.aborted).toBe(false);

      await expect(registration.stop()).resolves.toBeUndefined();

      expect(renewSignal.aborted).toBe(true);
      expect(client.deregister).toHaveBeenCalledTimes(1);
      expect(client.deregister).toHaveBeenCalledWith();
      expect(jest.getTimerCount()).toBe(0);
      // A shutdown-aborted renew is not a heartbeat failure.
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('fail-fast: stop() aborts a hanging initial register; start() rejects, stop() resolves with one best-effort DELETE', async () => {
      const client = createClientMock();
      client.register.mockImplementation(hangUntilAborted<void>());
      client.deregister.mockResolvedValue(undefined);
      const registration = newRegistration(client, 1000, createLoggerMock());

      const startPromise = registration.start();
      const stopPromise = registration.stop();

      await expect(startPromise).rejects.toThrow();
      await expect(stopPromise).resolves.toBeUndefined();
      expect(client.register.mock.calls[0][0]!.aborted).toBe(true);
      expect(client.deregister).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('background: stop() aborts a hanging initial register; both resolve, one best-effort DELETE, no failure log', async () => {
      const client = createClientMock();
      client.register.mockImplementation(hangUntilAborted<void>());
      client.deregister.mockResolvedValue(undefined);
      const logger = createLoggerMock();
      const registration = newRegistration(client, 1000, logger, 'background');

      const startPromise = registration.start();
      const stopPromise = registration.stop();

      await expect(startPromise).resolves.toBeUndefined();
      await expect(stopPromise).resolves.toBeUndefined();
      expect(client.deregister).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('background, never registered: stop() aborting a hanging renew sends no DELETE', async () => {
      const client = createClientMock();
      client.register.mockRejectedValueOnce(new Error('eureka unreachable'));
      client.renew.mockImplementation(hangUntilAborted<RenewResult>());
      const logger = createLoggerMock();
      const registration = newRegistration(client, 1000, logger, 'background');
      await registration.start();
      expect(logger.warn).toHaveBeenCalledTimes(1); // the initial failure only

      await jest.advanceTimersByTimeAsync(1000);
      expect(client.renew).toHaveBeenCalledTimes(1);

      await expect(registration.stop()).resolves.toBeUndefined();

      expect(client.deregister).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('404 renew -> re-register in flight -> stop(): re-register is aborted, exactly one DELETE, no next heartbeat, no failure log', async () => {
      const client = createClientMock();
      client.register
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(hangUntilAborted<void>());
      client.renew.mockResolvedValueOnce('not-found');
      client.deregister.mockResolvedValue(undefined);
      const logger = createLoggerMock();
      const registration = newRegistration(client, 1000, logger);
      await registration.start();

      await jest.advanceTimersByTimeAsync(1000);
      expect(client.register).toHaveBeenCalledTimes(2);
      const reRegisterSignal = client.register.mock.calls[1][0]!;
      expect(reRegisterSignal.aborted).toBe(false);

      await expect(registration.stop()).resolves.toBeUndefined();

      expect(reRegisterSignal.aborted).toBe(true);
      expect(client.deregister).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(client.renew).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('each lifecycle call gets its own, not-yet-aborted signal', async () => {
      const client = createClientMock();
      client.register.mockResolvedValue(undefined);
      client.renew.mockResolvedValue('renewed');
      const registration = newRegistration(client, 1000, createLoggerMock());
      await registration.start();
      await jest.advanceTimersByTimeAsync(2000);

      const signals = [
        client.register.mock.calls[0][0],
        client.renew.mock.calls[0][0],
        client.renew.mock.calls[1][0],
      ];
      for (const signal of signals) {
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal!.aborted).toBe(false);
      }
      expect(new Set(signals).size).toBe(3);
    });
  });

  describe('background registration mode', () => {
    function newBackgroundRegistration(
      client: ClientMock,
      logger: EurekaLogger = createLoggerMock(),
    ) {
      return newRegistration(client, 1000, logger, 'background');
    }

    it('resolves start() and logs a warning when the initial register fails', async () => {
      const client = createClientMock();
      client.register.mockRejectedValue(new Error('eureka unreachable'));
      const logger = createLoggerMock();
      const registration = newBackgroundRegistration(client, logger);

      await expect(registration.start()).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('eureka unreachable'),
      );
      // Running, not terminal: a second start() is a no-op, not a rejection.
      await expect(registration.start()).resolves.toBeUndefined();
      expect(client.register).toHaveBeenCalledTimes(1);
    });

    it('case A: initial register throws, then renew succeeds -> no second POST, stop() sends DELETE', async () => {
      const client = createClientMock();
      client.register.mockRejectedValueOnce(new Error('timed out'));
      client.renew.mockResolvedValue('renewed');
      client.deregister.mockResolvedValue(undefined);
      const registration = newBackgroundRegistration(client);
      await registration.start();

      await jest.advanceTimersByTimeAsync(1000);
      expect(client.renew).toHaveBeenCalledTimes(1);

      await registration.stop();

      expect(client.register).toHaveBeenCalledTimes(1);
      expect(client.deregister).toHaveBeenCalledTimes(1);
    });

    it('case B: initial register throws, then renew returns 404 -> exactly one re-register POST, stop() sends DELETE', async () => {
      const client = createClientMock();
      client.register
        .mockRejectedValueOnce(new Error('eureka unreachable'))
        .mockResolvedValueOnce(undefined);
      client.renew
        .mockResolvedValue('renewed')
        .mockResolvedValueOnce('not-found');
      client.deregister.mockResolvedValue(undefined);
      const registration = newBackgroundRegistration(client);
      await registration.start();

      await jest.advanceTimersByTimeAsync(1000);
      expect(client.register).toHaveBeenCalledTimes(2);

      await registration.stop();

      expect(client.register).toHaveBeenCalledTimes(2);
      expect(client.deregister).toHaveBeenCalledTimes(1);
    });

    it('keeps retrying on the heartbeat cadence with a single timer while Eureka stays down, and sends no DELETE', async () => {
      const client = createClientMock();
      client.register.mockRejectedValue(new Error('eureka unreachable'));
      client.renew.mockRejectedValue(new Error('eureka unreachable'));
      const registration = newBackgroundRegistration(client);
      await registration.start();
      expect(jest.getTimerCount()).toBe(1);

      await jest.advanceTimersByTimeAsync(3000);

      expect(client.renew).toHaveBeenCalledTimes(3);
      expect(jest.getTimerCount()).toBe(1);

      await registration.stop();
      expect(client.deregister).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('a renew that throws (network/timeout/5xx) does not clear registered — stop() still sends DELETE', async () => {
      const client = createClientMock();
      client.register.mockRejectedValueOnce(new Error('timed out'));
      client.renew
        .mockResolvedValueOnce('renewed')
        .mockRejectedValueOnce(new Error('503'));
      client.deregister.mockResolvedValue(undefined);
      const registration = newBackgroundRegistration(client);
      await registration.start();

      await jest.advanceTimersByTimeAsync(2000);
      expect(client.renew).toHaveBeenCalledTimes(2);

      await registration.stop();
      expect(client.deregister).toHaveBeenCalledTimes(1);
    });

    it('stop() during an in-flight initial register that then fails: both resolve, one best-effort DELETE, no heartbeat scheduled', async () => {
      const client = createClientMock();
      const registerDeferred = createDeferred<void>();
      client.register.mockReturnValue(registerDeferred.promise);
      client.deregister.mockResolvedValue(undefined);
      const registration = newBackgroundRegistration(client);

      const startPromise = registration.start();
      const stopPromise = registration.stop();
      registerDeferred.reject(new Error('eureka unreachable'));

      await expect(startPromise).resolves.toBeUndefined();
      await expect(stopPromise).resolves.toBeUndefined();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(client.renew).not.toHaveBeenCalled();
      expect(client.deregister).toHaveBeenCalledTimes(1);
    });

    it('stop() during an in-flight initial register that then succeeds sends exactly one DELETE, no heartbeat scheduled', async () => {
      const client = createClientMock();
      const registerDeferred = createDeferred<void>();
      client.register.mockReturnValue(registerDeferred.promise);
      client.deregister.mockResolvedValue(undefined);
      const registration = newBackgroundRegistration(client);

      const startPromise = registration.start();
      const stopPromise = registration.stop();
      registerDeferred.resolve();
      await startPromise;
      await stopPromise;

      await jest.advanceTimersByTimeAsync(10_000);
      expect(client.renew).not.toHaveBeenCalled();
      expect(client.deregister).toHaveBeenCalledTimes(1);
    });

    it('stop() during an in-flight renew that then succeeds still sends the owed DELETE (initial POST had silently succeeded)', async () => {
      const client = createClientMock();
      client.register.mockRejectedValueOnce(new Error('timed out'));
      const renewDeferred = createDeferred<RenewResult>();
      client.renew.mockReturnValueOnce(renewDeferred.promise);
      client.deregister.mockResolvedValue(undefined);
      const registration = newBackgroundRegistration(client);
      await registration.start();

      await jest.advanceTimersByTimeAsync(1000);
      expect(client.renew).toHaveBeenCalledTimes(1);

      const stopPromise = registration.stop();
      renewDeferred.resolve('renewed');
      await stopPromise;

      expect(client.deregister).toHaveBeenCalledTimes(1);
    });

    it('stop() during an in-flight renew that then returns 404 sends no DELETE and no re-register', async () => {
      const client = createClientMock();
      client.register.mockResolvedValueOnce(undefined);
      const renewDeferred = createDeferred<RenewResult>();
      client.renew.mockReturnValueOnce(renewDeferred.promise);
      client.deregister.mockResolvedValue(undefined);
      const registration = newBackgroundRegistration(client);
      await registration.start();

      await jest.advanceTimersByTimeAsync(1000);
      const stopPromise = registration.stop();
      renewDeferred.resolve('not-found');
      await stopPromise;

      expect(client.register).toHaveBeenCalledTimes(1);
      expect(client.deregister).not.toHaveBeenCalled();
    });

    it('concurrent start() calls share a single register() call and both resolve even when it fails', async () => {
      const client = createClientMock();
      const registerDeferred = createDeferred<void>();
      client.register.mockReturnValue(registerDeferred.promise);
      const registration = newBackgroundRegistration(client);

      const [a, b] = [registration.start(), registration.start()];
      registerDeferred.reject(new Error('eureka unreachable'));

      await expect(Promise.all([a, b])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(client.register).toHaveBeenCalledTimes(1);
    });
  });
});
