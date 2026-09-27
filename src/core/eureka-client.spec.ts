import { EurekaClient } from './eureka-client';
import { EurekaRequestError } from './errors';
import { resolveOptions, type ResolvedEurekaOptions } from './options';

function mockResponse(init: {
  ok: boolean;
  status: number;
  statusText?: string;
  json?: () => Promise<unknown>;
  body?: { cancel: jest.Mock };
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    statusText: init.statusText ?? '',
    body: init.body,
    json:
      init.json ??
      (() =>
        Promise.reject(
          new Error(
            'response.json() should not have been called for this operation',
          ),
        )),
  } as unknown as Response;
}

describe('EurekaClient', () => {
  let fetchMock: jest.Mock;
  let resolved: ResolvedEurekaOptions;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    resolved = resolveOptions({
      serviceUrl: 'http://user:pass@localhost:8761/eureka',
      instance: {
        app: 'my-app',
        hostName: 'host-1',
        ipAddr: '10.0.0.1',
        port: 3000,
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('register(): POSTs the registration body with the right headers and never parses a response body', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 204 }));
    const client = new EurekaClient(resolved);

    await client.register();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8761/eureka/apps/MY-APP'); // no credentials in the URL
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/json');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('user:pass').toString('base64')}`,
    );
    const parsedBody = JSON.parse(init.body as string) as {
      instance: { instanceId: string };
    };
    expect(parsedBody.instance.instanceId).toBe('host-1:my-app:3000');
  });

  it('drains the response body on every call so a keep-alive connection can be released back to the pool', async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(
      mockResponse({ ok: true, status: 204, body: { cancel } }),
    );
    const client = new EurekaClient(resolved);

    await client.register();

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('register(): throws EurekaRequestError on a non-2xx status', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: false, status: 400, statusText: 'Bad Request' }),
    );
    const client = new EurekaClient(resolved);
    await expect(client.register()).rejects.toMatchObject({
      status: 400,
      operation: 'register',
    });
  });

  it('renew(): 200 -> "renewed"', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200 }));
    const client = new EurekaClient(resolved);
    await expect(client.renew()).resolves.toBe('renewed');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://localhost:8761/eureka/apps/MY-APP/host-1%3Amy-app%3A3000',
    );
    expect(init.method).toBe('PUT');
  });

  it('renew(): 404 -> "not-found" (a result, not a thrown error)', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
    const client = new EurekaClient(resolved);
    await expect(client.renew()).resolves.toBe('not-found');
  });

  it('renew(): other non-2xx statuses throw', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500 }));
    const client = new EurekaClient(resolved);
    await expect(client.renew()).rejects.toMatchObject({
      status: 500,
      operation: 'renew',
    });
  });

  it('deregister(): 200 and 404 both resolve (idempotent)', async () => {
    const client = new EurekaClient(resolved);
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200 }));
    await expect(client.deregister()).resolves.toBeUndefined();
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
    await expect(client.deregister()).resolves.toBeUndefined();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
  });

  it('deregister(): other non-2xx statuses throw', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500 }));
    const client = new EurekaClient(resolved);
    await expect(client.deregister()).rejects.toMatchObject({
      status: 500,
      operation: 'deregister',
    });
  });

  it('getInstances(): 404 -> empty array', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
    const client = new EurekaClient(resolved);
    await expect(client.getInstances('other-app')).resolves.toEqual([]);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8761/eureka/apps/OTHER-APP');
  });

  it('getInstances(): 200 -> parses the body', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            application: {
              instance: {
                instanceId: 'i',
                app: 'OTHER-APP',
                hostName: 'h',
                ipAddr: '1.2.3.4',
                status: 'UP',
              },
            },
          }),
      }),
    );
    const client = new EurekaClient(resolved);
    const instances = await client.getInstances('other-app');
    expect(instances).toEqual([
      expect.objectContaining({
        instanceId: 'i',
        app: 'OTHER-APP',
        status: 'UP',
      }),
    ]);
  });

  it('getInstances(): other non-2xx statuses throw', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500 }));
    const client = new EurekaClient(resolved);
    await expect(client.getInstances('other-app')).rejects.toMatchObject({
      status: 500,
      operation: 'discovery',
    });
  });

  it('getInstances(): a malformed body raises a discovery EurekaRequestError, not a raw parse error', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ nope: true }),
      }),
    );
    const client = new EurekaClient(resolved);
    await expect(client.getInstances('other-app')).rejects.toBeInstanceOf(
      EurekaRequestError,
    );
  });

  it('never leaks credentials in a thrown error even when the underlying network error mentions them', async () => {
    fetchMock.mockRejectedValue(
      new Error('connect ECONNREFUSED to http://user:hunter2@localhost:8761'),
    );
    const client = new EurekaClient(resolved);

    let error: EurekaRequestError | undefined;
    try {
      await client.renew();
    } catch (err) {
      error = err as EurekaRequestError;
    }

    expect(error).toBeInstanceOf(EurekaRequestError);
    expect(error!.message).not.toContain('hunter2');
    expect(error!.url).not.toContain('hunter2');
    // Check every own-enumerable field individually (operation/method/url/status/statusText —
    // `message` and `cause` are non-enumerable per the ECMAScript Error spec, so
    // `JSON.stringify(error)` would exclude them either way and wouldn't actually
    // prove anything about our own sanitization).
    for (const value of Object.values(error!)) {
      expect(String(value)).not.toContain('hunter2');
    }
    // `cause` is deliberately retained (non-enumerable, for debugging) and does still
    // contain it — that's intentional, it's just never surfaced in message/url/JSON output.
    expect((error!.cause as Error).message).toContain('hunter2');
  });

  describe('timeout and cancellation', () => {
    // Behaves like a real fetch that never gets a response: settles only when
    // the request's signal aborts, with the signal's reason.
    function hangingFetch(_url: string, init: RequestInit): Promise<Response> {
      return new Promise((_resolve, reject) => {
        const signal = init.signal!;
        if (signal.aborted) return reject(signal.reason as Error);
        signal.addEventListener('abort', () => reject(signal.reason as Error), {
          once: true,
        });
      });
    }

    function clientWithTimeout(requestTimeoutMs: number): EurekaClient {
      return new EurekaClient(
        resolveOptions({
          serviceUrl: 'http://localhost:8761/eureka',
          instance: {
            app: 'my-app',
            hostName: 'host-1',
            ipAddr: '10.0.0.1',
            port: 3000,
          },
          requestTimeoutMs,
        }),
      );
    }

    it('uses the configured requestTimeoutMs for the timeout signal', async () => {
      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200 }));

      await clientWithTimeout(1234).renew();

      expect(timeoutSpy).toHaveBeenCalledWith(1234);
    });

    it('a hanging request rejects with EurekaRequestError once requestTimeoutMs elapses', async () => {
      fetchMock.mockImplementation(hangingFetch);

      const error = await clientWithTimeout(20)
        .renew()
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EurekaRequestError);
      expect((error as EurekaRequestError).operation).toBe('renew');
      expect(((error as EurekaRequestError).cause as Error).name).toBe(
        'TimeoutError',
      );
    });

    it.each(['register', 'renew'] as const)(
      '%s(): a caller abort rejects well before a long requestTimeoutMs',
      async (operation) => {
        fetchMock.mockImplementation(hangingFetch);
        const controller = new AbortController();
        const client = clientWithTimeout(60_000);

        const started = Date.now();
        const pending = client[operation](controller.signal).catch(
          (e: unknown) => e,
        );
        controller.abort();
        const error = await pending;

        expect(Date.now() - started).toBeLessThan(1_000);
        expect(error).toBeInstanceOf(EurekaRequestError);
        expect((error as EurekaRequestError).operation).toBe(operation);
        expect(((error as EurekaRequestError).cause as Error).name).toBe(
          'AbortError',
        );
      },
    );

    it('a caller signal that never aborts does not suppress the timeout (both signals are truly combined)', async () => {
      fetchMock.mockImplementation(hangingFetch);
      // Never aborted — present only to prove the timeout still fires when
      // composed with a live caller signal, not just when one is absent.
      const controller = new AbortController();

      const error = await clientWithTimeout(20)
        .renew(controller.signal)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EurekaRequestError);
      expect(((error as EurekaRequestError).cause as Error).name).toBe(
        'TimeoutError',
      );
    });

    it('an already-aborted caller signal rejects cleanly (async) as EurekaRequestError', async () => {
      fetchMock.mockImplementation(hangingFetch);
      const controller = new AbortController();
      controller.abort();

      let pending: Promise<unknown> | undefined;
      expect(() => {
        pending = clientWithTimeout(60_000).register(controller.signal);
      }).not.toThrow();

      await expect(pending).rejects.toBeInstanceOf(EurekaRequestError);
    });

    it('deregister() and getInstances() never compose a caller signal (no AbortSignal.any call, timeout signal used as-is)', async () => {
      const anySpy = jest.spyOn(AbortSignal, 'any');
      fetchMock.mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              application: {
                instance: {
                  instanceId: 'i',
                  app: 'OTHER-APP',
                  hostName: 'h',
                  ipAddr: '1.2.3.4',
                  status: 'UP',
                },
              },
            }),
        }),
      );
      const client = clientWithTimeout(60_000);

      await client.deregister();
      await client.getInstances('other-app');

      expect(anySpy).not.toHaveBeenCalled();
      for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.signal!.aborted).toBe(false);
      }
    });

    it('a caller-signal abort during multi-server failover propagates immediately with zero further attempts', async () => {
      fetchMock.mockImplementation(hangingFetch);
      const controller = new AbortController();
      const client = new EurekaClient(
        resolveOptions({
          serviceUrl: ['http://a:8761/eureka', 'http://b:8762/eureka'],
          instance: {
            app: 'my-app',
            hostName: 'host-1',
            ipAddr: '10.0.0.1',
            port: 3000,
          },
        }),
      );

      const pending = client.renew(controller.signal).catch((e: unknown) => e);
      controller.abort();
      const error = await pending;

      expect(error).toBeInstanceOf(EurekaRequestError);
      expect(((error as EurekaRequestError).cause as Error).name).toBe(
        'AbortError',
      );
      // Only server A was ever attempted — the abort is not a per-server
      // failure to fail over from, it's an immediate stop.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a plain per-server timeout (no caller abort) does fail over to the next server', async () => {
      fetchMock.mockImplementation((url: string, init: RequestInit) =>
        url.includes('a:8761')
          ? hangingFetch(url, init)
          : Promise.resolve(mockResponse({ ok: true, status: 200 })),
      );
      const client = new EurekaClient(
        resolveOptions({
          serviceUrl: ['http://a:8761/eureka', 'http://b:8762/eureka'],
          instance: {
            app: 'my-app',
            hostName: 'host-1',
            ipAddr: '10.0.0.1',
            port: 3000,
          },
          requestTimeoutMs: 20,
        }),
      );

      await expect(client.renew()).resolves.toBe('renewed');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('multi-server failover', () => {
    function twoServerClient(
      urls: [string, string] = ['http://a:8761/eureka', 'http://b:8762/eureka'],
    ): EurekaClient {
      return new EurekaClient(
        resolveOptions({
          serviceUrl: urls,
          instance: {
            app: 'my-app',
            hostName: 'host-1',
            ipAddr: '10.0.0.1',
            port: 3000,
          },
        }),
      );
    }

    it('fails over to the next server on a network error, then prefers it on the next call', async () => {
      const client = twoServerClient();
      fetchMock.mockImplementation((url: string) =>
        url.includes('a:8761')
          ? Promise.reject(new Error('ECONNREFUSED'))
          : Promise.resolve(mockResponse({ ok: true, status: 200 })),
      );

      await expect(client.renew()).resolves.toBe('renewed');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [firstUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
      const [secondUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(firstUrl).toContain('a:8761');
      expect(secondUrl).toContain('b:8762');

      fetchMock.mockClear();
      await expect(client.renew()).resolves.toBe('renewed');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [thirdUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(thirdUrl).toContain('b:8762');
    });

    it('fails over to the next server on a 5xx response', async () => {
      const client = twoServerClient();
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('a:8761')
            ? mockResponse({ ok: false, status: 503 })
            : mockResponse({ ok: true, status: 200 }),
        ),
      );

      await expect(client.renew()).resolves.toBe('renewed');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not fail over on a 4xx — a real answer from a reachable node — and does not move preferredIndex', async () => {
      const client = twoServerClient();
      // A (currently preferred) is retryable (503); B is terminal (400). If a
      // bug updated preferredIndex on *any* attempt (including a throw), it
      // would move to B (index 1) here — either from A's own 503 throw, or
      // from B's 400 throw. The follow-up call proves neither happened.
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('a:8761')
            ? mockResponse({ ok: false, status: 503 })
            : mockResponse({ ok: false, status: 400 }),
        ),
      );

      await expect(client.register()).rejects.toMatchObject({ status: 400 });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockClear();
      fetchMock.mockImplementation(() =>
        Promise.resolve(mockResponse({ ok: true, status: 204 })),
      );
      await client.register();
      // preferredIndex is still A — neither A's 503 nor B's 400 (both thrown
      // errors) moved it.
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('a:8761');
    });

    it('renew() 404 counts as a definitive answer — no failover, and it sets that server preferred', async () => {
      const client = twoServerClient();
      // A (currently preferred) is retryable (503); B answers 404 — a
      // definitive "not-found" *return*, not a throw, ending the loop there.
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('a:8761')
            ? mockResponse({ ok: false, status: 503 })
            : mockResponse({ ok: false, status: 404 }),
        ),
      );
      await expect(client.renew()).resolves.toBe('not-found');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // The next call starts at B, not the default A — proving specifically
      // that the 404 *return* (not the prior 503 throw) moved preferredIndex.
      fetchMock.mockClear();
      fetchMock.mockImplementation(() =>
        Promise.resolve(mockResponse({ ok: true, status: 200 })),
      );
      await client.renew();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('b:8762');
    });

    it('a malformed discovery response (reachable, bad data) does not fail over', async () => {
      const client = twoServerClient();
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('a:8761')
            ? mockResponse({
                ok: true,
                status: 200,
                json: () => Promise.reject(new Error('bad json')),
              })
            : mockResponse({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ application: { instance: [] } }),
              }),
        ),
      );

      const error = await client
        .getInstances('other-app')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EurekaRequestError);
      expect((error as EurekaRequestError).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1); // B never contacted
    });

    it("throws the last server's error when all servers fail, having tried each exactly once", async () => {
      const client = twoServerClient();
      fetchMock
        .mockImplementationOnce(() => Promise.reject(new Error('a down')))
        .mockImplementationOnce(() => Promise.reject(new Error('b down')));

      const error = await client.renew().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EurekaRequestError);
      expect(((error as EurekaRequestError).cause as Error).message).toBe(
        'b down',
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('deregister() fails over on a network error, with no caller signal involved', async () => {
      const client = twoServerClient();
      fetchMock
        .mockImplementationOnce(() => Promise.reject(new Error('a down')))
        .mockImplementationOnce(() =>
          Promise.resolve(mockResponse({ ok: true, status: 200 })),
        );

      await expect(client.deregister()).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('getInstances() fails over on a 5xx response', async () => {
      const client = twoServerClient();
      fetchMock
        .mockImplementationOnce(() =>
          Promise.resolve(mockResponse({ ok: false, status: 503 })),
        )
        .mockImplementationOnce(() =>
          Promise.resolve(
            mockResponse({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ application: { instance: [] } }),
            }),
          ),
        );

      await expect(client.getInstances('other-app')).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("builds each attempt's URL and Authorization header from the same server entry — never mixes credentials", async () => {
      const client = new EurekaClient(
        resolveOptions({
          serviceUrl: [
            'http://alice:a-secret@a:8761/eureka',
            'http://bob:b-secret@b:8762/eureka',
          ],
          instance: {
            app: 'my-app',
            hostName: 'host-1',
            ipAddr: '10.0.0.1',
            port: 3000,
          },
        }),
      );
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('a:8761')
            ? mockResponse({ ok: false, status: 503 })
            : mockResponse({ ok: true, status: 200 }),
        ),
      );

      await expect(client.renew()).resolves.toBe('renewed');

      const [firstCall, secondCall] = fetchMock.mock.calls as [
        string,
        RequestInit,
      ][];
      const authA = (firstCall[1].headers as Record<string, string>)
        .Authorization;
      const authB = (secondCall[1].headers as Record<string, string>)
        .Authorization;
      expect(authA).toBe(
        `Basic ${Buffer.from('alice:a-secret').toString('base64')}`,
      );
      expect(authB).toBe(
        `Basic ${Buffer.from('bob:b-secret').toString('base64')}`,
      );
      expect(firstCall[0]).not.toContain('alice');
      expect(firstCall[0]).not.toContain('a-secret');
      expect(secondCall[0]).not.toContain('bob');
      expect(secondCall[0]).not.toContain('b-secret');
    });
  });
});
