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

### Changed

- `@nestjs/common` is now a peer dependency (`^11.0.0`) instead of a regular dependency; `@nestjs/core`/`@nestjs/platform-express` are no longer runtime dependencies of this package.
- Shutdown now aborts an in-flight heartbeat/registration request instead of waiting for it to settle or time out. A cancelled registration whose outcome is unknown still triggers a best-effort deregistration.
- Minimum supported Node.js version is now 20.3.0 (was 20.0.0) — required for `AbortSignal.any`.
