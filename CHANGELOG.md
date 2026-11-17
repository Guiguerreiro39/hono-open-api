# Changelog

## [1.1.0](https://github.com/Guiguerreiro39/hono-open-api/compare/v1.0.0...v1.1.0) (2026-11-17)


### Features

* **auth:** wire better auth, rbac, /api/v1/me, scalar docs, and db seed ([29ffef6](https://github.com/Guiguerreiro39/hono-open-api/commit/29ffef6df8261970c6739e824ca4a43118c1adff))
* **core:** cut over to Core/Infra/Feature Module foundation ([44d04da](https://github.com/Guiguerreiro39/hono-open-api/commit/44d04daed9f60e5c5a1772dbaa5b96ea8893b5d9))
* **files:** add files module, schema, magic-byte validation, and cleanup jobs ([bafa764](https://github.com/Guiguerreiro39/hono-open-api/commit/bafa764104b3c35e27c9d4b85b98f2fa32621eef))
* **infra:** add multi-stage Dockerfile, full Compose stack, and CI workflow ([ef969f9](https://github.com/Guiguerreiro39/hono-open-api/commit/ef969f9299b3cd42987eaf75de46603e9acc7239))
* initial commit ([8132e51](https://github.com/Guiguerreiro39/hono-open-api/commit/8132e51a4b97ce36acfc2e50fb4cf63cfcddd5a8))
* **lifecycle:** add shared process lifecycle and sequential graceful shutdown drain ([dc7ad91](https://github.com/Guiguerreiro39/hono-open-api/commit/dc7ad914b798c12ddbc820314124420cc33def5f))
* **observability:** add MetricsPort, /metrics endpoint, and W3C traceparent propagation ([6850983](https://github.com/Guiguerreiro39/hono-open-api/commit/68509833c30a65ebf16617d6584041b000c3692a))
* productionize hono-open-api-starter architecture ([230e1af](https://github.com/Guiguerreiro39/hono-open-api/commit/230e1af323e35baa048f32cba41c2b709d4e0aad))
* **queue:** add QueuePort, BullMQ/memory adapters, worker runtime, and initial module jobs ([da368c8](https://github.com/Guiguerreiro39/hono-open-api/commit/da368c8ec90d4abf6e3f1bc5b832ec2791708f7c))
* **realtime:** add PubSubPort, SSE helpers, and GET /api/v1/tasks/live ([d90dead](https://github.com/Guiguerreiro39/hono-open-api/commit/d90dead1835251a44d05eb291de5a0104e28e8f7))
* **redis:** add CachePort, RateLimiterPort, /ready Redis probe, and contract suites ([39cdd28](https://github.com/Guiguerreiro39/hono-open-api/commit/39cdd28d928914c801e4eabb7e0b10fe4c0feb59))
* **storage:** add StoragePort, Memory/Local/S3 adapters, and /_storage/* route ([f8f3a33](https://github.com/Guiguerreiro39/hono-open-api/commit/f8f3a33824a26bf35e4a6c58504c0c7dc2caca61))
* **tasks:** add tasks module, drizzle repository, rbac scoping, and contract suite ([3397683](https://github.com/Guiguerreiro39/hono-open-api/commit/33976831ad45231192114e115949e1b683f43017))


### Bug Fixes

* handle unicode filenames, out-of-range cursors, and SSE shutdown keep-alive ([90fda31](https://github.com/Guiguerreiro39/hono-open-api/commit/90fda3140ea33f38d9fe0f4b393c5738385a0838))


### Documentation

* add architecture, development guides, minimal .env.example, and concise AGENTS.md ([32ffd84](https://github.com/Guiguerreiro39/hono-open-api/commit/32ffd84f3a1d1b4cd16ba7543bfa7dd0312ba5a6))
* add domain glossary, ADRs 0001-0012, and agent docs ([5456af0](https://github.com/Guiguerreiro39/hono-open-api/commit/5456af03199198ff185094e10007b4c5876b67c2))


### CI/CD & Governance

* cut Releases with Release-Please and GHCR ([1fe1db3](https://github.com/Guiguerreiro39/hono-open-api/commit/1fe1db3737b71978118efd63a134b5479640ddd6))
* cut Releases with Release-Please and GHCR ([4643cbd](https://github.com/Guiguerreiro39/hono-open-api/commit/4643cbd3b07eb6faaaaa1b24cf3fe81ca9aea5eb))
