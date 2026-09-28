import { EurekaRequestError } from './errors';
import {
  buildRegistrationBody,
  parseApplicationResponse,
  type EurekaInstance,
} from './instance';
import type { ResolvedEurekaOptions } from './options';
import type { ParsedServiceUrl } from './service-url';

export type RenewResult = 'renewed' | 'not-found';

/**
 * `response.json()` rejects with this shape when the request's signal
 * (here, always the internal `requestTimeoutMs` timer for discovery — see
 * `getInstances()`) aborts while the body is still being read, *after*
 * `fetch()` itself already resolved with headers/status. Empirically
 * verified across Node 20.3.0, 22, and 26 (#18): a genuinely malformed body
 * always rejects with a `SyntaxError`, never one of these two names — Node
 * 20.3.0 names this `AbortError` for an `AbortSignal.timeout()` firing
 * mid-body-read, while 22+ names it `TimeoutError`; a caller-initiated
 * abort (not currently used by `getInstances()`, but checked here too in
 * case that ever changes) is `AbortError` on every version tested.
 *
 * Duck-typed on `.name` rather than `error instanceof DOMException`/`Error`
 * — deliberately, not just defensively: `DOMException` is not reliably
 * `instanceof` the calling realm's `Error` across every JS host (confirmed
 * directly — Jest's sandboxed `node` test environment is one such case,
 * despite plain Node itself passing that check).
 */
function isBodyReadTimeoutOrAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * HTTP calls against the Eureka REST API, with failover across
 * `resolved.serviceUrls` when there's more than one. No lifecycle state, no
 * scheduling — that's `EurekaRegistration`'s job. The only state this class
 * holds is `preferredIndex`, a best-effort ordering hint (see `withFailover`).
 */
export class EurekaClient {
  /** Index into `resolved.serviceUrls` tried first on the next call. Not
   *  synchronization state — see `withFailover`'s concurrency note. */
  private preferredIndex = 0;

  constructor(private readonly resolved: ResolvedEurekaOptions) {}

  /**
   * `signal` lets the caller cancel the request early, on top of
   * `requestTimeoutMs`.
   *
   * `onAmbiguousAttempt` is called once per attempt whose remote outcome is
   * unknown — no HTTP status (transport failure, timeout, or `signal`
   * abort) or a 5xx — because that server may have applied the POST even
   * though no success reached us. It's per attempt, not per operation: with
   * failover, a timeout on one server followed by a 4xx (or even a 2xx) from
   * another still reports the first. A 4xx/3xx is a definitive rejection and
   * is never reported. Thrown errors are never wrapped or replaced.
   */
  async register(
    signal?: AbortSignal,
    onAmbiguousAttempt?: () => void,
  ): Promise<void> {
    await this.withFailover(signal, async (server) => {
      try {
        const url = this.appUrl(server, this.resolved.instance.eurekaAppName);
        const response = await this.rawFetch(
          'register',
          'POST',
          url,
          {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildRegistrationBody(this.resolved)),
          },
          signal,
          server.authorizationHeader,
        );
        await this.drain(response);
        if (!response.ok) {
          throw this.statusError('register', 'POST', url, response);
        }
      } catch (error) {
        if (
          error instanceof EurekaRequestError &&
          (error.status === undefined || error.status >= 500)
        ) {
          onAmbiguousAttempt?.();
        }
        throw error;
      }
    });
  }

  /** `signal` lets the caller cancel the request early, on top of `requestTimeoutMs`. */
  async renew(signal?: AbortSignal): Promise<RenewResult> {
    return this.withFailover(signal, async (server) => {
      const url = this.instanceUrl(server);
      const response = await this.rawFetch(
        'renew',
        'PUT',
        url,
        undefined,
        signal,
        server.authorizationHeader,
      );
      await this.drain(response);
      if (response.status === 200) return 'renewed';
      if (response.status === 404) return 'not-found';
      throw this.statusError('renew', 'PUT', url, response);
    });
  }

  /**
   * Attempts a deregistration against *every* configured server, unlike
   * register()/renew()/getInstances() (which stop at the first server that
   * completes the operation). A 200/404 on one server says nothing about
   * whether another, independent server still holds this registration —
   * `preferredIndex` is only a best-effort hint for where to look first for
   * those other three operations, not a record of which server(s) this
   * instance is actually registered on. So this method deliberately does not
   * use `withFailover()` (and does not read or update `preferredIndex`) —
   * every server gets exactly one sequential `DELETE`, always.
   *
   * Contract: 2xx and 404 are both a successful cleanup outcome for that
   * server. Any transport failure or other non-2xx/non-404 response makes
   * the overall call reject — even if every other configured server
   * succeeded — because that server's cleanup outcome is unknown, and a
   * success elsewhere doesn't erase that. If more than one server fails,
   * the last failure encountered is what's thrown; this method never
   * aggregates multiple errors into a new error type.
   *
   * This attempts deregistration against every server — it can't guarantee
   * the instance is actually gone everywhere (a server may simply be
   * unreachable for the whole attempt).
   *
   * Sequential, not parallel: with N configured servers, worst-case latency
   * is N * `requestTimeoutMs`. Deliberate — parallelizing this is a separate
   * concurrency/error-aggregation decision, out of scope here.
   */
  async deregister(): Promise<void> {
    let cleanupFailure: EurekaRequestError | undefined;
    for (const server of this.resolved.serviceUrls) {
      const url = this.instanceUrl(server);
      try {
        const response = await this.rawFetch(
          'deregister',
          'DELETE',
          url,
          undefined,
          undefined,
          server.authorizationHeader,
        );
        await this.drain(response);
        if (!response.ok && response.status !== 404) {
          cleanupFailure = this.statusError(
            'deregister',
            'DELETE',
            url,
            response,
          );
        }
      } catch (error) {
        // An unexpected/programming error, not an operational deregister
        // failure — propagate immediately rather than lumping it in with a
        // normal per-server cleanup failure (same principle as `withFailover`).
        if (!(error instanceof EurekaRequestError)) throw error;
        cleanupFailure = error;
      }
    }
    if (cleanupFailure) throw cleanupFailure;
  }

  async getInstances(appName: string): Promise<EurekaInstance[]> {
    return this.withFailover(undefined, async (server) => {
      const url = this.appUrl(server, appName.toUpperCase());
      const response = await this.rawFetch(
        'discovery',
        'GET',
        url,
        undefined,
        undefined,
        server.authorizationHeader,
      );
      if (response.status === 404) {
        await this.drain(response);
        return [];
      }
      if (!response.ok) {
        await this.drain(response);
        throw this.statusError('discovery', 'GET', url, response);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        if (isBodyReadTimeoutOrAbort(cause)) {
          // Headers (and `response.status`/`.ok`, already checked above)
          // arrived, but the body itself didn't within requestTimeoutMs (or
          // the request's signal was otherwise aborted while reading it) —
          // a transport-level failure, not a malformed payload from a
          // reachable node. Status-less, like a `rawFetch` transport
          // failure, so `withFailover` retries the next server instead of
          // treating this the same as genuinely malformed JSON.
          throw new EurekaRequestError(
            'Eureka discovery request timed out while reading the response body',
            { operation: 'discovery', method: 'GET', url, cause },
          );
        }
        throw new EurekaRequestError(
          'Eureka discovery response was not valid JSON',
          {
            operation: 'discovery',
            method: 'GET',
            url,
            status: response.status,
            statusText: response.statusText,
            cause,
          },
        );
      }

      try {
        return parseApplicationResponse(body);
      } catch (cause) {
        throw new EurekaRequestError((cause as Error).message, {
          operation: 'discovery',
          method: 'GET',
          url,
          status: response.status,
          statusText: response.statusText,
          cause,
        });
      }
    });
  }

  /**
   * Tries `attempt` against each configured server, starting from
   * `preferredIndex` and rotating through the rest. Used by register()/
   * renew()/getInstances() only — deregister() has a different contract
   * (attempt every server, never stop early) and doesn't use this. A server
   * becomes preferred whenever `attempt` *returns* — a definitive protocol
   * answer that ends the loop (a 2xx, or a meaningful 404 for renew/
   * discovery). A *thrown* error never updates it, including a terminal 4xx:
   * an error isn't evidence a server is good.
   *
   * Failover classification (deliberately status-based, not error-type-based):
   * - not an `EurekaRequestError` at all (an unexpected/programming error) —
   *   propagate immediately, never treat it as "try the next server".
   * - `callerSignal` is aborted — the authoritative signal that this is an
   *   intentional shutdown cancellation (never inferred from `cause.name`).
   *   Propagate immediately, zero further attempts.
   * - no `status` (transport failure/timeout) or a 5xx — this server is
   *   broken; try the next one.
   * - anything else (a 4xx, or a 2xx-status protocol/parse error such as
   *   malformed discovery JSON) — a real answer from a reachable node.
   *   Propagate immediately; don't fail over.
   *
   * Concurrency: `getInstances()` can run concurrently with the heartbeat/
   * registration lifecycle. `preferredIndex` is a plain, unsynchronized
   * best-effort hint, not a lock — two concurrent operations can each
   * overwrite it, and each operation snapshots its own starting index so a
   * concurrent update mid-loop can't change its own rotation order. No
   * proactive failback: once a server becomes preferred, it's used until it
   * fails — there's no periodic re-probe of a demoted server in v1.
   */
  private async withFailover<T>(
    callerSignal: AbortSignal | undefined,
    attempt: (server: ParsedServiceUrl) => Promise<T>,
  ): Promise<T> {
    const servers = this.resolved.serviceUrls;
    const n = servers.length;
    const startIndex = this.preferredIndex;
    let lastError: unknown;
    for (let i = 0; i < n; i++) {
      const index = (startIndex + i) % n;
      try {
        const result = await attempt(servers[index]);
        this.preferredIndex = index;
        return result;
      } catch (error) {
        lastError = error;
        if (!(error instanceof EurekaRequestError)) throw error;
        if (callerSignal?.aborted) throw error;
        if (error.status === undefined || error.status >= 500) continue;
        throw error;
      }
    }
    throw lastError;
  }

  private appUrl(server: ParsedServiceUrl, eurekaAppName: string): string {
    return `${server.baseUrl}/apps/${encodeURIComponent(eurekaAppName)}`;
  }

  private instanceUrl(server: ParsedServiceUrl): string {
    return `${this.appUrl(server, this.resolved.instance.eurekaAppName)}/${encodeURIComponent(this.resolved.instance.instanceId)}`;
  }

  private async rawFetch(
    operation: EurekaRequestError['operation'],
    method: string,
    url: string,
    init: { headers?: Record<string, string>; body?: string } | undefined,
    callerSignal: AbortSignal | undefined,
    authorizationHeader: string | undefined,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...init?.headers,
    };
    if (authorizationHeader) headers.Authorization = authorizationHeader;

    let response: Response;
    try {
      const timeoutSignal = AbortSignal.timeout(this.resolved.requestTimeoutMs);
      response = await fetch(url, {
        method,
        headers,
        body: init?.body,
        // Never follow a redirect. The Fetch spec silently replays a POST as
        // a GET on a 301/302, dropping the body — a Eureka server or proxy
        // that redirects register()/renew() would then have `response.ok`
        // reflect whatever the redirect target happens to return, making a
        // registration that never actually landed look like a success.
        // `'manual'` (not `'error'`) so this surfaces through the normal
        // response-based path below, not the transport-failure catch.
        redirect: 'manual',
        signal: callerSignal
          ? AbortSignal.any([timeoutSignal, callerSignal])
          : timeoutSignal,
      });
    } catch (cause) {
      throw new EurekaRequestError(`Eureka ${operation} request failed`, {
        operation,
        method,
        url,
        cause,
      });
    }
    if (response.status >= 300 && response.status < 400) {
      // With `redirect: 'manual'`, Node's fetch (undici) returns the real
      // 3xx response as-is — unlike a browser, it does not hide it behind
      // an opaque response. Never interpolate the `Location` header's value
      // into the message: it comes from whatever answered the request, not
      // from Eureka's own configuration, so it's untrusted the same way raw
      // input elsewhere in this file is. Given a `status`, this is
      // classified the same as a 4xx by `withFailover` — a real, definitive
      // answer from this server (or whatever's in front of it), not
      // evidence every configured server is broken the same way.
      await this.drain(response);
      throw new EurekaRequestError(
        `Eureka ${operation} request was redirected (status ${response.status}) — redirects are not followed; point serviceUrl at the final URL directly`,
        {
          operation,
          method,
          url,
          status: response.status,
          statusText: response.statusText,
        },
      );
    }
    return response;
  }

  /**
   * Register/renew/deregister never read the response body (it's typically
   * empty and never meaningful), and the discovery 404/error paths don't
   * either — but an unconsumed body can keep the underlying keep-alive
   * connection from being released back to undici's pool. Best-effort only:
   * a drain failure must never mask the real result.
   */
  private async drain(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // ignored — see above
    }
  }

  private statusError(
    operation: EurekaRequestError['operation'],
    method: string,
    url: string,
    response: Response,
  ): EurekaRequestError {
    return new EurekaRequestError(
      `Eureka ${operation} request failed with status ${response.status}`,
      {
        operation,
        method,
        url,
        status: response.status,
        statusText: response.statusText,
      },
    );
  }
}
