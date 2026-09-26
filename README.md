# nestjs-eureka

A NestJS integration for Netflix Eureka service registration and discovery.

> **Status: pre-release.** The public API may still change before a 1.0 release. Verified both against an in-repo HTTP stub server and manually against a real Spring Cloud Netflix Eureka Server — see [Compatibility](#compatibility).

## Installation

> This package has not been published yet.

```bash
pnpm add @school-of-company/nestjs-eureka
```

## Quick Start

```ts
import { Module } from '@nestjs/common';
import { EurekaModule } from '@school-of-company/nestjs-eureka';

@Module({
  imports: [
    EurekaModule.forRoot({
      serviceUrl: 'http://localhost:8761/eureka',
      instance: {
        app: 'my-service',
        hostName: 'my-service.internal',
        ipAddr: '10.0.0.5',
        port: 3000,
      },
    }),
  ],
})
export class AppModule {}
```

Call `EurekaModule.forRoot()`/`forRootAsync()` **once, in your root/application module** — it's a normal (non-global) module, so import that module (or re-export `EurekaService`) wherever else in your app you need to inject `EurekaService`. Importing `forRoot()`/`forRootAsync()` itself more than once would start a second, independent registration and heartbeat loop.

For deregistration to run on a clean shutdown (SIGTERM/SIGINT), call `app.enableShutdownHooks()` on your Nest application — see [Service registration](#service-registration) below for exactly what that does and doesn't guarantee.

## Configuration

`EurekaModule.forRoot()` takes an `EurekaModuleOptions` object:

| Option | Required | Default | Notes |
|---|---|---|---|
| `serviceUrl` | yes | — | A single Eureka base URL, e.g. `http://localhost:8761/eureka`. Basic-auth credentials embedded in the URL (`http://user:pass@host/eureka`) are supported and are converted into an `Authorization` header — never passed to `fetch` as part of the URL. Multiple Eureka server URLs (e.g. Spring's comma-joined `defaultZone` convention) aren't supported yet and are rejected with a clear error rather than silently mis-parsed. |
| `instance.app` | yes | — | The application/service name. Uppercased for the Eureka wire protocol; the discovery API reflects Eureka's own normalized value, not necessarily your original casing. |
| `instance.hostName` | yes | — | |
| `instance.ipAddr` | yes | — | |
| `instance.port` | yes | — | |
| `instance.instanceId` | no | `` `${hostName}:${app}:${port}` `` | Two replicas sharing the same `hostName`+`app`+`port` would register as the same instance — pass an explicit, unique `instanceId` in production/containerized deployments. |
| `instance.securePort` | no | disabled | |
| `instance.vipAddress` / `instance.secureVipAddress` | no | `instance.app` | |
| `instance.metadata` | no | `{}` | String values only. |
| `instance.homePageUrl` / `instance.statusPageUrl` / `instance.healthCheckUrl` | no | — | |
| `heartbeatIntervalSeconds` | no | `30` | Must be smaller than `leaseDurationSeconds`. |
| `leaseDurationSeconds` | no | `90` | |

## `EurekaModule.forRoot()`

Takes an `EurekaModuleOptions` object directly, as shown in Quick Start above.

## `EurekaModule.forRootAsync()`

For options that need to come from another provider (e.g. `ConfigService`). Supports the three standard NestJS strategies:

```ts
// useFactory
EurekaModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    serviceUrl: config.get('EUREKA_URL'),
    instance: { app: 'my-service', hostName: config.get('HOSTNAME'), ipAddr: config.get('IP'), port: 3000 },
  }),
});

// useClass
EurekaModule.forRootAsync({ useClass: MyEurekaOptionsFactory });

// useExisting (reuse a provider that's already registered elsewhere)
EurekaModule.forRootAsync({ useExisting: MyEurekaOptionsFactory });
```

`MyEurekaOptionsFactory` implements `EurekaOptionsFactory`:

```ts
export class MyEurekaOptionsFactory implements EurekaOptionsFactory {
  createEurekaOptions(): EurekaModuleOptions {
    /* ... */
  }
}
```

## Service registration

On application bootstrap, `EurekaService` registers the configured instance with Eureka and starts a heartbeat on `heartbeatIntervalSeconds` (default 30s).

- **Startup failure is fail-fast.** If the initial registration call fails, application bootstrap fails (Nest's `onApplicationBootstrap` rejects) rather than starting a service that's silently unregistered. This trades off availability during a Eureka outage for never running undiscoverable; a background-registration mode is a possible future addition, not implemented today.
- **Heartbeat 404 triggers re-registration.** If a heartbeat gets a 404 (Eureka no longer has the instance — e.g. after a Eureka server restart), the library re-registers once and keeps heartbeating. If that one-shot re-registration itself fails, it's logged and retried on the next heartbeat tick — the loop never stops because of this.
- **Every Eureka request has a fixed, non-configurable 5-second timeout.** This bounds requests but is **not** shutdown cancellation: on shutdown, an in-flight heartbeat/registration call is still awaited before deregistering, so shutdown can itself take up to ~5 seconds in the worst case. A configurable timeout and true in-flight cancellation on shutdown are not implemented yet.
- **Deregistration runs on shutdown**, via Nest's `beforeApplicationShutdown` hook. This hook fires on `app.close()` regardless of `enableShutdownHooks()`. What `app.enableShutdownHooks()` adds is Nest listening for OS signals (SIGTERM/SIGINT) and calling `app.close()` for you — without it, if your process is killed by a signal, Nest's shutdown hooks (and therefore deregistration) never run, and the instance stays registered in Eureka until its lease expires (`leaseDurationSeconds`, default 90s). Call `app.enableShutdownHooks()` if you want a clean deregistration on a normal container/orchestrator shutdown signal.
- Deregistration is idempotent — shutting down more than once never sends more than one `DELETE`, and never throws.
- **This library only controls its own hook.** If *another* provider's shutdown hook rejects during `app.close()`, Nest can abort the shutdown sequence before `beforeApplicationShutdown` runs for every provider — in that case deregistration may not happen, and the instance stays registered until its lease expires. This is a property of how Nest's own shutdown sequencing works, not something this library can control.

## Service discovery

```ts
const instances = await eurekaService.getInstances('other-service');
const healthy = instances.filter((i) => i.status === 'UP');
```

`getInstances(appName)` makes one Eureka HTTP request per call and returns **every** instance Eureka reports for that app, unfiltered by status — filtering (e.g. to `status === 'UP'`) is the caller's responsibility, as shown above. There's no client-side caching or periodic background refresh in this version; a cached/periodically-refreshed local registry is a possible future addition.

Note that a real Eureka server serves this endpoint from its own internal response cache, which refreshes periodically rather than instantly — so a `getInstances()` call can briefly still show (or briefly still omit) an instance for a short window right after it registers or deregisters elsewhere. This is normal, documented Eureka server behavior (confirmed against a real server, not just this library's own stub), not a bug in this library.

## API

The package's public surface is exactly:

- `EurekaModule` — `.forRoot()`, `.forRootAsync()`
- `EurekaService` — `.getInstances(appName)`
- Types: `EurekaModuleOptions`, `EurekaModuleAsyncOptions`, `EurekaOptionsFactory`, `EurekaInstanceOptions`, `EurekaInstance`, `EurekaInstanceStatus`
- `EurekaRequestError` — thrown for non-2xx/network/timeout failures during a register/renew/deregister/discovery call. Has `operation`, `method`, `url` (credential-free), `status`, `statusText`, and `cause` (the underlying error, if any) fields.

Nothing else is part of the supported public API, even if reachable through a deep import.

## Compatibility

- Current development target: NestJS 11 (peer dependency `^11.0.0`; tested against 11.2.5)
- Node.js ≥ 20 (uses the built-in `fetch` and `AbortSignal.timeout`)
- Eureka server compatibility: manually verified against a real **Spring Cloud Netflix Eureka Server 4.1.1** (Spring Boot 3.2.4, via the [`steeltoeoss/eureka-server`](https://hub.docker.com/r/steeltoeoss/eureka-server) Docker image) — registration, heartbeat renewal, 404-triggered re-registration, deregistration, and service discovery (including a real second service being discovered and then actually reached over HTTP) all worked as documented above. Not yet part of an automated CI job; re-verify manually after any protocol-level change to `src/core/`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to set up the project, coding guidelines, and the PR process.

## Security

See [SECURITY.md](./SECURITY.md) for how to report a vulnerability.

## License

[MIT](./LICENSE)
