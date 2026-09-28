# nestjs-eureka

[![CI](https://github.com/School-of-Company/nestjs-eureka/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/School-of-Company/nestjs-eureka/actions/workflows/ci.yml)

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
| `serviceUrl` | yes | — | One Eureka base URL, or an array of several for failover, e.g. `http://localhost:8761/eureka` or `['http://a:8761/eureka', 'http://b:8761/eureka']`. Basic-auth credentials embedded in a URL (`http://user:pass@host/eureka`) are supported and are converted into an `Authorization` header — never passed to `fetch` as part of the URL; each URL in an array has its own independent credentials. A comma-joined multi-URL string (e.g. Spring's `defaultZone` convention) is **not** supported and is rejected with a clear error — pass an array instead. See [Failover across multiple servers](#failover-across-multiple-servers). |
| `instance.app` | yes | — | The application/service name. Uppercased for the Eureka wire protocol; the discovery API reflects Eureka's own normalized value, not necessarily your original casing. |
| `instance.hostName` | yes | — | |
| `instance.ipAddr` | yes | — | |
| `instance.port` | yes | — | |
| `instance.instanceId` | no | `` `${hostName}:${app}:${port}` `` | Two replicas sharing the same `hostName`+`app`+`port` would register as the same instance — pass an explicit, unique `instanceId` in production/containerized deployments. |
| `instance.securePort` | no | disabled | |
| `instance.vipAddress` / `instance.secureVipAddress` | no | `instance.app` | |
| `instance.metadata` | no | `{}` | String values only. |
| `instance.homePageUrl` / `instance.statusPageUrl` / `instance.healthCheckUrl` | no | — | |
| `heartbeatIntervalSeconds` | no | `30` | Must be smaller than `leaseDurationSeconds`, and at most 2,147,483 (see note below). |
| `leaseDurationSeconds` | no | `90` | At most 2,147,483,647 (see note below). |
| `registrationMode` | no | `'fail-fast'` | `'fail-fast'` or `'background'` — what happens when the initial registration fails. See [Service registration](#service-registration). |
| `requestTimeoutMs` | no | `5000` | Timeout for each individual Eureka HTTP request. At most 2,147,483,647 (see note below). |

> `instance.app`, `instance.hostName`, `instance.ipAddr`, and `instance.instanceId` (if set) must not be empty or whitespace-only — such a value is rejected at configuration time. A value that passes is used exactly as given; surrounding whitespace is never trimmed.

> `heartbeatIntervalSeconds`, `leaseDurationSeconds`, and `requestTimeoutMs` are rejected at configuration time if they'd exceed Node's 32-bit signed timer-delay limit (2,147,483,647ms, once converted to ms for `heartbeatIntervalSeconds`) — a larger value doesn't fail loudly on its own: `setTimeout` silently clamps it to ~1ms (turning the heartbeat loop into a hot loop instead of the intended ~25-day-max interval), and `AbortSignal.timeout` throws a confusing generic `RangeError` from inside a request.

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

- **Startup failure is fail-fast by default.** If the initial registration call fails, application bootstrap fails (Nest's `onApplicationBootstrap` rejects) rather than starting a service that's silently unregistered. This trades off availability during a Eureka outage for never running undiscoverable. If the failed registration's outcome is unknown — a timeout, network error, or 5xx on any server tried, where Eureka may have applied it anyway — a best-effort deregistration is sent *before* bootstrap rejects (Nest doesn't run shutdown hooks after a failed bootstrap, so there'd be no later chance). That can delay the bootstrap failure by up to `serviceUrls.length × requestTimeoutMs`; the rejection is always the original registration error.
- **`registrationMode: 'background'` lets the app boot anyway.** A failed initial registration is logged as a warning, bootstrap continues, and the heartbeat loop keeps retrying every `heartbeatIntervalSeconds` (no backoff) until Eureka accepts the instance. Until then the service runs but is **not discoverable** by other services. Each retry is a heartbeat first: if the earlier registration actually reached Eureka (e.g. only its response timed out), the heartbeat succeeds and no second registration is sent; if Eureka answers 404, re-registration is attempted (and retried on the next heartbeat if it fails). If shutdown happens while a registration attempt is still in flight, see **Shutdown aborts the in-flight heartbeat/registration request** below — its outcome is treated as unknown, and a best-effort deregistration is sent either way. The same holds for any earlier registration attempt that timed out, hit a network error, or got a 5xx: shutdown deregisters even if no heartbeat has run yet, and even if a later heartbeat got a 404 (with several servers, one server's 404 doesn't prove another isn't still holding it).
- **Heartbeat 404 triggers re-registration.** If a heartbeat gets a 404 (Eureka no longer has the instance — e.g. after a Eureka server restart), the library re-registers once and keeps heartbeating. If that one-shot re-registration itself fails, it's logged and retried on the next heartbeat tick — the loop never stops because of this.
- **Every Eureka request has a timeout**, `requestTimeoutMs` (default 5000ms).
- **A redirect (3xx) response is never followed.** If something in front of Eureka (an ingress/proxy doing an http→https rewrite, for example) redirects a request, that fails with a clear `EurekaRequestError` naming the status code, instead of silently replaying the request as a `GET` against whatever the redirect target happens to be — which could otherwise make a registration that never actually landed look like it succeeded. Point `serviceUrl` at the final URL directly.
- **Shutdown aborts the in-flight heartbeat/registration request** rather than waiting for it to settle or time out, then attempts a deregistration against *every* configured server (see [Failover across multiple servers](#failover-across-multiple-servers)) — with a single server (the default) that's one `DELETE`, bounded by `requestTimeoutMs`; with several, every one of them gets an attempt, sequentially, up to `serviceUrls.length × requestTimeoutMs` in the worst case. This is deliberate: a success (or a harmless 404) on one server says nothing about whether the registration ended up on another, so shutdown doesn't stop early. Cancellation is best-effort — it depends on `fetch` honoring `AbortSignal`, not a strict timing guarantee. If the aborted call was a registration whose outcome is unknown (Eureka may have already applied it before the cancellation reached the client), shutdown still attempts a best-effort deregistration — a `DELETE` for an instance Eureka never actually registered is treated as a harmless no-op.
- **Deregistration runs on shutdown**, via Nest's `beforeApplicationShutdown` hook. This hook fires on `app.close()` regardless of `enableShutdownHooks()`. What `app.enableShutdownHooks()` adds is Nest listening for OS signals (SIGTERM/SIGINT) and calling `app.close()` for you — without it, if your process is killed by a signal, Nest's shutdown hooks (and therefore deregistration) never run, and the instance stays registered in Eureka until its lease expires (`leaseDurationSeconds`, default 90s). Call `app.enableShutdownHooks()` if you want a clean deregistration on a normal container/orchestrator shutdown signal.
- Deregistration is idempotent — shutting down more than once never sends more than one deregistration attempt (or attempt sequence, with multiple servers), and never throws.
- **This library only controls its own hook.** If *another* provider's shutdown hook rejects during `app.close()`, Nest can abort the shutdown sequence before `beforeApplicationShutdown` runs for every provider — in that case deregistration may not happen, and the instance stays registered until its lease expires. This is a property of how Nest's own shutdown sequencing works, not something this library can control.

## Failover across multiple servers

Pass an array to `serviceUrl` to configure more than one Eureka server:

```ts
EurekaModule.forRoot({
  serviceUrl: ['http://eureka-a:8761/eureka', 'http://eureka-b:8761/eureka'],
  instance: { app: 'my-service', hostName: 'host-1', ipAddr: '10.0.0.1', port: 3000 },
});
```

- **A network error, timeout, or 5xx response fails over to the next server** — that server is treated as broken. **A 4xx (or a 3xx redirect) response never fails over** — it's a real answer from a reachable node (e.g. a malformed request, or a proxy/ingress redirect in front of it), not evidence the node is down. This applies to registration, heartbeat, and discovery. A discovery response whose *body* times out mid-read (headers arrived, but the full JSON didn't within `requestTimeoutMs`) is treated the same as a request timeout, not as malformed data from a reachable node — it fails over too.
- **The server that last completed a call successfully is preferred on the next call** — a 2xx, or a meaningful 404 for renew/discovery. A terminal 4xx doesn't change the preference; only a real success does. Once a server becomes preferred, it's used for every subsequent call until *it* fails — there's no periodic re-probing of an earlier server, and no load balancing across always-healthy nodes; this is failover/redundancy only. Concurrent calls (e.g. discovery running alongside a heartbeat) can each update this independently — it's a best-effort ordering hint, not a strict guarantee.
- **An intentional shutdown never fails over.** If `stop()`'s cancellation (see [Service registration](#service-registration)) is what aborted the in-flight call, that's propagated immediately — there's no point trying another server while shutting down.
- **Deregistration is the one operation that doesn't follow "try until one succeeds, prefer it next time."** Since `preferredIndex` is just a best-effort hint — a plain, unrelated discovery call can move it without the registration itself ever moving — shutdown instead attempts a deregistration against **every** configured server, unconditionally, regardless of `preferredIndex`. See [Service registration](#service-registration)'s shutdown bullet.
- Recovering after a server goes down still goes through the same heartbeat-404-then-re-register path described above: a heartbeat that fails over to a server which has never seen this instance gets a 404 back (a real answer, not a failure), which triggers the existing re-registration logic against that now-preferred server.

## Service discovery

```ts
const instances = await eurekaService.getInstances('other-service');
const healthy = instances.filter((i) => i.status === 'UP');
```

`getInstances(appName)` makes one Eureka HTTP request per call and returns **every** instance Eureka reports for that app, unfiltered by status — filtering (e.g. to `status === 'UP'`) is the caller's responsibility, as shown above. There's no client-side caching or periodic background refresh in this version; a cached/periodically-refreshed local registry is a possible future addition (tracked in [#3](https://github.com/School-of-Company/nestjs-eureka/issues/3)).

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
- Node.js ≥ 20.3.0 (uses the built-in `fetch`, `AbortSignal.timeout`, and `AbortSignal.any`)
- Eureka server compatibility: manually verified against a real **Spring Cloud Netflix Eureka Server 4.1.1** (Spring Boot 3.2.4, via the [`steeltoeoss/eureka-server`](https://hub.docker.com/r/steeltoeoss/eureka-server) Docker image) — registration, heartbeat renewal, 404-triggered re-registration, deregistration, and service discovery (including a real second service being discovered and then actually reached over HTTP) all worked as documented above. Not yet part of an automated CI job; re-verify manually after any protocol-level change to `src/core/`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to set up the project, coding guidelines, and the PR process.

## Security

See [SECURITY.md](./SECURITY.md) for how to report a vulnerability.

## License

[MIT](./LICENSE)
