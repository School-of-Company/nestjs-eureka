# Contributing

Thanks for your interest in contributing to `nestjs-eureka`.

## Getting started

This project uses [pnpm](https://pnpm.io), pinned via the `packageManager` field in `package.json`. With [Corepack](https://nodejs.org/api/corepack.html) enabled (`corepack enable`), running `pnpm` in this repo automatically uses the pinned version — no separate global install needed.

```bash
git clone git@github.com:School-of-Company/nestjs-eureka.git
cd nestjs-eureka
pnpm install
```

## Development commands

```bash
pnpm build       # compile
pnpm lint        # eslint (auto-fixes)
pnpm lint:check  # eslint, no auto-fix — what CI/review should run
pnpm format      # prettier (auto-fixes)
pnpm test        # unit tests
pnpm test:e2e    # e2e tests
pnpm test:cov    # unit tests with coverage
```

## Branching

Branch naming: `feat/<scope>`, `fix/<scope>`, `chore/<scope>`, `docs/<scope>`

## Commit Message Guidelines

This project follows the same commit message convention as [NestJS itself](https://github.com/nestjs/nest/blob/master/CONTRIBUTING.md#commit), since `nestjs-eureka` is a NestJS integration library.

### Format

Each commit message consists of a **header**, an optional **body**, and an optional **footer**:

```
<type>(<scope>): <subject>

<body>

<footer>
```

- The header is mandatory; `<scope>` is optional.
- No line may be longer than 100 characters.

### Type

Must be one of:

- **feat**: a new feature
- **fix**: a bug fix
- **docs**: documentation only changes
- **style**: changes that don't affect the meaning of the code (formatting, missing semicolons, etc.)
- **refactor**: a code change that neither fixes a bug nor adds a feature
- **perf**: a code change that improves performance
- **test**: adding missing tests or correcting existing tests
- **build**: changes to the build system or external dependencies
- **ci**: changes to CI configuration files and scripts
- **chore**: other changes that don't modify source or test files
- **revert**: reverts a previous commit

### Scope

Unlike the `nestjs/nest` monorepo, this is a single-package library, so the scope names the affected area instead of an npm package:

- **core**: the framework-agnostic Eureka client/protocol logic
- **nest**: the NestJS module/provider/lifecycle integration layer
- **docs**: documentation
- **deps**: dependency changes

Omit the scope for changes that cut across areas (e.g. a repo-wide `style` or `chore` change).

### Subject

- Imperative, present tense: "add", not "added" or "adds"
- Don't capitalize the first letter
- No period (.) at the end

### Body

Imperative, present tense, same as the subject. Explain the motivation for the change and contrast it with previous behavior.

### Footer

- **Breaking changes** start with `BREAKING CHANGE:` and must also be documented in [CHANGELOG.md](./CHANGELOG.md) under `[Unreleased]`.
- Reference issues this commit closes, e.g. `Closes #42`.

### Revert

A commit that reverts a previous commit starts with `revert:`, followed by the header of the reverted commit. The body should say `This reverts commit <hash>.`

### Examples

```
fix(core): retry eureka registration on transient network error

docs: document the 0.1.0 release in the changelog
```

## Library guidelines

`nestjs-eureka` is a reusable library, not an application, so a few things matter more here than in a typical service:

- Keep runtime dependencies minimal — think about what every new dependency costs consumers of the library.
- Avoid `any`; prefer precise types.
- Public APIs need tests.
- Only export what's intended to be public from the package entry point. An accidental export becomes part of the public API surface. Any change to an exported type, class, or function is a public API change and must be called out.
- Breaking changes must be documented in [CHANGELOG.md](./CHANGELOG.md).
- Where the library depends on `@nestjs/*` packages, those should generally be `peerDependencies` rather than regular dependencies, so consumers don't end up with a duplicate copy of NestJS. Actual version ranges should be based on tested compatibility, not guessed.

## Pull requests

- Use the PR template (`.github/PULL_REQUEST_TEMPLATE.md`) — it's applied automatically when you open a PR.
- Make sure `pnpm lint:check`, `pnpm test`, `pnpm test:e2e`, and `pnpm build` all pass before requesting review.

## Issues

- Bug reports and feature requests use the templates under `.github/ISSUE_TEMPLATE/`.
- Do not report security vulnerabilities through public issues — see [SECURITY.md](./SECURITY.md).
