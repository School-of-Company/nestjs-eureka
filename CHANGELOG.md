# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once releases begin.

## [Unreleased]

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
