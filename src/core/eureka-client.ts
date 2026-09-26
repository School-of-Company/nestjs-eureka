import { EurekaRequestError } from './errors';
import {
  buildRegistrationBody,
  parseApplicationResponse,
  type EurekaInstance,
} from './instance';
import type { ResolvedEurekaOptions } from './options';

const REQUEST_TIMEOUT_MS = 5_000;

export type RenewResult = 'renewed' | 'not-found';

/**
 * Stateless HTTP calls against the Eureka REST API. No lifecycle state, no
 * scheduling — that's `EurekaRegistration`'s job.
 */
export class EurekaClient {
  constructor(private readonly resolved: ResolvedEurekaOptions) {}

  async register(): Promise<void> {
    const url = this.appUrl(this.resolved.instance.eurekaAppName);
    const response = await this.rawFetch('register', 'POST', url, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRegistrationBody(this.resolved)),
    });
    await this.drain(response);
    if (!response.ok) throw this.statusError('register', 'POST', url, response);
  }

  async renew(): Promise<RenewResult> {
    const url = this.instanceUrl();
    const response = await this.rawFetch('renew', 'PUT', url);
    await this.drain(response);
    if (response.status === 200) return 'renewed';
    if (response.status === 404) return 'not-found';
    throw this.statusError('renew', 'PUT', url, response);
  }

  async deregister(): Promise<void> {
    const url = this.instanceUrl();
    const response = await this.rawFetch('deregister', 'DELETE', url);
    await this.drain(response);
    if (response.ok || response.status === 404) return;
    throw this.statusError('deregister', 'DELETE', url, response);
  }

  async getInstances(appName: string): Promise<EurekaInstance[]> {
    const url = this.appUrl(appName.toUpperCase());
    const response = await this.rawFetch('discovery', 'GET', url);
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
  }

  private appUrl(eurekaAppName: string): string {
    return `${this.resolved.baseUrl}/apps/${encodeURIComponent(eurekaAppName)}`;
  }

  private instanceUrl(): string {
    return `${this.appUrl(this.resolved.instance.eurekaAppName)}/${encodeURIComponent(this.resolved.instance.instanceId)}`;
  }

  private async rawFetch(
    operation: EurekaRequestError['operation'],
    method: string,
    url: string,
    init?: { headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...init?.headers,
    };
    if (this.resolved.authorizationHeader)
      headers.Authorization = this.resolved.authorizationHeader;

    try {
      return await fetch(url, {
        method,
        headers,
        body: init?.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new EurekaRequestError(`Eureka ${operation} request failed`, {
        operation,
        method,
        url,
        cause,
      });
    }
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
