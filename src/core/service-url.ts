/**
 * Parses and normalizes a Eureka `serviceUrl` into a base URL safe to build
 * requests from, plus an optional Authorization header derived from any
 * embedded basic-auth credentials.
 *
 * Node's `fetch` rejects URLs with embedded credentials, and logging or
 * throwing the raw input would leak a password, so credentials are always
 * extracted here and never allowed to reach fetch/logs/errors as part of a URL.
 */

export interface ParsedServiceUrl {
  /** No trailing slash, no credentials. Any path prefix (e.g. `/eureka`) is preserved. */
  baseUrl: string;
  /** `Basic <base64>` header value, present only if the input URL had credentials. */
  authorizationHeader?: string;
}

const INVALID_URL_MESSAGE = 'Invalid Eureka service URL';

export function parseServiceUrl(serviceUrl: string): ParsedServiceUrl {
  let url: URL;
  try {
    url = new URL(serviceUrl);
  } catch {
    // Never interpolate the raw input — it may contain a password.
    throw new Error(INVALID_URL_MESSAGE);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${INVALID_URL_MESSAGE}: must use http or https`);
  }
  if (url.search || url.hash) {
    throw new Error(
      `${INVALID_URL_MESSAGE}: query strings and fragments are not supported`,
    );
  }
  if (url.pathname.includes('@')) {
    // A comma-joined multi-URL input (e.g. Spring's `defaultZone` convention,
    // `http://u1:p1@host-a/eureka/,http://u2:secret@host-b/eureka/`) is not
    // supported (see README's "Not implemented yet"), but critically must be
    // *rejected*, not silently mis-parsed: `new URL()` only recognizes the
    // first `user:pass@host` as credentials and treats the rest as a literal
    // path, which would otherwise leak the second URL's credentials into
    // every request path, `EurekaRequestError.url`, and log lines.
    throw new Error(
      `${INVALID_URL_MESSAGE}: only a single Eureka server URL is supported`,
    );
  }

  let authorizationHeader: string | undefined;
  if (url.username || url.password) {
    const user = decodeURIComponent(url.username);
    const pass = decodeURIComponent(url.password);
    authorizationHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    url.username = '';
    url.password = '';
  }

  const baseUrl = url.toString().replace(/\/+$/, '');
  return { baseUrl, authorizationHeader };
}
