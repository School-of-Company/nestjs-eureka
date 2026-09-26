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
      'Invalid Eureka service URL: only a single Eureka server URL is supported',
    );
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
