# phase-03-upload-processing — Progress

**Status:** in_progress
**SIs:** 3/10 completed

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
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.5 — Endpoint POST /videos (criação de rascunho + início do upload)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.6 — Endpoints de conclusão e aborto do upload
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

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
