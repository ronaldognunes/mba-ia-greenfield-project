# phase-03-upload-processing — Progress

**Status:** in_progress
**SIs:** 6/10 completed

### SI-03.1 — Instalar dependências, criar namespaces de configuração e atualizar o Compose
- **Status:** completed
- **Tests:** 11 passing
- **Observations:**
  - Pinned `nanoid` to `^3` instead of latest (v5+ is pure ESM-only; this project compiles to CommonJS with no `"type": "module"`, so a bare `nanoid` install would break at runtime with `ERR_REQUIRE_ESM`). SI-03.7, which will actually use `nanoid`, should keep this pin.
  - RabbitMQ's built-in `guest` account only authenticates via loopback, which would reject connections from other containers on the Docker network. Used `RABBITMQ_DEFAULT_USER`/`RABBITMQ_DEFAULT_PASS=streamtube` (mirroring the existing `POSTGRES_USER`/`POSTGRES_PASSWORD` convention) instead of the default guest/guest.
  - `compose.yaml`'s new `worker` service points at `Dockerfile.worker`, which does not exist yet — it's SI-03.8's deliverable. `docker compose config` validates fine regardless (it doesn't check build-context files), satisfying this SI's AC without overstepping scope.
  - The `context7` MCP tool specified in the root CLAUDE.md for library documentation lookup is not available in this environment. Used WebSearch instead to verify current MinIO/RabbitMQ Docker Compose healthcheck conventions (`mc ready local`, `rabbitmq-diagnostics -q ping`); everything else in this SI mirrors already-established local patterns (`registerAs` config factories, Joi schema), which CLAUDE.md exempts from lookup.
  - First `npm install` was mistakenly run on the host instead of inside the container, violating `nestjs-project/CLAUDE.md`'s container-only rule (this also polluted `package-lock.json` with Windows-specific optional entries). Caught it before it landed: reverted `package-lock.json`, deleted the host `node_modules`, and redid the install via `docker compose exec nestjs-api npm install`.
  - Per explicit user instruction, this phase is being implemented directly on `main` rather than a feature branch (deviates from the Git Flow convention in the root CLAUDE.md).

### SI-03.2 — Entidade Video e migração
- **Status:** completed
- **Tests:** 4 passing
- **Observations:**
  - No `.env` file existed in `nestjs-project/` (only `.env.example`), so any command touching a real DB (`migration:generate`, integration tests reading `database.config.ts`'s default) would fail with `ECONNREFUSED 127.0.0.1:5432` inside the container. Created `.env` from `.env.example` — required infra setup, not a scope addition.
  - `.env.example`'s `MAIL_FROM="StreamTube" <noreply@streamtube.com>` is invalid dotenv syntax (unquoted `<`/`>` outside the quoted segment) — confirmed by `nestjs-project/CLAUDE.md`'s own "Environment File Conventions" section, which documents this exact pattern as wrong. It only surfaced now because no `.env` had ever been parsed before. Fixed to `MAIL_FROM="StreamTube <noreply@streamtube.com>"` in both `.env` and `.env.example`, matching the CLAUDE.md's own "Right" example.
  - The database had never had migrations run against it (fresh volume). First `migration:generate` attempt diffed against an empty schema and produced a migration that re-created `users`/`channels`/`verification_tokens`/`refresh_tokens` alongside `videos` — discarded that file, ran `migration:run` to apply the two pre-existing migrations first, then regenerated cleanly (only the `videos` table + FK + indexes).
  - `status` modeled as a native Postgres enum (`videos_status_enum`: `draft | uploading | processing | ready | failed`) per `TD-09`'s state-machine decision, default `draft`.
  - `storage_key`, `thumbnail_key`, `duration_seconds`, `metadata`, `upload_id`, and `title` made nullable — none of them are known at draft-creation time per the SI-03.5/03.6 flow (only `original_filename`/`content_type`/`file_size_bytes` are supplied by `CreateVideoDto`, and `upload_id` is only known after the async `createMultipartUpload` call). `file_size_bytes` uses `bigint` (TS type `string`, TypeORM's default bigint mapping) since it can exceed the 32-bit `int` range for 10GB files.
  - Extended the shared `cleanAllTables()` test helper (`src/test/create-test-data-source.ts`) to also truncate `videos` (before `channels`, respecting the FK), following the same pattern used for every previously-added entity table — otherwise every other integration suite using this helper would eventually break once video rows exist.

### SI-03.3 — Storage Module (MinIO / S3 client wrapper)
- **Status:** completed
- **Tests:** 3 passing
- **Observations:**
  - `minio` service (defined in `compose.yaml` since SI-03.1) had never actually been started — brought it up with `docker compose up -d minio` and waited for its healthcheck, since this SI's own Dependencies field calls out the running `minio` service as a hard requirement.
  - The MinIO bucket (`streamtube-videos`) doesn't pre-exist; `StorageService` itself has no bucket-provisioning responsibility per the Technical actions, so added a small `ensureBucketExists()` test helper (`src/test/minio.ts`, mirroring the existing `src/test/mailpit.ts` pattern) that the integration spec calls in `beforeAll` — same "test infra provisions its own dependencies" pattern already used for the Postgres test DB.
  - Verified via WebSearch (context7 unavailable, same gap noted in SI-03.1) that S3's part-upload `ETag` response header must be forwarded to `CompleteMultipartUploadCommand` byte-for-byte, quotes included — stripping the quotes is a common bug that produces `InvalidPart`. The service passes the header value through unchanged.
  - `getPresignedPartUrls`/`getPresignedGetUrl` default to a 1-hour presigned URL expiry (`STORAGE_DEFAULTS.PRESIGNED_URL_EXPIRES_IN_SECONDS` in `storage.constants.ts`) — not specified by any TD; chosen as a reasonable default consistent with TD-04's resumability model (expired part URLs are simply re-requested).

### SI-03.4 — Queue Module (produtor RabbitMQ)
- **Status:** completed
- **Tests:** 3 passing
- **Observations:**
  - `TD-01`'s recommendation names `amqp-connection-manager`/`amqplib` directly (not `@nestjs/microservices`' RMQ transport), matching what was already pinned in SI-03.1 (`amqp-connection-manager@^5.0.0`, `amqplib@^2.0.1`). Verified the current v5/v2 API via WebSearch + reading the installed packages' own `.d.ts`/compiled JS directly (context7 still unavailable, same gap noted since SI-03.1) — v5 introduced no breaking API changes over v4 besides a Node ≥20 floor.
  - The SI's technical action literally names the queue `video.processing.requested`, but `queue.config.ts` (from SI-03.1) already defines `videoProcessingQueue` with a different default (`video-processing`). Treated the config value as the source of truth (the action's prose is naming the semantic event from the Events/Messages spec, not mandating a literal override) — the AC itself says "publica...na fila configurada", i.e. config-driven. Not touching SI-03.1's config default is a scope decision, not an oversight.
  - Dead-letter topology (`<queue>.dlx` direct exchange + `<queue>.dlq` queue, bound and wired via `deadLetterExchange`/`deadLetterRoutingKey` on the main queue's `assertQueue`) isn't specified by name anywhere in the plan/TDs — chose a `.dlx`/`.dlq` suffix convention (`queue.constants.ts`) since no naming convention existed to follow.
  - `QueueService.onModuleInit` explicitly awaits `channelWrapper.waitForConnect()` (not just fire-and-forget `amqp.connect`) so the durable-queue+DLQ topology is guaranteed asserted before the module is considered initialized — matters because `publishVideoProcessingRequested` will be called from SI-03.6's upload-complete flow and topology errors should surface at boot, not silently on first publish.
  - AC2 ("ao reiniciar a conexão, mensagens não confirmadas permanecem na fila") and AC3 ("mensagem rejeitada é roteada à DLQ") aren't covered by the SI's single named test file by 1:1 mapping, but both are exercised as additional `it()` blocks in that same file, per the skill's "every AC should be observable from at least one test" rule — no new file needed since both are real assertions on the same `QueueService` instance.
  - First test design reused one long-lived AMQP channel across all 3 tests (consume + cancel per assertion) and consistently hung at Jest's 5000ms timeout on the 2nd/3rd test — root-caused via WebSearch + reading `amqp-connection-manager`'s compiled source that repeated `consume()`/`cancel()` cycles on the same `ChannelWrapper` don't reliably re-arm; fixed by giving each assertion its own short-lived connection+channel (`receiveOne` helper), closed immediately after use — no flakiness since.

### SI-03.5 — Endpoint POST /videos (criação de rascunho + início do upload)
- **Status:** completed
- **Tests:** 6 passing (3 unit + 3 e2e)
- **Observations:**
  - `**Test Specs:**` on SI-03.5/03.6/03.7 was `_pending /plan-test-specs_` (the plan is `test_specs_aware: true`) — per the `/implement` skill's hard-abort rule, ran `/plan-test-specs phase-03-upload-processing` before starting this SI, which generated `nestjs-project/specs/videos-{create,upload,detail}.plan.md` and populated the plan's placeholders. This produced the first E2E test file the project has needed to author from a spec (`test/videos-create.e2e-spec.ts`); `test/auth.e2e-spec.ts`, `test/app.e2e-spec.ts` and `test/swagger.e2e-spec.ts` already existed from phase-02, so the E2E bootstrap/auth-helper pattern was mirrored from `test/auth.e2e-spec.ts` rather than invented.
  - VideosModule needed to resolve the authenticated caller's `channel_id` (Video's owning entity), which `ChannelsService` didn't expose yet (only `createChannel`). Added `ChannelsService.findByUserId()` — a minimal, single-purpose lookup — rather than querying the `Channel` repository directly from `VideosService`, keeping channel data access inside its own module per Single Responsibility.
  - Technical action #4 said "Registrar VideosModule (importando StorageModule) em AppModule", naming only `StorageModule`; `VideosModule` also imports `ChannelsModule` (for the lookup above) since it's a direct, minimal dependency of action #2, not a scope expansion.
  - AC2 ("file_size_bytes acima de 10GB retorna 413 FILE_TOO_LARGE") is deliberately NOT enforced via a `class-validator` `@Max()` on `CreateVideoDto` — that would produce a generic 400 through the global `ValidationPipe`, not the required 413/FILE_TOO_LARGE. Enforced instead as a business rule in `VideosService`, throwing a new `FileTooLargeException extends DomainException` (413), mapped by the already-registered global `DomainExceptionFilter` — same mechanism `phase-02-auth` established, no new filter needed.
  - `public_id` retry-on-collision (TD-07) mirrors `ChannelsService.createChannel`'s existing unique-violation-retry pattern (`QueryFailedError` + Postgres code `23505`, `MAX_RETRIES` loop with a terminal throw) rather than introducing a different pattern — kept local/private to `VideosService` since the existing precedent also keeps its detection helper private to its own service, not shared.
  - S3 part size (TD-04 only suggests "8–64MB parts", no exact number) and the multipart storage key format (`videos/{public_id}/original`) aren't specified by any TD — picked 16MB parts and a plain, extension-less key as reasonable defaults, documented in `videos.constants.ts`.
  - Discovered the project's `npm run lint` has pre-existing failures (mostly `@typescript-eslint/no-unsafe-*` and `unbound-method`) across phase-02 files this SI never touched (`auth.e2e-spec.ts`, `auth.service.spec.ts`, `auth.service.integration-spec.ts`, `users.service.integration-spec.ts`, `channels.service.ts`'s own pre-existing collision-retry helper, etc.) — confirmed by running the full-project lint and diffing which files were pre-existing vs. new. Out of scope to fix here. All newly-written production/unit-test code in this SI (`videos.service.ts`, `videos.service.spec.ts`, plus the small edits to `channels.service.ts`/`domain.exception.ts`/`app.module.ts`) lints clean; `test/videos-create.e2e-spec.ts` still carries the same `no-unsafe-*` errors because it faithfully mirrors `test/auth.e2e-spec.ts`'s already-accepted supertest/`res.body` pattern rather than inventing a new one.

### SI-03.6 — Endpoints de conclusão e aborto do upload
- **Status:** completed
- **Tests:** 8 passing (3 unit + 1 integration + 4 e2e)
- **Observations:**
  - `CompleteUploadDto.parts` is declared `@IsOptional()` rather than required — an empty/missing `parts` array must produce the domain `errorCode: "INVALID_UPLOAD_PARTS"` (400) per AC3, not the generic `VALIDATION_ERROR` the global `ValidationPipe` would emit for a failed `@ArrayNotEmpty()`. Same pattern as SI-03.5's `FILE_TOO_LARGE`: the ceiling/presence check is a business rule enforced in `VideosService`, not a `class-validator` constraint.
  - `completeUpload`/`abortUpload` share a private `findDraftUploadOrThrow()` that checks existence (404 `VIDEO_NOT_FOUND`) then `status === 'draft'` (409 `UPLOAD_ALREADY_COMPLETED`) *before* touching storage — this ordering is deliberate: calling S3's `CompleteMultipartUpload`/`AbortMultipartUpload` a second time on an already-finalized session would itself throw a storage-side error, so the business-state check must short-circuit first (same fail-fast principle as SI-03.5's file-size check).
  - `dto.upload_id !== video.upload_id` is also routed through `InvalidUploadPartsException` (no separate errorCode exists in the Error Catalog for an upload-id mismatch, and it fits the catalog's "inconsistent with the storage-side multipart session" wording for `INVALID_UPLOAD_PARTS`).
  - Any error thrown by `StorageService.completeMultipartUpload` itself (e.g., MinIO rejecting mismatched/incomplete parts) is caught and converted to `InvalidUploadPartsException` rather than propagating as a 500 — this is the other half of AC3's "inconsistent" case, exercised structurally by the missing-parts scenario in this SI's tests since a genuine MinIO-level `InvalidPart` rejection isn't practical to construct deterministically in a test.
  - Per the Authorization Matrix, both endpoints are owner-only, but ownership enforcement is explicitly deferred to SI-03.10 ("Guard de posse") per the Dependency Map — these endpoints are currently only JWT-protected (any authenticated user can act on any `publicId`), which is an intentional, temporary gap closed by SI-03.10, not an oversight. No AC in this SI requires a 401/403 test, confirming the scope split.
  - `VideosService` now also depends on `QueueService` (for `publishVideoProcessingRequested`), so `VideosModule` gained a `QueueModule` import and the pre-existing `videos.service.spec.ts` unit test needed a `QueueService` mock added to its testing module — required to keep the already-passing SI-03.5 unit tests green, not new scope.
  - The Integration test (`videos.service.integration-spec.ts`) exercises the full real chain end-to-end (real MinIO multipart create + presigned PUT + real ETag, real Postgres, real RabbitMQ consume via a short-lived channel mirroring `queue.service.integration-spec.ts`'s `receiveOne` helper) rather than mocking any collaborator, since the SI's Tests entry explicitly asks to prove the message "publica de fato na fila real (RabbitMQ)".
  - The E2E "already completed" and "success" scenarios both drive a real MinIO multipart session through `POST /videos` + a real presigned-URL `PUT`, since a fake/never-created `upload_id` would make `StorageService.completeMultipartUpload` fail against real MinIO instead of exercising the intended business-rule path.

### SI-03.7 — Endpoint GET /videos/:publicId
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.8 — Bootstrap do Video Worker
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.9 — Lógica de processamento do vídeo no worker
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.10 — Guard de posse (ownership) dos endpoints de vídeo
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
