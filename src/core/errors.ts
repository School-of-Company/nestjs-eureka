/** Public. */
export interface EurekaRequestErrorInit {
  operation: 'register' | 'renew' | 'deregister' | 'discovery';
  /** Sanitized — never contains credentials. */
  method: string;
  /** Sanitized — never contains credentials. */
  url: string;
  status?: number;
  statusText?: string;
  cause?: unknown;
}

/**
 * Public. Structured so callers can branch on `status`/`operation` instead of
 * parsing an opaque string. `message` is always library-authored and
 * sanitized — never derived from `cause`, since a raw fetch/network error's
 * own message could itself echo request details. `cause` is kept only for
 * debugging.
 */
export class EurekaRequestError extends Error {
  readonly operation: EurekaRequestErrorInit['operation'];
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly statusText?: string;

  constructor(message: string, init: EurekaRequestErrorInit) {
    super(
      message,
      init.cause !== undefined ? { cause: init.cause } : undefined,
    );
    this.name = 'EurekaRequestError';
    this.operation = init.operation;
    this.method = init.method;
    this.url = init.url;
    this.status = init.status;
    this.statusText = init.statusText;
  }
}
