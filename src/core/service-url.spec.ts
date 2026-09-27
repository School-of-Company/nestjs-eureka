import { parseServiceUrl } from './service-url';

describe('parseServiceUrl', () => {
  it('strips a trailing slash', () => {
    expect(parseServiceUrl('http://localhost:8761/eureka').baseUrl).toBe(
      'http://localhost:8761/eureka',
    );
    expect(parseServiceUrl('http://localhost:8761/eureka/').baseUrl).toBe(
      'http://localhost:8761/eureka',
    );
  });

  it('preserves an existing path prefix', () => {
    expect(parseServiceUrl('http://localhost:8761/eureka/v2').baseUrl).toBe(
      'http://localhost:8761/eureka/v2',
    );
  });

  it('has no path when the input has none', () => {
    expect(parseServiceUrl('http://localhost:8761').baseUrl).toBe(
      'http://localhost:8761',
    );
  });

  it('extracts credentials into an Authorization header and strips them from baseUrl', () => {
    const { baseUrl, authorizationHeader } = parseServiceUrl(
      'http://user:pass@localhost:8761/eureka',
    );
    expect(baseUrl).toBe('http://localhost:8761/eureka');
    expect(authorizationHeader).toBe(
      `Basic ${Buffer.from('user:pass').toString('base64')}`,
    );
  });

  it('decodes percent-encoded credentials', () => {
    const { authorizationHeader } = parseServiceUrl(
      'http://us%40er:p%40ss@localhost:8761/eureka',
    );
    expect(authorizationHeader).toBe(
      `Basic ${Buffer.from('us@er:p@ss').toString('base64')}`,
    );
  });

  it('has no Authorization header when there are no credentials', () => {
    expect(
      parseServiceUrl('http://localhost:8761/eureka').authorizationHeader,
    ).toBeUndefined();
  });

  it('rejects a query string', () => {
    expect(() =>
      parseServiceUrl('http://localhost:8761/eureka?foo=bar'),
    ).toThrow(/query strings/);
  });

  it('rejects a fragment', () => {
    expect(() => parseServiceUrl('http://localhost:8761/eureka#frag')).toThrow(
      /query strings/,
    );
  });

  it("rejects a comma-joined multi-URL input instead of leaking the second URL's credentials into the path (regression)", () => {
    const input =
      'http://u1:p1@host-a:8761/eureka/,http://u2:secret2@host-b:8761/eureka/';

    let error: Error | undefined;
    try {
      parseServiceUrl(input);
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).not.toContain('secret2');
    expect(error!.message).toBe(
      'Invalid Eureka service URL: joining multiple server URLs into one string is not supported — pass an array of URLs instead',
    );
  });

  it('rejects a comma-joined multi-URL input even without embedded credentials (regression)', () => {
    // The common case in practice (e.g. Spring's `defaultZone` convention
    // usually has no basic-auth) — this has no "@" anywhere, so a check that
    // only looked at `pathname.includes('@')` would silently accept it as
    // one garbled URL instead of rejecting it.
    expect(() =>
      parseServiceUrl('http://host-a:8761/eureka/,http://host-b:8761/eureka/'),
    ).toThrow(
      'Invalid Eureka service URL: joining multiple server URLs into one string is not supported — pass an array of URLs instead',
    );
  });

  it('rejects a comma-joined multi-URL input with surrounding whitespace after the comma', () => {
    expect(() =>
      parseServiceUrl('http://host-a:8761/eureka, http://host-b:8761/eureka'),
    ).toThrow(/joining multiple server URLs into one string is not supported/);
  });

  it('rejects a credential-free multi-URL input joined by a non-comma separator (newline/space/semicolon) (regression)', () => {
    // Same root cause as the comma case above: without credentials there's
    // no "@" for the post-parse pathname check to catch, so the raw-input
    // check must itself cover every separator someone might accidentally
    // join URLs with, not just a comma.
    const inputs = [
      'http://host-a:8761/eureka/\nhttp://host-b:8761/eureka/',
      'http://host-a:8761/eureka/ http://host-b:8761/eureka/',
      'http://host-a:8761/eureka/;http://host-b:8761/eureka/',
    ];
    for (const input of inputs) {
      expect(() => parseServiceUrl(input)).toThrow(
        'Invalid Eureka service URL: joining multiple server URLs into one string is not supported — pass an array of URLs instead',
      );
    }
  });

  it('rejects a comma-joined multi-URL input regardless of scheme case or http vs https', () => {
    expect(() =>
      parseServiceUrl('http://host-a:8761/eureka,HTTP://host-b:8761/eureka'),
    ).toThrow(/joining multiple server URLs into one string is not supported/);
    expect(() =>
      parseServiceUrl('http://host-a:8761/eureka,https://host-b:8761/eureka'),
    ).toThrow(/joining multiple server URLs into one string is not supported/);
  });

  it('does not falsely reject a single URL whose password happens to contain a literal comma (regression)', () => {
    const { baseUrl, authorizationHeader } = parseServiceUrl(
      'http://user:pa,ss@localhost:8761/eureka',
    );
    expect(baseUrl).toBe('http://localhost:8761/eureka');
    expect(authorizationHeader).toBe(
      `Basic ${Buffer.from('user:pa,ss').toString('base64')}`,
    );
  });

  it("rejects a credentialed multi-URL input joined by a non-comma separator (newline/space/semicolon) instead of leaking the second URL's credentials (regression)", () => {
    const inputs = [
      'http://u1:p1@host-a:8761/eureka/\nhttp://u2:secret2@host-b:8761/eureka/',
      'http://u1:p1@host-a:8761/eureka/ http://u2:secret2@host-b:8761/eureka/',
      'http://u1:p1@host-a:8761/eureka/;http://u2:secret2@host-b:8761/eureka/',
    ];
    for (const input of inputs) {
      let error: Error | undefined;
      try {
        parseServiceUrl(input);
      } catch (err) {
        error = err as Error;
      }
      expect(error).toBeDefined();
      expect(error!.message).not.toContain('secret2');
      expect(error!.message).toBe(
        'Invalid Eureka service URL: joining multiple server URLs into one string is not supported — pass an array of URLs instead',
      );
    }
  });

  it('rejects a non-http(s) scheme', () => {
    expect(() => parseServiceUrl('ftp://localhost:8761/eureka')).toThrow(
      /http or https/,
    );
  });

  it('rejects a malformed URL with a generic, credential-free message', () => {
    let error: Error | undefined;
    try {
      parseServiceUrl('http://user:supersecret@');
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toBe('Invalid Eureka service URL');
    expect(error!.message).not.toContain('supersecret');
    expect(JSON.stringify(error)).not.toContain('supersecret');
  });

  it('never includes the raw input in the error for a plainly unparseable string', () => {
    let error: Error | undefined;
    try {
      parseServiceUrl('user:hunter2@not a url');
    } catch (err) {
      error = err as Error;
    }
    expect(error!.message).not.toContain('hunter2');
  });
});
