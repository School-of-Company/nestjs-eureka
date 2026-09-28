import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

/**
 * A minimal, in-memory Eureka server for the e2e test — real `node:http`,
 * not another `fetch` mock, so the test actually exercises real
 * `fetch`/undici request/response handling.
 */
export class EurekaStubServer {
  private readonly server: Server;
  private readonly registry = new Map<string, Record<string, unknown>>();
  readonly requests: RecordedRequest[] = [];
  /** When true, registration (POST) requests get a 503 and nothing is stored. */
  failRegistrations = false;
  /** When true, renewal (PUT) requests never get a response — the request
   *  hangs until the client cancels it (or the connection is force-closed). */
  hangRenewals = false;
  /** Incremented synchronously whenever a hanging renewal request arrives,
   *  so a test can deterministically wait for one to actually be in flight. */
  hangingRenewalCount = 0;
  /** When true, discovery (GET /apps/{app}) requests get a 503 — used to
   *  force a discovery-only failover to another configured server, without
   *  touching this server's actual registry (registration/renewal/
   *  deregistration are unaffected). */
  failDiscovery = false;
  private port = 0;
  private closed = false;

  constructor() {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    const address = this.server.address();
    if (address && typeof address === 'object') this.port = address.port;
  }

  /** Idempotent — safe to call more than once (e.g. from a test's `finally`
   *  after an already-explicit close earlier in the same test). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // A hung/aborted renewal leaves its server-side socket open (the client
    // cancelling its own request doesn't close the underlying TCP
    // connection) — without this, server.close() would hang waiting for it.
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/eureka`;
  }

  /** Simulates Eureka forgetting an instance (e.g. after a server restart). */
  forget(instanceId: string): void {
    this.registry.delete(instanceId);
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      body = rawBody;
    }

    const method = req.method ?? '';
    const path = req.url ?? '';
    this.requests.push({ method, path, body });

    const match = /^\/eureka\/apps\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const app = decodeURIComponent(match[1]);
    const instanceId = match[2] ? decodeURIComponent(match[2]) : undefined;

    if (method === 'POST' && !instanceId) {
      if (this.failRegistrations) {
        res.writeHead(503).end();
        return;
      }
      const instance = (body as { instance?: Record<string, unknown> })
        ?.instance;
      if (instance && typeof instance.instanceId === 'string') {
        this.registry.set(instance.instanceId, instance);
      }
      res.writeHead(204).end();
      return;
    }
    if (method === 'PUT' && instanceId) {
      if (this.hangRenewals) {
        this.hangingRenewalCount++;
        return; // deliberately never respond; the client is expected to cancel
      }
      res.writeHead(this.registry.has(instanceId) ? 200 : 404).end();
      return;
    }
    if (method === 'DELETE' && instanceId) {
      this.registry.delete(instanceId);
      res.writeHead(200).end();
      return;
    }
    if (method === 'GET' && !instanceId) {
      if (this.failDiscovery) {
        res.writeHead(503).end();
        return;
      }
      const instances = [...this.registry.values()].filter(
        (i) => i.app === app,
      );
      if (instances.length === 0) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ application: { name: app, instance: instances } }),
      );
      return;
    }
    res.writeHead(404).end();
  }
}
