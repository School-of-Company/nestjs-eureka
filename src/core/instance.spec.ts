import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRegistrationBody, parseApplicationResponse } from './instance';
import { resolveOptions } from './options';

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', name), 'utf8'),
  );
}

describe('buildRegistrationBody', () => {
  it('matches the expected Eureka registration shape, uppercasing and URL-safety being separate concerns', () => {
    const resolved = resolveOptions({
      serviceUrl: 'http://localhost:8761/eureka',
      instance: {
        app: 'my-app',
        hostName: 'host-1',
        ipAddr: '10.0.0.1',
        port: 3000,
        metadata: { region: 'local' },
      },
    });

    const body = buildRegistrationBody(resolved);

    expect(body).toEqual({
      instance: {
        instanceId: 'host-1:my-app:3000',
        hostName: 'host-1',
        app: 'MY-APP', // uppercased for the wire protocol
        ipAddr: '10.0.0.1',
        status: 'UP',
        port: { $: 3000, '@enabled': true },
        securePort: { $: 0, '@enabled': false },
        vipAddress: 'my-app',
        secureVipAddress: 'my-app',
        dataCenterInfo: {
          '@class': 'com.netflix.appinfo.InstanceInfo$DefaultDataCenterInfo',
          name: 'MyOwn',
        },
        leaseInfo: { renewalIntervalInSecs: 30, durationInSecs: 90 },
        metadata: { region: 'local' },
        lastDirtyTimestamp: expect.any(Number) as number,
        homePageUrl: undefined,
        statusPageUrl: undefined,
        healthCheckUrl: undefined,
      },
    });
  });

  it('enables securePort when provided', () => {
    const resolved = resolveOptions({
      serviceUrl: 'http://localhost:8761/eureka',
      instance: {
        app: 'my-app',
        hostName: 'host-1',
        ipAddr: '10.0.0.1',
        port: 3000,
        securePort: 8443,
      },
    });
    const body = buildRegistrationBody(resolved);
    expect(body.instance.securePort).toEqual({ $: 8443, '@enabled': true });
  });
});

describe('parseApplicationResponse', () => {
  it('normalizes a single (non-array) instance object, strips @class from empty metadata, and disables an unenabled port', () => {
    const instances = parseApplicationResponse(
      loadFixture('single-instance.json'),
    );
    expect(instances).toEqual([
      {
        instanceId: 'host-1:my-app:3000',
        app: 'MY-APP',
        hostName: 'host-1',
        ipAddr: '10.0.0.1',
        status: 'UP',
        port: 3000,
        securePort: undefined,
        vipAddress: 'my-app',
        secureVipAddress: 'my-app',
        metadata: {},
        homePageUrl: 'http://host-1:3000/',
        statusPageUrl: 'http://host-1:3000/info',
        healthCheckUrl: 'http://host-1:3000/health',
      },
    ]);
    // Consistency: metadata has no prototype whether or not the source
    // response actually included a "metadata" key (this fixture's metadata
    // is present-but-empty after @class stripping) — a caller shouldn't see
    // `.hasOwnProperty` work in one case and throw in another.
    expect(Object.getPrototypeOf(instances[0].metadata)).toBeNull();
  });

  it('produces a null-prototype metadata object even when the source instance has no "metadata" key at all', () => {
    const [instance] = parseApplicationResponse({
      application: {
        instance: {
          instanceId: 'i',
          app: 'A',
          hostName: 'h',
          ipAddr: '1.2.3.4',
          status: 'UP',
        },
      },
    });
    expect(Object.getPrototypeOf(instance.metadata)).toBeNull();
    expect(instance.metadata).toEqual({});
  });

  it('parses an array of instances, accepting boolean @enabled', () => {
    const instances = parseApplicationResponse(
      loadFixture('multi-instance.json'),
    );
    expect(instances).toHaveLength(2);
    expect(instances[0]).toMatchObject({
      instanceId: 'host-1:my-app:3000',
      status: 'UP',
      port: 3000,
      securePort: undefined,
    });
    expect(instances[1]).toMatchObject({
      instanceId: 'host-2:my-app:3000',
      status: 'DOWN',
    });
  });

  it('throws on a non-object response body', () => {
    expect(() => parseApplicationResponse('not an object')).toThrow(
      /not an object/,
    );
  });

  it('throws when "application" is missing', () => {
    expect(() => parseApplicationResponse({})).toThrow(
      /"application" is missing/,
    );
  });

  it('throws when a required instance field is missing', () => {
    expect(() =>
      parseApplicationResponse({
        application: {
          instance: {
            hostName: 'h',
            app: 'A',
            ipAddr: '1.2.3.4',
            status: 'UP',
          },
        },
      }),
    ).toThrow(/instanceId/);
  });

  it('throws on an unrecognized status value', () => {
    expect(() =>
      parseApplicationResponse({
        application: {
          instance: {
            instanceId: 'i',
            app: 'A',
            hostName: 'h',
            ipAddr: '1.2.3.4',
            status: 'TOTALLY_MADE_UP',
          },
        },
      }),
    ).toThrow(/status/);
  });

  it('throws on a non-string metadata value', () => {
    expect(() =>
      parseApplicationResponse({
        application: {
          instance: {
            instanceId: 'i',
            app: 'A',
            hostName: 'h',
            ipAddr: '1.2.3.4',
            status: 'UP',
            metadata: { count: 5 },
          },
        },
      }),
    ).toThrow(/metadata value/);
  });
});
