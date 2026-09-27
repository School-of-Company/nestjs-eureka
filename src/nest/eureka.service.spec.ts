import { Test, TestingModule } from '@nestjs/testing';
import { EurekaModule } from './eureka.module';
import type { EurekaModuleOptions } from './eureka.interfaces';
import { EurekaService } from './eureka.service';

function validOptions(): EurekaModuleOptions {
  return {
    serviceUrl: 'http://localhost:8761/eureka',
    instance: {
      app: 'my-app',
      hostName: 'host-1',
      ipAddr: '10.0.0.1',
      port: 3000,
    },
    heartbeatIntervalSeconds: 30,
  };
}

function mockResponse(
  ok: boolean,
  status: number,
  json?: () => Promise<unknown>,
): Response {
  return {
    ok,
    status,
    statusText: '',
    json: json ?? (() => Promise.resolve({})),
  } as unknown as Response;
}

describe('EurekaService (Nest lifecycle wiring)', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers with Eureka when the Nest context bootstraps', async () => {
    fetchMock.mockResolvedValue(mockResponse(true, 204));
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [EurekaModule.forRoot(validOptions())],
    }).compile();

    await moduleRef.init();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');

    await moduleRef.close();
  });

  it('deregisters from Eureka when the Nest context shuts down', async () => {
    fetchMock.mockResolvedValue(mockResponse(true, 204));
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [EurekaModule.forRoot(validOptions())],
    }).compile();
    await moduleRef.init();

    await moduleRef.close();

    const deleteCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit).method === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(1);
  });

  it('rejects init() when the initial registration fails (fail-fast)', async () => {
    fetchMock.mockResolvedValue(mockResponse(false, 500));
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [EurekaModule.forRoot(validOptions())],
    }).compile();

    await expect(moduleRef.init()).rejects.toBeDefined();
  });

  it('boots anyway in background registration mode when the initial registration fails', async () => {
    fetchMock.mockResolvedValue(mockResponse(false, 500));
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        EurekaModule.forRoot({
          ...validOptions(),
          registrationMode: 'background',
        }),
      ],
    }).compile();

    await expect(moduleRef.init()).resolves.toBeDefined();

    await moduleRef.close();
    const deleteCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit).method === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('getInstances() delegates to the underlying client', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(true, 204)); // register on init
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [EurekaModule.forRoot(validOptions())],
    }).compile();
    await moduleRef.init();

    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, () =>
        Promise.resolve({
          application: {
            instance: {
              instanceId: 'i',
              app: 'OTHER',
              hostName: 'h',
              ipAddr: '1.2.3.4',
              status: 'UP',
            },
          },
        }),
      ),
    );

    const service = moduleRef.get(EurekaService);
    const instances = await service.getInstances('other');

    expect(instances).toHaveLength(1);
    expect(instances[0].instanceId).toBe('i');

    await moduleRef.close();
  });
});
