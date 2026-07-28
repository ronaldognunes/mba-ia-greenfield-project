---
kind: phase
name: phase-03-upload-processing
sources_mtime:
  docs/project-plan.md: "2026-06-30T23:18:52-03:00"
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-07-28T10:42:03-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-06-30T23:18:52-03:00"
  docs/phases/phase-02-auth/context.md: "2026-06-30T23:18:52-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-06-30T23:18:52-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-06-30T23:18:52-03:00"
---

# phase-03-upload-processing — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

(none explicitly mentioned in this phase's text — no `nestjs-project`/`nextjs-project` paths or `Subprojetos:` line present in the phase body of `project-plan.md`; subproject ownership is instead declared explicitly in the decisions doc's `_Subprojects in scope:_` section — see `## Decisions Index` sources below)

**Deferred subprojects:** _None._

**Sequencing notes:** Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

_(from decisions-reader — one row per TD across phase-scope + ad-hoc docs)_

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-upload-processing/TD-01 | phase | Repo-wide | Message Queue / Background-Job Infrastructure | decided | Option A (RabbitMQ) | — |
| phase-03-upload-processing/TD-02 | phase | Backend | Object Storage Backend & Client Library | decided | Option A (MinIO + @aws-sdk/client-s3) | — |
| phase-03-upload-processing/TD-03 | phase | Repo-wide | Local Infrastructure Topology for Storage & Queue | decided | Option A | — |
| phase-03-upload-processing/TD-04 | phase | Cross-layer | Large-File Upload Protocol (up to 10GB, resumable) | decided | Option B (S3 Multipart Upload) | — |
| phase-03-upload-processing/TD-05 | phase | Repo-wide | Video Worker Deployment Architecture | decided | Option B (standalone Nest app-context worker) | — |
| phase-03-upload-processing/TD-06 | phase | Backend | FFmpeg Integration Approach | decided | Option B (system FFmpeg + spawn) | — |
|     └─ Last revision: 2026-07-28 — Thumbnail frame-selection rule specified: fixed timestamp `00:00:01` (fallback t… | | | | | | |
| phase-03-upload-processing/TD-07 | phase | Backend | Unique Video URL Identifier | decided | Option A (nanoid) | — |
| phase-03-upload-processing/TD-08 | phase | Cross-layer | Media Delivery — Streaming Playback & Download | decided | Option A (presigned GET direct from storage) | — |
| phase-03-upload-processing/TD-09 | phase | Backend | Video Processing Status Lifecycle | decided | Option A (status enum state machine) | — |

_Source files:_

- phase-03-upload-processing — `docs/decisions/technical-decisions-phase-03-upload-processing.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-upload-processing/TD-02, phase-03-upload-processing/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-upload-processing/TD-01, phase-03-upload-processing/TD-03, phase-03-upload-processing/TD-05 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-upload-processing/TD-04 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-upload-processing/TD-09 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-upload-processing/TD-05, phase-03-upload-processing/TD-06, phase-03-upload-processing/TD-09 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-upload-processing/TD-06 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-upload-processing/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-upload-processing/TD-08 |
| Download do vídeo pelo usuário | phase-03-upload-processing/TD-08 |

## Decisions Detail

_(current-phase TDs only — from decisions-detail-reader)_

### phase-03-upload-processing/TD-01

**Recommendation:** user-directed choice. A dedicated broker cleanly separates the API producer from the standalone worker consumer (TD-05) with durable delivery, manual acknowledgement, and a dead-letter queue for failed video jobs — the right reliability model for a pipeline where a single job may process a 10GB file for minutes. Options B and C are retained for trade-off context; the added broker service is justified by the decoupling and durability requirements. Job progress (which RabbitMQ does not model natively) is tracked via the video status lifecycle in TD-09.
**Libraries:** —

### phase-03-upload-processing/TD-02

**Recommendation:** a single S3-compatible client spans local MinIO and production S3 with only config differences, and the SDK's native presigned-URL and Multipart-Upload support is exactly what TD-04 (resumable upload) and TD-08 (streaming/download) require. MinIO gives a faithful local S3 without cloud credentials.
**Libraries:** —

### phase-03-upload-processing/TD-03

**Recommendation:** add MinIO, RabbitMQ, and the worker to `nestjs-project/compose.yaml`, exposing MinIO on a host-mapped port so presigned URLs are browser-reachable. It is the smallest change that makes the pipeline runnable end-to-end, and it keeps the storage host reachability problem explicit. A later infra task can promote to a unified stack if/when the frontend stack needs to share the network at runtime.
**Libraries:** —

### phase-03-upload-processing/TD-04

**Recommendation:** it is native to the chosen storage/SDK (TD-02), satisfies both hard requirements (>5GB objects and resume-on-failure), and keeps every byte off the API process. `tus` is the fallback if a storage-agnostic, protocol-level resume is later preferred over S3-native multipart. Contract published via OpenAPI: `initiate` (returns `uploadId` + part URLs), `complete`, `abort`.
**Libraries:** —

### phase-03-upload-processing/TD-05

**Recommendation:** it realizes the diagram's separate worker container and isolates FFmpeg load from the API, while avoiding a full monorepo-apps restructure. The worker is a NestJS RMQ consumer subscribed to the video-processing queue, reusing the API's entities/config/storage code through normal imports.
**Libraries:** —

### phase-03-upload-processing/TD-06

**Recommendation:** it removes reliance on a maintenance-risk wrapper, gives full control of the FFmpeg version/codecs through the worker image, and the required operations (ffprobe metadata + single-frame thumbnail) are a thin, testable spawn layer. Since there is no transcoding, the wrapper ergonomics of `fluent-ffmpeg` add little value.
**Libraries:** —

**Revisions:**
- 2026-07-28 — Thumbnail frame-selection rule specified: fixed timestamp `00:00:01` (fallback to `duration/2` for videos shorter than 2s). Rationale: simple, deterministic single-frame extraction; avoids re-litigating the extraction point per video (resolves AMB-1).

### phase-03-upload-processing/TD-07

**Recommendation:** short, opaque, URL-safe identifiers with a unique column and retry-on-collision deliver "URL curta e única" without exposing or enabling enumeration of internal ids. UUID fails the "short" requirement; hashids leaks order.
**Libraries:** —

### phase-03-upload-processing/TD-08

**Recommendation:** it keeps media bytes off the API, uses storage-native Range for progressive streaming (no transcoding needed), and serves download via the same mechanism with `content-disposition=attachment`. Matches the C4 diagram; a CDN can later sit in front without changing the contract.
**Libraries:** —

### phase-03-upload-processing/TD-09

**Recommendation:** it is the simplest correct contract: one enum field the API sets on draft creation and the worker advances, which the FE polls for readiness. It cleanly represents `failed` and the in-flight states, and supports later draft/publish filtering. A dedicated jobs table is unnecessary given RabbitMQ already owns retry/DLQ reliability.
**Libraries:** —

## Inherited Decisions Detail

_(inherited TDs from prior phases — from phases-reader, dedupe applied; no correlator-confirmed ad-hoc docs — see note below)_

### phase-01-configuracao-base/TD-01

**Recommendation:** Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** first-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** namespaced/grouped config with `registerAs`. The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** shared `registerAs` factory — natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id. For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** `@nestjs/passport`. The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** refresh token rotation. Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform. PostgreSQL is already in the stack, so no new infrastructure needed.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** random opaque tokens in DB. Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and can also serve future needs (e.g., API keys).
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** `@nestjs-modules/mailer`. Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** `class-validator` + `class-transformer`. This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** custom domain exception filter. Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. Single-consumer project, so a simple `{ statusCode, error, message }` format balances clarity and simplicity.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** `@nestjs/throttler`. Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. Single-instance, no distributed requirements.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** opaque tokens. Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** strict `[a-z0-9_]` allowlist for channel handles — simplest and most portable choice, no extra dependencies, no edge cases around hyphen positioning; `user_<random>` fallback provides a valid handle even for extreme email prefixes.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** custom cookie session over Auth.js. The strict-BFF model already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match. A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly; built-in `next/headers` `cookies()` is the canonical primitive both Next.js 16 and React 19 already use.
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** `iron-session`. Defense in depth on the cookie content — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection. Single cookie to manage simplifies logout. Room to carry minimal user metadata (`userId`, `email`, `channelSlug`) lets RSC render authenticated chrome without a per-render round-trip.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** single-flight refresh, tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion — implemented server-side in the session helper.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** react-hook-form + Zod. Decoupled from the Route-Handler-vs-Server-Action choice; aligned with shadcn's canonical form primitive (`npx shadcn@latest add form`); Zod-first ergonomics match the FE config foundation (Zod 4 already chosen for env validation).
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Route Handlers as the sole mutation surface (`app/api/**`) — strict-BFF alignment, reuses the existing MSW+BFF integration test scaffold, keeps a single mutation-surface precedent for Phases 03–07.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** RSC delivers the initial session in the same response as the page HTML; a Client Provider hydrates with the correct initial state — no first-render flicker, no round-trip, no new BFF endpoint. `router.refresh()` after mid-session mutations is a small, explicit cost.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** RSC-owns-the-token pattern for confirmation and reset flows — first-paint-correct, single integration pattern reused across both flows (RSC owns the token, Client Component owns the input).
**Libraries:** —

_(No correlated ad-hoc docs were confirmed for inclusion here — the correlator found only medium/low-relevance candidates among `next-frontend-openapi-typing`, `openapi-docs-nestjs`, `next-frontend-config-base`, `next-frontend-msw-foundation`; none scored `high`, and the user did not confirm any for inclusion when asked, so the default — empty set — applies. Rerun `/plan-context phase-03-upload-processing` and answer the correlation prompt to pull any of these in later.)_

## Inherited Conventions

_(from phases-reader — compact list; sourced from prior phases)_

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 2)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, ... })`. _(from phase 2)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function. _(from phase 2)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 2)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 2)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning the connection options. _(from phase 2)_

## Inherited Deferred Capabilities

_(from phases-reader — informational-only; plan-validate does NOT fire issues based on unaddressed entries)_

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | Logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | The umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_(empty on first assembly — plan-resolve appends rows as user marks capabilities)_

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| _None._ | | | |

## Testing Requirements

_(from testing-guide-nestjs-project skill)_

### nestjs-project

| Artifact created | Required tests |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (queue producer/consumer) | Unit: real lib with test config |
| Service with side-effect dep (storage, FFmpeg spawn) | Integration: real capture/local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard | E2E + Unit if complex internal logic |

### next-frontend

_No FE artifacts are created in this phase — upload widget and video player UI are deferred to Phases 04/05 (see `## Scope` and the decisions doc's `_Subprojects in scope:_` note). Testing requirements will be pulled from `testing-guide-next-frontend` when that FE work starts._
