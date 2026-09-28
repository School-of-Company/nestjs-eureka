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

  it('shutdown cancels a hanging heartbeat instead of waiting out requestTimeoutMs, then deregisters exactly once', async () => {
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
          requestTimeoutMs: 10_000,
        }),
      ],
    })
    class TestModule {}

    const appContext = await NestFactory.createApplicationContext(TestModule, {
      logger: false,
    });

    stub.hangRenewals = true;
    // Proves the PUT has actually reached the server (and is hanging there)
    // before we shut down — otherwise this could pass by shutting down before
    // any heartbeat was in flight.
    await waitFor(() => stub.hangingRenewalCount === 1, 5000);

    const started = performance.now();
    await appContext.close();
    const elapsedMs = performance.now() - started;

    // Evidence that cancellation works through real undici — not a library
    // timing contract. Without cancellation this would take ~10s.
    expect(elapsedMs).toBeLessThan(2_000);
    const deleteRequests = stub.requests.filter((r) => r.method === 'DELETE');
    expect(deleteRequests).toHaveLength(1);
    expect(stub.hangingRenewalCount).toBe(1);
  }, 20_000);

  it('background mode: boots while Eureka rejects registration, registers once Eureka recovers, and deregisters exactly once', async () => {
    const instanceId = 'host-1:my-app:3000';
    stub.failRegistrations = true;

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
          registrationMode: 'background',
        }),
      ],
    })
    class TestModule {}

    const appContext = await NestFactory.createApplicationContext(TestModule, {
      logger: false,
    });

    try {
      expect(stub.requests.filter((r) => r.method === 'POST')).toHaveLength(1);

      stub.failRegistrations = false;
      await waitFor(
        () => stub.requests.filter((r) => r.method === 'POST').length >= 2,
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

  it('fails over to a second, independent Eureka server when the first goes down, recovering via the existing 404-triggered re-register path', async () => {
    const instanceId = 'host-1:my-app:3000';
    // Two fully independent stub servers — B has never heard of this
    // instance, exactly like an unrelated real Eureka node would be.
    const serverA = new EurekaStubServer();
    const serverB = new EurekaStubServer();
    await serverA.listen();
    await serverB.listen();

    @Module({
      imports: [
        EurekaModule.forRoot({
          serviceUrl: [serverA.url, serverB.url],
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

    const appContext = await NestFactory.createApplicationContext(TestModule, {
      logger: false,
    });

    try {
      // Initial registration lands on A (the default preferred server).
      await waitFor(() => serverA.requests.some((r) => r.method === 'POST'));
      expect(serverA.requests.filter((r) => r.method === 'POST')).toHaveLength(
        1,
      );
      // Let at least one heartbeat succeed against A before taking it down,
      // so this is a genuine mid-flight failover, not a lucky race.
      await waitFor(() => serverA.requests.some((r) => r.method === 'PUT'));

      await serverA.close();

      // Recovery path: the next heartbeat's PUT to (dead) A fails at the
      // transport level and fails over to B; B has never seen this instance,
      // so it answers 404 — the same "not-found" result the single-server
      // 404 test already exercises — which re-registers (POST) on B, now the
      // preferred server, and later heartbeats (PUT) against B succeed.
      await waitFor(
        () => serverB.requests.filter((r) => r.method === 'PUT').length >= 2,
        10_000,
      );
      const methods = serverB.requests.map((r) => r.method);
      const firstPut = methods.indexOf('PUT');
      const post = methods.indexOf('POST');
      const secondPut = methods.indexOf('PUT', post + 1);
      expect(firstPut).toBeGreaterThanOrEqual(0);
      expect(post).toBeGreaterThan(firstPut);
      expect(secondPut).toBeGreaterThan(post);

      const service = appContext.get(EurekaService);
      const instances = await service.getInstances('my-app');
      expect(instances).toHaveLength(1);
      expect(instances[0].instanceId).toBe(instanceId);
    } finally {
      await appContext.close();
      // Both close() calls are idempotent — safe even though serverA was
      // already closed above (and even if an assertion threw before that).
      await serverA.close();
      await serverB.close();
    }

    expect(serverB.requests.filter((r) => r.method === 'DELETE')).toHaveLength(
      1,
    );
  }, 20_000);

  it('shutdown deregisters from a server whose registration was left behind after an unrelated discovery call moved the preferred server (#17)', async () => {
    const instanceId = 'host-1:my-app:3000';
    const serverA = new EurekaStubServer();
    const serverB = new EurekaStubServer();
    await serverA.listen();
    await serverB.listen();

    @Module({
      imports: [
        EurekaModule.forRoot({
          serviceUrl: [serverA.url, serverB.url],
          instance: {
            app: 'my-app',
            hostName: 'host-1',
            ipAddr: '127.0.0.1',
            port: 3000,
            instanceId,
          },
          // Long enough that no heartbeat can fire in the short window
          // between the discovery call below and app.close() — this test
          // is entirely about a discovery call, not a heartbeat tick.
          heartbeatIntervalSeconds: 30,
          leaseDurationSeconds: 90,
        }),
      ],
    })
    class TestModule {}

    const appContext = await NestFactory.createApplicationContext(TestModule, {
      logger: false,
    });

    try {
      // The registration lives only on A. A stays up the whole test — this
      // is deliberately not a server-outage scenario (that's the failover
      // test above); it's a read-only discovery call, which used to be
      // enough (before this fix) to break shutdown cleanup on its own.
      await waitFor(() => serverA.requests.some((r) => r.method === 'POST'));

      // Force a discovery-only failover to B: A's discovery endpoint
      // (not registration/renewal/deregistration) briefly errors, so
      // getInstances() falls over to B. B never had this instance
      // registered, and B's own GET is asserted below to confirm it was
      // actually reached (not just that A's discovery failed).
      serverA.failDiscovery = true;
      const service = appContext.get(EurekaService);
      await service.getInstances('my-app');
      serverA.failDiscovery = false;

      // Old, `withFailover()`-routed deregister() started from
      // `preferredIndex` — which this discovery call could move to B — and
      // stopped at B's response (this stub's DELETE always answers 200,
      // whether or not the instance was ever registered there), never
      // reaching A. The current deregister() doesn't consult
      // `preferredIndex` at all: it always attempts every configured
      // server, so it reaches A (where the registration actually lives)
      // regardless of what discovery did.
    } finally {
      await appContext.close();
      await serverA.close();
      await serverB.close();
    }

    expect(serverB.requests.filter((r) => r.method === 'GET')).toHaveLength(1); // confirms B was actually reached for discovery, not just A failing
    expect(serverA.requests.filter((r) => r.method === 'DELETE')).toHaveLength(
      1,
    );
    expect(serverB.requests.filter((r) => r.method === 'DELETE')).toHaveLength(
      1,
    );
  }, 20_000);
});
