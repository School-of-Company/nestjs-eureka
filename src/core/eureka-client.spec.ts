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

/** What Node's fetch (undici) actually resolves with for
 *  `redirect: 'manual'` on a 3xx — unlike a browser, the real status/headers
 *  are exposed as-is, not hidden behind an opaque response. Verified
 *  directly against real undici (a local `node:http` server returning 301). */
function mockRedirectResponse(
  status = 301,
  init?: { body?: { cancel: jest.Mock }; location?: string },
): Response {
  return {
    type: 'basic',
    ok: false,
    status,
    statusText: 'Moved Permanently',
    body: init?.body,
    headers: new Headers(
      init?.location ? { Location: init.location } : undefined,
    ),
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

  describe('redirects are never followed', () => {
    it('passes redirect: "manual" on every request', async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200 }));
      const client = new EurekaClient(resolved);

      await client.renew();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.redirect).toBe('manual');
    });

    it.each(['register', 'renew', 'deregister'] as const)(
      '%s(): a 3xx response throws a clear, status-carrying EurekaRequestError, not a silent success',
      async (operation) => {
        fetchMock.mockResolvedValue(mockRedirectResponse(301));
        const client = new EurekaClient(resolved);

        const error = await client[operation]().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(EurekaRequestError);
        expect((error as EurekaRequestError).operation).toBe(operation);
        expect((error as EurekaRequestError).message).toContain('redirected');
        expect((error as EurekaRequestError).status).toBe(301);
      },
    );

    it('getInstances(): a 3xx response throws a clear EurekaRequestError', async () => {
      fetchMock.mockResolvedValue(mockRedirectResponse(302));
      const client = new EurekaClient(resolved);

      const error = await client
        .getInstances('other-app')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EurekaRequestError);
      expect((error as EurekaRequestError).operation).toBe('discovery');
      expect((error as EurekaRequestError).message).toContain('redirected');
      expect((error as EurekaRequestError).status).toBe(302);
    });

    it('never interpolates the Location header value into the error message', async () => {
      // The redirect target is untrusted input (whatever answered — not
      // Eureka's own configuration); a well-known pattern elsewhere in this
      // file is to never echo untrusted values into a message. The mocked
      // response carries a real Location header with a distinctive marker
      // (unlike a response with no `headers` at all, against which this
      // assertion would trivially pass either way) — the LEAK-MARKER
      // assertion below actually fails if the code is changed to read it.
      fetchMock.mockResolvedValue(
        mockRedirectResponse(301, {
          location: 'http://LEAK-MARKER.invalid/somewhere',
        }),
      );
      const client = new EurekaClient(resolved);

      const error = await client.renew().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EurekaRequestError);
      expect((error as EurekaRequestError).message).not.toContain(
        'LEAK-MARKER',
      );
      expect(String(error)).not.toContain('LEAK-MARKER');
    });

    it('drains the response body on a redirect, same as any other response', async () => {
      const cancel = jest.fn().mockResolvedValue(undefined);
      fetchMock.mockResolvedValue(
        mockRedirectResponse(301, { body: { cancel } }),
      );
      const client = new EurekaClient(resolved);

      await client.renew().catch(() => undefined);

      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('a 3xx response does NOT fail over to another configured server — it is a real, definitive answer, classified the same as a 4xx', async () => {
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
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('a:8761')
            ? mockRedirectResponse(301)
            : mockResponse({ ok: true, status: 200 }),
        ),
      );

      const error = await client.renew().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EurekaRequestError);
      expect((error as EurekaRequestError).status).toBe(301);
      expect(fetchMock).toHaveBeenCalledTimes(1); // B was never contacted
    });

    it('deregister() composes correctly with #17: a redirect on one server still lets every other configured server be attempted', async () => {
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
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('a:8761')
            ? mockRedirectResponse(301)
            : mockResponse({ ok: true, status: 200 }),
        ),
      );

      const error = await client.deregister().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EurekaRequestError);
      expect((error as EurekaRequestError).status).toBe(301);
      // deregister()'s own "try every server" loop, not withFailover()'s
      // "stop at first success" — the redirect on A does not stop B from
      // being attempted too.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
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

  describe('deregister() attempts every configured server', () => {
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

    it('attempts every server even though the first already returned 404 (the original bug: withFailover-style "stop at first" would end here)', async () => {
      const client = twoServerClient();
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('a:8761')
            ? mockResponse({ ok: false, status: 404 })
            : mockResponse({ ok: true, status: 200 }),
        ),
      );

      await expect(client.deregister()).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('the core regression: the registration is on A, B (unrelated) became preferred via an earlier discovery/renew failover — deregister() must still reach A, not just the preferred B', async () => {
      const client = twoServerClient();

      // First, an unrelated renew() call fails over from A to B (A times
      // out, B answers 200), making B `preferredIndex` — exactly the "a
      // concurrent getInstances()/renew() call moved the preference" setup
      // from the issue. This does NOT mean B holds the registration; it
      // never has.
      fetchMock
        .mockImplementationOnce(() => Promise.reject(new Error('a down')))
        .mockImplementationOnce(() =>
          Promise.resolve(mockResponse({ ok: true, status: 200 })),
        );
      await expect(client.renew()).resolves.toBe('renewed');

      // Now shut down. The registration actually lives on A (200); B, the
      // now-preferred server, correctly answers 404 (it never had it). The
      // old `withFailover`-routed deregister() would start at preferred B,
      // see 404, and stop — leaving A registered forever.
      fetchMock.mockClear();
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('a:8761')
            ? mockResponse({ ok: true, status: 200 })
            : mockResponse({ ok: false, status: 404 }),
        ),
      );

      await expect(client.deregister()).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2); // both A and B were contacted
    });

    it('the duplicate-registration scenario: both servers may genuinely hold the instance, so both get a DELETE even when the first already succeeded', async () => {
      const client = twoServerClient();
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200 }));

      await expect(client.deregister()).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2); // not stopped after A's success
    });

    it('rejects if any server has a genuine failure, even when every other server succeeded — a success elsewhere does not erase it', async () => {
      const client = twoServerClient();
      fetchMock
        .mockImplementationOnce(() => Promise.reject(new Error('a down')))
        .mockImplementationOnce(() =>
          Promise.resolve(mockResponse({ ok: true, status: 200 })),
        );

      const error = await client.deregister().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EurekaRequestError);
      expect(fetchMock).toHaveBeenCalledTimes(2); // B was still attempted despite A's failure
    });

    it('rejects with the last failure when every server fails, having attempted each exactly once', async () => {
      const client = twoServerClient();
      fetchMock
        .mockImplementationOnce(() => Promise.reject(new Error('a down')))
        .mockImplementationOnce(() => Promise.reject(new Error('b down')));

      const error = await client.deregister().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EurekaRequestError);
      expect(((error as EurekaRequestError).cause as Error).message).toBe(
        'b down',
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('never composes a caller signal and never touches preferredIndex (a subsequent renew() still starts at the default server)', async () => {
      const client = twoServerClient();
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200 }));

      await client.deregister();

      fetchMock.mockClear();
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200 }));
      await client.renew();
      // deregister() must not have moved preferredIndex to B — the next
      // renew() still goes to A first.
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('a:8761');
    });

    it('drains the response body for every server contacted, not just the last', async () => {
      const cancelA = jest.fn().mockResolvedValue(undefined);
      const cancelB = jest.fn().mockResolvedValue(undefined);
      const client = twoServerClient();
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('a:8761')
            ? mockResponse({
                ok: false,
                status: 404,
                body: { cancel: cancelA },
              })
            : mockResponse({
                ok: true,
                status: 200,
                body: { cancel: cancelB },
              }),
        ),
      );

      await client.deregister();

      expect(cancelA).toHaveBeenCalledTimes(1);
      expect(cancelB).toHaveBeenCalledTimes(1);
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
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200 }));

      await client.deregister();

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
