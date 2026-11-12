# Hono OpenAPI Starter

A reusable Node.js backend starter built on Hono, Zod OpenAPI, Better Auth, and Drizzle ORM with swappable infrastructure adapters.

## Language

**Feature Module**:
A self-contained vertical slice under `src/modules/<feature>/` owning HTTP routes, handlers, orchestration logic, repository `Port`, validation schemas, optional `<feature>.jobs.ts` job definitions, and unit tests for one capability.
_Avoid_: Route group, domain, plugin, service (reserve `*.service.ts` strictly for a module's internal orchestration file)

**Core**:
The driver-agnostic platform kernel under `src/core/` providing the Hono router factory, `AppBindings`, OpenAPI setup, env config, error taxonomy, shared middlewares, and port interfaces.
_Avoid_: Lib, utils, shared, framework

**Infra**:
Concrete driver implementations and zero-dependency dev/test stand-ins under `src/infra/` that satisfy Core ports, plus `createContainer` wiring.
_Avoid_: Providers, drivers, external

**Port**:
A narrow TypeScript interface in `src/core/ports/` (or module-declared repository interface) defining a seam without coupling callers to a concrete driver.
_Avoid_: Client, gateway

**Adapter**:
A concrete implementation in `src/infra/` (production driver or in-memory/local test fallback) that satisfies a Port.
_Avoid_: Driver, plugin, mock (reserve mock for test-framework spies)

**Composition Root**:
The assembly layer (`createContainer` in `src/infra/container.ts`, `createApp(deps)` in `src/app.ts` building the Hono application and RPC `AppType`, and `createWorkerRuntime` / `registerModuleJobs` in `src/worker.ts`) where concrete Adapters are wired into Feature Modules.
_Avoid_: Bootstrap, wiring, registry

**PlatformDeps**:
The shared dependency bundle of Core `Port`s, validated `env`, `logger`, and lifecycle signals passed into `createApp(deps)` and narrowed per Feature Module (`Deps`).
_Avoid_: AppDeps, ContextDeps, Services, Container (when inside modules)

**Container**:
The owned runtime instance (`PlatformDeps` plus `close(): Promise<void>`) returned by `createContainer(env)` for process entrypoints (`src/index.ts`, `src/worker.ts`) and test helpers to manage adapter teardown.
_Avoid_: Registry, Singleton, PlatformDeps

**Contract Suite**:
A parameterized Vitest factory under `tests/contracts/` that verifies behavioral parity across every `Adapter` (in-memory/local in `unit`, real driver in `integration`) or repository implementing a `Port`.
_Avoid_: Mock suite, adapter unit test
