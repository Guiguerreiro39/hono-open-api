---
status: accepted
---

# Database portability, schema isolation, and migration workflow

We keep a single SQLite/libSQL Drizzle schema inside `src/infra/db/` (with dialect-free repository `Port` interfaces and pure `@hono/zod-openapi` DTOs inside `src/modules/`), standardize all entities on app-generated UUIDv4 `text` primary keys, millisecond timestamps (`timestamp_ms`), and `text({ enum })` columns, commit SQL migrations everywhere via `drizzle-kit generate` + explicit `pnpm db:migrate` CLI, and run isolated `:memory:` libSQL databases initialized via programmatic `migrate()` in tests.

## Considered Options

- **Maintain dual `sqlite/` and `pg/` Drizzle schemas in parallel**: Rejected because `drizzle-orm@0.45.2` cannot union `sqliteTable | pgTable` without breaking query builders and type inference, creating ongoing dual-schema and dual-migration drift when a clean one-time PostgreSQL cutover inside `src/infra/db/` suffices.
- **Co-locate Drizzle tables inside `src/modules/<feature>/` and derive HTTP DTOs via `drizzle-zod`**: Rejected because importing `drizzle-orm/sqlite-core` couples Feature Modules to SQLite (violating ADR-0001's `modules → core ← infra` rule), `toZodV4SchemaTyped` loses `.partial()` typing, and `drizzle-zod` outputs `z.date()` rather than wire JSON `z.iso.datetime()` DTOs.
- **Auto-increment integer PKs, Unix-second timestamps, and `drizzle-kit push` against `file:test.db`**: Rejected because `AUTOINCREMENT` diverges from PG `generatedAlwaysAsIdentity()` (which also breaks `drizzle-zod` `.omit({ id: true })`), Unix-second timestamps lose sub-second cursor ordering, and `execSync("pnpm drizzle-kit push")` prevents parallel Vitest files and skips testing real SQL migrations.

## Consequences

- `src/modules/` has zero Drizzle or `drizzle-zod` imports (`src/lib/zod-utils.ts` and `drizzle-zod` are retired); `<feature>.schema.ts` owns pure `@hono/zod-openapi` DTOs (`z.uuid()`, `z.iso.datetime()`), `<feature>.repository.ts` owns domain types (`Date` timestamps) and `Port` interfaces, and `src/infra/db/repositories/` validates row ↔ domain parity via typed `$inferSelect` mappers.
- `src/infra/db/` hosts `client.ts` (lazy `createDb(env)` with `casing: "snake_case"`), `helpers.ts` (`uuidPk()`, `timestamps()` using `mode: "timestamp_ms"`, `sql\`(unixepoch('subsecond') * 1000)\``, and `$onUpdate`), `schema/{auth,tasks,...}.ts`+`index.ts`(singular Better Auth tables with`relations(...)`and`timestamp_ms`), `errors.ts`(normalizing SQLite constraints and PG`23505`/`23503`into Core errors),`pagination.ts`, `migrate.ts`, `seed.ts` (`pnpm db:seed`, blocked in `production`unless`--force`), and `migrations/`(resetting incomplete`0000` into a fresh baseline).
- Repositories always chain `.returning({ id })` instead of reading `rowsAffected`, encapsulate multi-step writes inside repository methods (deferring a generic `TransactionManager` port), and `src/env.ts` only requires `DATABASE_AUTH_TOKEN` in `production` when `DATABASE_URL` uses `libsql://` or `https://`.
