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
- Public types: `EurekaModuleOptions`, `EurekaModuleAsyncOptions`, `EurekaOptionsFactory`, `EurekaInstanceOptions`, `EurekaInstance`, `EurekaInstanceStatus`.

### Changed

- `@nestjs/common` is now a peer dependency (`^11.0.0`) instead of a regular dependency; `@nestjs/core`/`@nestjs/platform-express` are no longer runtime dependencies of this package.
