# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once releases begin.

## [Unreleased]

## [0.1.0] - 2026-09-28

First published release.

### Added

- `EurekaModule.forRoot()` / `.forRootAsync()` (`useFactory`/`useClass`/`useExisting`) — NestJS integration for Netflix Eureka.
- `EurekaService` — registers the configured instance on application bootstrap, heartbeats on a schedule, re-registers on a heartbeat 404, and deregisters on shutdown (idempotent, never throws).
- `EurekaService.getInstances(appName)` — Eureka service discovery, unfiltered by status.
- `EurekaRequestError` — structured error for failed register/renew/deregister/discovery calls.
- `registrationMode` option (`'fail-fast'` default, or `'background'`) — in background mode a failed initial registration no longer fails application bootstrap; it is retried on the heartbeat schedule instead.
- `requestTimeoutMs` option (default 5000) — replaces the previous fixed, non-configurable 5-second request timeout.
- Public types: `EurekaModuleOptions`, `EurekaModuleAsyncOptions`, `EurekaOptionsFactory`, `EurekaInstanceOptions`, `EurekaInstance`, `EurekaInstanceStatus`.
- CI (GitHub Actions): lint, unit tests with coverage, e2e tests, and build run on every push/PR to `master`, against Node.js 20.3.0 and 22. Coverage is reported (uploaded as an artifact, and posted as a PR comment) but not gated on a threshold.
- `serviceUrl` now also accepts an array of URLs for failover. A network error/timeout or a 5xx response tries the next server; a 4xx does not. The server that last completed a call successfully is preferred on the next call — see README's "Failover across multiple servers".

### Changed

- `@nestjs/common` is now a peer dependency (`^11.0.0`) instead of a regular dependency; `@nestjs/core`/`@nestjs/platform-express` are no longer runtime dependencies of this package.
- Shutdown now aborts an in-flight heartbeat/registration request instead of waiting for it to settle or time out. A cancelled registration whose outcome is unknown still triggers a best-effort deregistration.
- Minimum supported Node.js version is now 20.3.0 (was 20.0.0) — required for `AbortSignal.any`.

### Fixed

- `serviceUrl` given as multiple URLs joined into one string (e.g. Spring's comma-joined `defaultZone` convention, or URLs accidentally joined by a newline/space/semicolon) without embedded credentials was silently mis-parsed as a single, garbled URL instead of being rejected — the rejection check only looked for `@` in the parsed path, which is absent when neither URL has basic-auth credentials. Now detected on the raw input before parsing, for any of these separators and regardless of credentials, without falsely rejecting a single URL whose password happens to contain a literal comma or semicolon.
- With multiple configured `serviceUrl` servers, `deregister()` used to stop at whichever server was currently preferred and treat a 404 there as done — since the preferred server is just a best-effort hint that an unrelated `getInstances()` call can move, this could leave the actual registration behind on a different, independent server until its lease expired. `deregister()` now attempts every configured server, unconditionally, on shutdown. One side effect: if any single configured server is unreachable at shutdown, that now always surfaces as a logged warning, even when every other server's deregistration succeeded (previously, one success anywhere silenced the rest).
- A redirect (3xx) response from Eureka (or a proxy in front of it) was silently followed by `fetch`'s default `redirect: 'follow'` behavior — a redirected `POST`/`PUT` is replayed as a `GET`, dropping the body, so `response.ok` ended up reflecting whatever the redirect target returned rather than the original request, making a registration that never actually landed look like a success. Redirects are no longer followed; a 3xx now throws a clear `EurekaRequestError` naming the status code.
- A registration that failed on its own with an unknown outcome — a timeout, network error, or 5xx, where Eureka may have applied the `POST` even though no success reached the client — was never deregistered: only a registration cancelled by shutdown was treated that way. In fail-fast mode this left a phantom `UP` instance behind after a failed bootstrap (Nest never runs shutdown hooks then); in background mode, shutting down before a heartbeat reconciled it did the same. This is now tracked per register *attempt*, not by the final error: with multiple servers, a timeout on one server followed by a 4xx (or a success) from another still counts. Such a registration now always gets one best-effort deregistration attempt (which, as above, reaches every configured server; a failed attempt is logged, not retried), and a later heartbeat answer from a single server never cancels that. Behavior changes: a fail-fast bootstrap failure after such a registration now waits for that deregistration (up to `serviceUrls.length × requestTimeoutMs`) before rejecting, still with the original registration error; and background mode with Eureka unreachable the whole time now attempts a deregistration on shutdown (previously none), which may itself time out and log a warning — shutdown can take up to `serviceUrls.length × requestTimeoutMs` longer.

[Unreleased]: https://github.com/School-of-Company/nestjs-eureka/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/School-of-Company/nestjs-eureka/releases/tag/v0.1.0
