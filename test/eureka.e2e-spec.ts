import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EurekaModule, EurekaService } from '../src/index';
import { EurekaStubServer } from './eureka-stub-server';

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('Eureka registration (e2e)', () => {
  let stub: EurekaStubServer;

  beforeEach(async () => {
    stub = new EurekaStubServer();
    await stub.listen();
  });

  afterEach(async () => {
    await stub.close();
  });

  it('registers, heartbeats, re-registers after Eureka forgets the instance, supports discovery, and deregisters exactly once on shutdown', async () => {
    const instanceId = 'host-1:my-app:3000';

    @Module({
      imports: [
        EurekaModule.forRoot({
          serviceUrl: stub.url,
          instance: {
            app: 'my-app',
            hostName: 'host-1',
            ipAddr: '127.0.0.1',
            port: 3000,
            instanceId,
          },
          heartbeatIntervalSeconds: 1,
          leaseDurationSeconds: 3,
        }),
      ],
    })
    class TestModule {}

    // createApplicationContext() calls init() internally — bootstrap (and
    // therefore the initial registration) has already happened by the time
    // this resolves. No HTTP platform adapter needed (no @nestjs/platform-express).
    const appContext = await NestFactory.createApplicationContext(TestModule, {
      logger: false,
    });

    try {
      await waitFor(() => stub.requests.some((r) => r.method === 'POST'));
      await waitFor(() => stub.requests.some((r) => r.method === 'PUT'));

      const registerCountBeforeForget = stub.requests.filter(
        (r) => r.method === 'POST',
      ).length;
      stub.forget(instanceId);
      await waitFor(
        () =>
          stub.requests.filter((r) => r.method === 'POST').length >
          registerCountBeforeForget,
        5000,
      );

      const service = appContext.get(EurekaService);
      const instances = await service.getInstances('my-app');
      expect(instances).toHaveLength(1);
      expect(instances[0].instanceId).toBe(instanceId);
    } finally {
      await appContext.close();
    }

    const deleteRequests = stub.requests.filter((r) => r.method === 'DELETE');
    expect(deleteRequests).toHaveLength(1);
  }, 20_000);
});
