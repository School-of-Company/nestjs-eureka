import { resolveOptions, type EurekaClientOptions } from './options';

function baseOptions(): EurekaClientOptions {
  return {
    serviceUrl: 'http://localhost:8761/eureka',
    instance: {
      app: 'my-app',
      hostName: 'host-1',
      ipAddr: '10.0.0.1',
      port: 3000,
    },
  };
}

describe('resolveOptions', () => {
  it('applies defaults', () => {
    const resolved = resolveOptions(baseOptions());
    expect(resolved.heartbeatIntervalMs).toBe(30_000);
    expect(resolved.leaseDurationSeconds).toBe(90);
    expect(resolved.instance.instanceId).toBe('host-1:my-app:3000');
    expect(resolved.instance.eurekaAppName).toBe('MY-APP');
    expect(resolved.instance.vipAddress).toBe('my-app');
    expect(resolved.instance.secureVipAddress).toBe('my-app');
    expect(resolved.instance.metadata).toEqual({});
    expect(resolved.registrationMode).toBe('fail-fast');
  });

  it('accepts registrationMode "background"', () => {
    const options = baseOptions();
    options.registrationMode = 'background';
    expect(resolveOptions(options).registrationMode).toBe('background');
  });

  it('rejects an unknown registrationMode', () => {
    const options = baseOptions();
    options.registrationMode = 'lazy' as unknown as 'background';
    expect(() => resolveOptions(options)).toThrow(/registrationMode/);
  });

  it('does not mutate the caller-supplied options or its nested objects', () => {
    const options = baseOptions();
    options.instance.metadata = { region: 'local' };
    const snapshotOptions = JSON.parse(
      JSON.stringify(options),
    ) as EurekaClientOptions;
    const snapshotInstance = JSON.parse(
      JSON.stringify(options.instance),
    ) as EurekaClientOptions['instance'];

    resolveOptions(options);

    expect(options).toEqual(snapshotOptions);
    expect(options.instance).toEqual(snapshotInstance);
  });

  it('rejects a non-positive-integer port', () => {
    const options = baseOptions();
    options.instance.port = 0;
    expect(() => resolveOptions(options)).toThrow(/instance.port/);
  });

  it('rejects a heartbeat interval that is not smaller than the lease duration', () => {
    const options = baseOptions();
    options.heartbeatIntervalSeconds = 90;
    options.leaseDurationSeconds = 90;
    expect(() => resolveOptions(options)).toThrow(/smaller than/);
  });

  it('rejects an empty app name', () => {
    const options = baseOptions();
    options.instance.app = '';
    expect(() => resolveOptions(options)).toThrow(/instance.app/);
  });

  it('rejects non-string metadata values', () => {
    const options = baseOptions();
    options.instance.metadata = { count: 5 as unknown as string };
    expect(() => resolveOptions(options)).toThrow(/metadata value/);
  });

  it('rejects a metadata value that is not a plain object (e.g. a string, which Object.entries would otherwise silently iterate char-by-char)', () => {
    const options = baseOptions();
    options.instance.metadata = 'abc' as unknown as Record<string, string>;
    expect(() => resolveOptions(options)).toThrow(/instance.metadata/);
  });

  it('rejects an array as metadata', () => {
    const options = baseOptions();
    options.instance.metadata = [] as unknown as Record<string, string>;
    expect(() => resolveOptions(options)).toThrow(/instance.metadata/);
  });

  it('rejects an explicit empty-string instanceId rather than silently keeping it', () => {
    const options = baseOptions();
    options.instance.instanceId = '';
    expect(() => resolveOptions(options)).toThrow(/instance.instanceId/);
  });

  it('rejects a port above the valid range', () => {
    const options = baseOptions();
    options.instance.port = 70_000;
    expect(() => resolveOptions(options)).toThrow(/instance.port/);
  });

  it('copies metadata rather than mutating or aliasing the input object', () => {
    const metadata = { region: 'local' };
    const options = baseOptions();
    options.instance.metadata = metadata;
    const resolved = resolveOptions(options);
    expect(resolved.instance.metadata).toEqual({ region: 'local' });
    expect(resolved.instance.metadata).not.toBe(metadata);
  });

  it('treats a __proto__-keyed metadata input as inert data, not a prototype hook', () => {
    // JSON.parse gives an own data property literally named "__proto__" (it
    // does not go through the accessor setter the way `obj.__proto__ = x` or
    // object-literal syntax would) — this is the shape config coming from an
    // external source (env/JSON file) would actually have.
    const malicious = JSON.parse(
      '{"__proto__": "not-really-a-prototype", "safe": "value"}',
    ) as Record<string, string>;
    const options = baseOptions();
    options.instance.metadata = malicious;

    const resolved = resolveOptions(options);

    // The global Object.prototype must be untouched.
    expect(
      Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'),
    ).toBe(false);
    // The resolved metadata object itself has no prototype at all, so even
    // a literal "__proto__" key on it is just ordinary, retrievable data.
    expect(Object.getPrototypeOf(resolved.instance.metadata)).toBeNull();
    expect(resolved.instance.metadata.safe).toBe('value');
    expect(resolved.instance.metadata.__proto__).toBe('not-really-a-prototype');
  });
});
