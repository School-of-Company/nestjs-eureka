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

  it('aborts the request once the fixed request timeout elapses', async () => {
    const controller = new AbortController();
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
    );
    const client = new EurekaClient(resolved);

    const pending = client.renew();
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(EurekaRequestError);
  });
});
