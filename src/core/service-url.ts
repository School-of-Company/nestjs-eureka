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

// Matches a comma, semicolon, or whitespace (a space, or a newline — as in a
// multiline YAML/env value) directly followed by another http(s) URL —
// deliberately narrower than "any comma/semicolon/whitespace anywhere" so a
// legitimate single URL whose *password* happens to contain one of those
// characters isn't falsely rejected (WHATWG URL parsing never treats
// userinfo commas/semicolons specially — `pa,ss` in
// `http://user:pa,ss@host/eureka` parses fine, with none of it reaching
// `pathname`). Catches credential-free multi-URL joins regardless of which
// separator convention was used (Spring's `defaultZone` uses a comma, but a
// newline or space is just as easy to end up with by accident).
const JOINED_MULTI_URL = /[,;\s]\s*https?:\/\//i;

export function parseServiceUrl(serviceUrl: string): ParsedServiceUrl {
  // Checked on the raw input, before `new URL()` ever runs, so a credentialed
  // second URL's password can't leak into anything derived from a `URL`
  // object. Multiple servers ARE supported (see `options.ts`'s
  // `serviceUrl: string[]`) — just not via a joined single-string convention.
  if (JOINED_MULTI_URL.test(serviceUrl)) {
    throw new Error(
      `${INVALID_URL_MESSAGE}: joining multiple server URLs into one string is not supported — pass an array of URLs instead`,
    );
  }

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
    // A second, credentialed URL joined by *any* separator — not just a
    // comma; a newline (e.g. from a multiline YAML/env value), a space, a
    // semicolon, etc. — ends up with `user:pass@host` landing in the parsed
    // pathname as a literal string, since `new URL()` only recognizes the
    // FIRST `@` as the userinfo delimiter. The comma-specific check above
    // doesn't (and shouldn't) catch these; this one does, regardless of
    // separator. Don't remove this thinking the check above makes it
    // redundant — it isn't.
    throw new Error(
      `${INVALID_URL_MESSAGE}: joining multiple server URLs into one string is not supported — pass an array of URLs instead`,
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
