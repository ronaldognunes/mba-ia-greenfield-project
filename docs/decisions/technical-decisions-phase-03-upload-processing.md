---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-27
scope_description: "Video pipeline foundation for Phase 03: object storage, message queue (RabbitMQ), a separate FFmpeg worker, 10GB resumable uploads, unique video URLs, progressive streaming, download, and the video draft/processing status lifecycle. Backend + infra + cross-layer contracts; frontend upload/player UI is deferred to Phases 04/05."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — primary subproject. Owns the object-storage integration, the RabbitMQ producer, the standalone FFmpeg worker deployable, the `Video` entity with draft pre-registration, the presign endpoints (upload / stream / download), the unique video-URL generation, the processing-status lifecycle, and FFmpeg-based metadata + thumbnail extraction.
- `next-frontend/` — **no open pure-frontend decision in this document.** The frontend consumes the two cross-layer contracts decided here (TD-04 upload protocol, TD-08 media delivery). The upload widget and the video player UI are deferred to Phases 04/05 (mirrors the Phase 02 backend/frontend slicing), when the FE screens for video management and playback are built.

> Cross-doc anchors (already decided — do NOT reopen):
> - **Configuration system:** `phase-01-configuracao-base/TD-01..TD-04` — `@nestjs/config` with namespaced `registerAs` factories + Joi env validation. New storage/queue config joins as `storage.config.ts` / `queue.config.ts` following the same pattern.
> - **Error contract:** `phase-02-auth/TD-07` — custom domain exception filter returning `{ statusCode, error, message }` with machine-readable `error` codes. Upload/processing errors reuse this envelope.
> - **Request validation:** `phase-02-auth/TD-06` — `class-validator` + `class-transformer` on DTOs via the global `ValidationPipe`.
> - **Auth:** `phase-02-auth/TD-02` — custom `@nestjs/jwt` guards, `Authorization: Bearer <accessToken>`. All upload/mutation endpoints in this phase require authentication; video watch/stream is anonymous.
> - **Strict BFF + storage carve-out:** `next-frontend-config-base/TD-03` — the browser talks only to same-origin Next.js Route Handlers, never to the NestJS API directly. **Carve-out:** direct browser ↔ object-storage traffic (presigned upload in TD-04, presigned stream/download in TD-08) IS permitted — the C4 diagram (`docs/diagrams/software-arch.mermaid`) shows `frontend → storage: Streams`. The BFF rule constrains the NestJS API surface, not object storage.
> - **OpenAPI contract chain:** `next-frontend-openapi-typing/TD-01..TD-05` — all FE-consumed wire shapes derive from `openapi.json`. New video request/response DTOs (draft creation, presign responses, status) are published through the spec.
> - **Separate Docker Compose stacks:** `nestjs-project/` and `next-frontend/` currently run on separate compose stacks with no shared network. This is the load-bearing constraint behind TD-03 (infra topology) and behind presigned-URL host reachability from the browser.
> - **No Redis in the stack:** auth deliberately reused PostgreSQL (`phase-02-auth/TD-03`) instead of adding Redis. Relevant context for TD-01.

---

## TD-01: Message Queue / Background-Job Infrastructure

**Scope:** Repo-wide

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The C4 diagram marks the Message Queue as **TBD**. Video processing (metadata extraction + thumbnail generation) is heavy and must run in the background without blocking the upload request (Pontos de Atenção: "a extração de informações do vídeo é pesada e deve acontecer em segundo plano"). The API must publish a job when an upload completes; a separate worker (TD-05) consumes it. The choice determines the broker infrastructure added to Docker Compose and the producer/consumer libraries.

**Options:**

### Option A: RabbitMQ (AMQP broker)
- Dedicated message broker. NestJS integrates via `@nestjs/microservices` RMQ transport, or directly via `amqplib` / `amqp-connection-manager`. The API publishes to a durable queue; the worker consumes with manual acknowledgement. Failed jobs route to a dead-letter queue (DLQ).
- **Pros:** Purpose-built broker fully decoupling API producer from worker consumer. Durable queues survive restarts; manual acks guarantee a video job is not lost if the worker crashes mid-processing. Native DLQ + retry/backoff for failed FFmpeg jobs. Language-agnostic (a future non-Node worker could consume the same queue). First-class NestJS microservice transport.
- **Cons:** Adds a new infrastructure service (broker) to Compose and to operational surface. No built-in job-progress API (progress must be modeled in the DB status — TD-09). Slightly more setup than a Node-native library (exchanges, queues, bindings).

### Option B: BullMQ + Redis
- Redis-backed job queue via `@nestjs/bullmq`. Rich job lifecycle: progress events, concurrency control, sandboxed processors, rate limiting, delayed/repeatable jobs.
- **Pros:** Best-in-class job ergonomics for media pipelines — per-job progress, concurrency, automatic retries with backoff, sandboxed processors that isolate FFmpeg crashes. Tight NestJS integration.
- **Cons:** Requires adding **Redis** (a service the project has so far deliberately avoided). Job payloads/state live in Redis, not durable by default without persistence tuning. Node-centric (harder to consume from a non-Node worker).

### Option C: pg-boss (PostgreSQL-backed queue)
- Job queue built on the existing PostgreSQL instance. No new infrastructure service.
- **Pros:** **Zero new infra** — reuses the Postgres already in the stack, consistent with the auth phase's Redis-avoidance. Transactional job enqueue alongside the video row. Simple operational model.
- **Cons:** Not a true broker — polling-based, higher DB load under volume. No cross-language consumer story. Weaker throughput ceiling than RabbitMQ/Redis for a high-volume media pipeline. Couples queue load to the primary database.

**Recommendation:** **Option A (RabbitMQ)** — user-directed choice. A dedicated broker cleanly separates the API producer from the standalone worker consumer (TD-05) with durable delivery, manual acknowledgement, and a dead-letter queue for failed video jobs — the right reliability model for a pipeline where a single job may process a 10GB file for minutes. Options B and C are retained for trade-off context; the added broker service is justified by the decoupling and durability requirements. Job *progress* (which RabbitMQ does not model natively) is tracked via the video status lifecycle in TD-09.

**Decision:** Option A (RabbitMQ)

---

## TD-02: Object Storage Backend & Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The C4 diagram specifies "S3 or MinIO" for Object Storage. Videos (up to 10GB) and generated thumbnails must be stored outside the database and outside the API process. The API uploads/reads via presigned URLs (TD-04, TD-08); the worker reads the source and writes the thumbnail. The decision covers both the local/dev backing store and the client library used by the API and worker.

**Options:**

### Option A: MinIO (dev) + `@aws-sdk/client-s3`
- Run MinIO as a local S3-compatible service in Docker Compose. Access it from both the API and the worker via the official AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`), pointed at the MinIO endpoint via config.
- **Pros:** One client works dev → prod — swap the endpoint/credentials to target real AWS S3 in production, no code change. First-class presigned URLs (`getSignedUrl`) and native S3 Multipart Upload (underpins TD-04 and TD-08). Modular v3 SDK (tree-shakeable). MinIO is a faithful S3 emulator for local dev.
- **Cons:** AWS SDK surface is larger/more verbose than the MinIO SDK for simple operations. Presigned-URL host must be reachable by the browser (TD-03 topology concern).

### Option B: MinIO + `minio` npm SDK
- Use the MinIO-specific JavaScript client against MinIO in dev.
- **Pros:** Simpler, MinIO-tuned API. Lighter for basic put/get.
- **Cons:** MinIO-flavored client; migrating to AWS S3 in prod means re-checking/porting client calls. Presign + multipart ergonomics differ from the S3 standard the team will likely target in production.

### Option C: Cloud S3 directly / LocalStack
- Target real AWS S3 (or LocalStack emulation) from the start.
- **Pros:** No abstraction gap with production. LocalStack emulates more AWS services.
- **Cons:** Real S3 adds cloud credentials/cost to local dev; LocalStack is heavier and less faithful for S3 multipart/streaming than MinIO. Overkill when MinIO + the same SDK already gives S3 parity.

**Recommendation:** **Option A (MinIO + `@aws-sdk/client-s3`)** — a single S3-compatible client spans local MinIO and production S3 with only config differences, and the SDK's native presigned-URL and Multipart-Upload support is exactly what TD-04 (resumable upload) and TD-08 (streaming/download) require. MinIO gives a faithful local S3 without cloud credentials.

**Decision:** Option A (MinIO + `@aws-sdk/client-s3`)

---

## TD-03: Local Infrastructure Topology for Storage & Queue

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)"

**Context:** TD-01 (RabbitMQ) and TD-02 (MinIO) each add an infrastructure service. Today the two subprojects run on **separate Compose stacks with no shared network**. The new services must be reachable by: the API (publish jobs, presign), the worker (consume jobs, read/write objects), and — critically — the **browser**, which must hit MinIO directly on a presigned URL for upload (TD-04) and streaming/download (TD-08). A presigned URL signed for an internal Compose hostname (e.g. `minio:9000`) is not resolvable from the browser. The topology must expose storage on a host-stable address (e.g. `localhost:9000`).

**Options:**

### Option A: Add storage + queue services to `nestjs-project/compose.yaml`
- MinIO, RabbitMQ, and the worker join the existing backend Compose file alongside `db`, `mailpit`, `nestjs-api`.
- **Pros:** Minimal change — one existing file. API, worker, db, storage, queue share one network by default. Presigned URLs published on a host-mapped port (`localhost:9000`) reach the browser.
- **Cons:** The backend Compose file grows; the frontend stack stays separate, so any FE↔storage assumptions are documented, not networked.

### Option B: New root-level unified `compose.yaml` (or `include`)
- A root Compose composes both subprojects plus db/storage/queue/worker into one stack, or uses Compose `include` to merge the per-subproject files.
- **Pros:** Single `docker compose up` for the whole platform; one shared network for API, worker, storage, queue, and frontend. Cleanest end-to-end local topology.
- **Cons:** Larger refactor of the current two-stack setup (out of the immediate phase focus); revisits `next-frontend-config-base/TD-03`'s separate-stack assumption. More moving parts to change at once.

### Option C: Dedicated infra Compose + shared external network
- A separate `infra` Compose owns db/storage/queue; both app stacks attach via a shared external Docker network.
- **Pros:** Infra decoupled from app lifecycles; both stacks reach shared services by name.
- **Cons:** Most operational ceremony (external network creation, ordering). Overkill for a single-developer local environment.

**Recommendation:** **Option A** for this phase — add MinIO, RabbitMQ, and the worker to `nestjs-project/compose.yaml`, exposing MinIO on a host-mapped port so presigned URLs are browser-reachable. It is the smallest change that makes the pipeline runnable end-to-end, and it keeps the storage host reachability problem explicit. A later infra task can promote to Option B (unified stack) if/when the frontend stack needs to share the network at runtime.

**Decision:** Option A

---

## TD-04: Large-File Upload Protocol (up to 10GB, resumable)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** This is the defining decision of the phase. A 10GB upload must not flow through the NestJS API process ("sem impacto na performance") and must be **resumable** after a connection failure (Pontos de Atenção: "permita retomar em caso de falha de conexão"). Because the browser talks to storage directly for uploads (the strict-BFF storage carve-out), this is a single cross-layer contract: the backend issues credentials/URLs; the frontend (Phase 04) orchestrates the byte transfer directly to MinIO/S3.

**Options:**

### Option A: Single presigned PUT (direct to storage)
- The API returns one presigned `PUT` URL; the client uploads the whole file directly to storage in one request.
- **Pros:** Simplest possible flow. Bytes bypass the API entirely.
- **Cons:** **Not resumable** — a dropped connection at 9GB restarts from zero. S3 single-PUT has a 5GB object-size ceiling, so 10GB is not even possible without multipart. Fails the resumability requirement.

### Option B: S3 Multipart Upload with presigned part URLs
- The API initiates a multipart upload and returns presigned URLs per part (e.g. 8–64MB parts). The client uploads parts directly to storage, in parallel, retrying only failed parts; the API then completes the upload assembling the parts. Resume = re-request URLs for missing parts.
- **Pros:** Natively supports objects far beyond 10GB. **Resumable** — only failed/missing parts are re-uploaded. Parallel parts improve throughput. Bytes never touch the API. Native to `@aws-sdk/client-s3` (TD-02) and MinIO.
- **Cons:** Multi-step handshake (initiate → part URLs → complete/abort) the frontend must orchestrate. API tracks the `uploadId` and must expose an abort path for cancelled/expired uploads. Slightly more contract surface.

### Option C: tus resumable protocol
- Implement the tus open protocol (`@tus/server` on the backend, `tus-js-client` on the frontend) with a MinIO/S3 store backend.
- **Pros:** Purpose-built resumable-upload protocol with a clean, storage-agnostic client. Handles chunking/resume in the library.
- **Cons:** Adds a protocol server component and its own endpoint surface, separate from the S3-native path already available. With S3/MinIO the tus store still ultimately uses multipart — extra layer for capability S3 multipart already provides. More dependencies to maintain.

**Recommendation:** **Option B (S3 Multipart Upload with presigned part URLs)** — it is native to the chosen storage/SDK (TD-02), satisfies both hard requirements (>5GB objects and resume-on-failure), and keeps every byte off the API process. tus (Option C) is the fallback if a storage-agnostic, protocol-level resume is later preferred over S3-native multipart. Contract published via OpenAPI: `initiate` (returns `uploadId` + part URLs), `complete`, `abort`.

**Decision:** Option B (S3 Multipart Upload with presigned part URLs)

---

## TD-05: Video Worker Deployment Architecture

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The C4 diagram models the Video Worker (FFmpeg) as a **separate container** from the API. FFmpeg processing is CPU/IO-heavy and must not degrade API responsiveness. The worker consumes the RabbitMQ queue (TD-01), reads the source object and writes the thumbnail (TD-02), and updates video status (TD-09). The decision is how this worker is structured and deployed within the existing single `nestjs-project/` codebase.

**Options:**

### Option A: NestJS monorepo apps (`apps/api` + `apps/worker`)
- Restructure `nestjs-project` into a Nest monorepo with two apps and shared `libs/`.
- **Pros:** Clean separation of two deployables with shared libraries. Idiomatic Nest monorepo layout.
- **Cons:** Non-trivial restructure of the current standard single-app project (moves `src/`, reworks build/test/tsconfig). Larger blast radius than the phase needs.

### Option B: Standalone Nest application-context worker (`main.worker.ts`) + own Compose service
- Add a second entrypoint (`main.worker.ts`) in the same `src/` that bootstraps a NestJS application context / RMQ microservice with only the processing module wired. Run it as its own Compose service (own command/Dockerfile stage), reusing the same image and sharing entities, config, and the storage client with the API.
- **Pros:** Matches the C4 "separate container" without a monorepo restructure. Full code reuse (entities, config, storage service) via ordinary imports. Heavy FFmpeg work runs in its own process/container — API stays responsive. Small, additive change.
- **Cons:** Two entrypoints in one codebase (must keep the worker's module graph lean). Shared image means API deps ship to the worker (acceptable; FFmpeg lives only in the worker stage — TD-06).

### Option C: In-process consumer inside the API container
- The API container itself subscribes to the queue and runs FFmpeg.
- **Pros:** Zero new deployable. Simplest wiring.
- **Cons:** Violates the architecture's separation — FFmpeg CPU load directly contends with API request handling, breaking "sem impacto na performance". No independent scaling of processing.

**Recommendation:** **Option B (standalone Nest application-context worker)** — it realizes the diagram's separate worker container and isolates FFmpeg load from the API, while avoiding a full monorepo-apps restructure. The worker is a NestJS RMQ consumer subscribed to the video-processing queue, reusing the API's entities/config/storage code through normal imports.

**Decision:** Option B (standalone Nest application-context worker)

---

## TD-06: FFmpeg Integration Approach

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker (TD-05) must extract duration + metadata and generate one thumbnail frame — **no transcoding** (confirmed processing depth). This needs the FFmpeg/FFprobe binaries plus a way to invoke them from Node. The decision covers both how the binary is provided (Docker image) and how it is driven from TypeScript.

**Options:**

### Option A: `fluent-ffmpeg` wrapper
- Chainable JS API over the FFmpeg CLI.
- **Pros:** Ergonomic, well-known API; readable metadata/thumbnail code.
- **Cons:** The package has been in a maintenance-seeking / low-activity state — a dependency-longevity risk for a core pipeline. Still shells out to a system FFmpeg binary anyway.

### Option B: System FFmpeg in the worker image + `child_process.spawn`
- Install `ffmpeg`/`ffprobe` in the worker Docker image (apt). Drive them from a thin typed wrapper: `ffprobe -show_format -show_streams -print_format json` for duration/metadata; `ffmpeg -ss <t> -i <src> -frames:v 1` for the thumbnail. Stream from a presigned URL / temp file.
- **Pros:** No dependency on a maintenance-risk wrapper. Full control over binary version and codecs via the image. Minimal, auditable surface. `ffprobe` JSON output is trivially parsed into the metadata contract.
- **Cons:** A small amount of process-spawn/parse plumbing to write and test. Manual arg construction.

### Option C: Bundled binary (`ffmpeg-static` / `@ffmpeg-installer/ffmpeg`) + spawn
- Pull the FFmpeg binary as an npm dependency instead of installing via the image.
- **Pros:** No apt step; binary pinned via npm.
- **Cons:** Less control over build flags/codecs than a distro/image binary; larger `node_modules`; platform-specific binary concerns. Image-installed FFmpeg is the more standard, controllable route for a containerized worker.

**Recommendation:** **Option B (system FFmpeg in the worker image + `spawn`)** — it removes reliance on a maintenance-risk wrapper, gives full control of the FFmpeg version/codecs through the worker image, and the required operations (ffprobe metadata + single-frame thumbnail) are a thin, testable spawn layer. Since there is no transcoding, the wrapper ergonomics of `fluent-ffmpeg` add little value.

**Decision:** Option B (system FFmpeg in the worker image + `spawn`)

**Revisions:**
- 2026-07-28 — Thumbnail frame-selection rule specified: fixed timestamp `00:00:01` (fallback to `duration/2` for videos shorter than 2s). Rationale: simple, deterministic single-frame extraction; avoids re-litigating the extraction point per video (resolves AMB-1).

---

## TD-07: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, URL-safe public identifier that never collides (Pontos de Atenção: "cada vídeo precisa de uma URL curta e única que nunca conflite"). It becomes the public address of the video (consumed by FE routes and API paths) and must not leak the internal primary key or be enumerable.

**Options:**

### Option A: `nanoid` short id
- Generate a URL-safe id (e.g. 11 chars, YouTube-like) stored in a unique `public_id` column; retry generation on the rare unique-constraint collision.
- **Pros:** Short, opaque, URL-safe by default. Collision probability negligible at project scale; the unique column + retry makes conflicts impossible in practice. Tiny dependency. Non-enumerable (doesn't expose sequential ids).
- **Cons:** Random ids are not sortable/meaningful. A (vanishingly rare) collision requires a retry path.

### Option B: UUID v4
- Use a random UUID as the public identifier.
- **Pros:** Built-in, collision-free without a retry, already used for internal PKs.
- **Cons:** Long and ugly in URLs (36 chars). Fails the "URL curta" intent. Visually heavy for a share link.

### Option C: `hashids` / `sqids` encoding the internal id
- Encode the sequential internal id into a short reversible string.
- **Pros:** Short, deterministic from the PK, no separate storage needed.
- **Cons:** Reversible — decodes back to a sequential id, leaking creation order/volume and remaining enumerable. Weaker privacy than an opaque random id.

**Recommendation:** **Option A (`nanoid`)** — short, opaque, URL-safe identifiers with a unique column and retry-on-collision deliver "URL curta e única" without exposing or enabling enumeration of internal ids. UUID fails the "short" requirement; hashids leaks order.

**Decision:** Option A (`nanoid`)

---

## TD-08: Media Delivery — Streaming Playback & Download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Anonymous users must stream videos without downloading the whole file, and authenticated flows offer an explicit download. Since there is **no transcoding** (progressive MP4, not HLS/ABR), streaming is served by HTTP **Range** requests on the stored object. The C4 diagram shows `frontend → storage: Streams` (the strict-BFF storage carve-out). This is one cross-layer contract covering both playback and download; the backend issues the URLs, the browser consumes storage directly.

**Options:**

### Option A: Presigned GET URLs direct from storage
- For playback, the API/BFF returns a short-lived presigned `GET` URL; the browser's `<video>` element requests it and MinIO/S3 serves **HTTP Range** natively for progressive streaming. For download, the same presigned URL is issued with `response-content-disposition=attachment` so the browser saves the file.
- **Pros:** Keeps the API entirely out of the byte path — matches the diagram and TD-04's philosophy. Range support is native in S3/MinIO (seek/scrub works out of the box). One mechanism serves both stream and download (differing only by content-disposition). Presigned expiry gives basic access control, including for unlisted videos.
- **Cons:** The presigned host must be browser-reachable (TD-03). Access control granularity is expiry-based, not per-request. Unlisted-video privacy relies on URL secrecy + short expiry (adequate for the phase).

### Option B: API/BFF proxies the stream (with Range support)
- The NestJS API (or the Next.js Route Handler) reads from storage and pipes bytes to the client, forwarding Range headers.
- **Pros:** Central control point for auth/analytics on every byte range. Backend URL/storage host never exposed.
- **Cons:** Puts large media traffic back through the API/BFF process — directly contradicts "sem impacto na performance". Higher memory/CPU and bandwidth cost. Negates the direct-to-storage architecture.

### Option C: Signed CDN URL
- Front storage with a CDN and issue signed CDN URLs.
- **Pros:** Best production performance/caching at the edge.
- **Cons:** No CDN in the current stack; premature for the phase. Adds infra/cost with no local-dev equivalent. Can be layered on later in front of Option A without changing the contract shape.

**Recommendation:** **Option A (presigned GET direct from storage)** — it keeps media bytes off the API, uses storage-native Range for progressive streaming (no transcoding needed), and serves download via the same mechanism with `content-disposition=attachment`. Matches the C4 diagram; a CDN (Option C) can later sit in front without changing the contract.

**Decision:** Option A (presigned GET direct from storage)

---

## TD-09: Video Processing Status Lifecycle

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** When an upload starts, the video is pre-registered as a **draft** (before bytes finish). After upload, processing runs asynchronously (TD-01/TD-05) and eventually the video becomes playable — or fails. The frontend (Phases 04/05) must be able to reflect this progression. This decision fixes how the state is modeled and how readiness is surfaced, since RabbitMQ (TD-01) does not expose job progress natively.

**Options:**

### Option A: Status enum state machine on the `Video` entity
- A `status` enum column on `videos`: `draft → uploading → processing → ready` (+ `failed`). The API creates the row as `draft`/`uploading` when the upload is initiated (TD-04); the worker transitions to `processing` then `ready`/`failed` (TD-05). The FE learns readiness by **polling** the video status via the API.
- **Pros:** Single, self-documenting source of truth on the video the FE already fetches. Trivial contract — one field the FE renders/polls. Enables listing filters (drafts vs published) in later phases. No extra infra for status.
- **Cons:** Polling is not push — a short client poll interval covers "processing → ready". No fine-grained percentage progress (acceptable: metadata+thumbnail jobs are short relative to the upload).

### Option B: Separate `processing_jobs` table
- A dedicated table tracks per-job state/attempts/errors; the video's status is derived from it.
- **Pros:** Richer processing audit trail (attempts, error detail, timestamps). Cleaner separation of job state from domain state.
- **Cons:** More schema + a join/derivation for the common "is it ready?" query the FE needs. Heavier than the phase requires when the worker already has RabbitMQ retries/DLQ (TD-01) for reliability.

### Option C: Boolean flags (`is_processed`, `is_published`)
- Model state as independent booleans.
- **Pros:** Minimal columns.
- **Cons:** Booleans can't represent `failed` or the in-flight `processing`/`uploading` states without ambiguous combinations. Not a real state machine — invalid states become representable. Worse contract for the FE.

**Recommendation:** **Option A (status enum state machine)** — it is the simplest correct contract: one enum field the API sets on draft creation and the worker advances, which the FE polls for readiness. It cleanly represents `failed` and the in-flight states, and supports later draft/publish filtering. A dedicated jobs table (Option B) is unnecessary given RabbitMQ already owns retry/DLQ reliability.

**Decision:** Option A (status enum state machine)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Repo-wide | Message queue / background-job infra | RabbitMQ (user-directed) | Option A (RabbitMQ) |
| TD-02 | Backend | Object storage backend + client library | MinIO + `@aws-sdk/client-s3` | Option A (MinIO + `@aws-sdk/client-s3`) |
| TD-03 | Repo-wide | Local infra topology for storage/queue | Add MinIO + RabbitMQ + worker to `nestjs-project/compose.yaml` | Option A |
| TD-04 | Cross-layer | Large-file upload protocol (≤10GB, resumable) | S3 Multipart with presigned part URLs | Option B (S3 Multipart Upload with presigned part URLs) |
| TD-05 | Repo-wide | Video worker deployment architecture | Standalone Nest app-context worker + own Compose service | Option B (standalone Nest application-context worker) |
| TD-06 | Backend | FFmpeg integration approach | System FFmpeg in worker image + `spawn` | Option B (system FFmpeg in the worker image + `spawn`) |
| TD-07 | Backend | Unique video URL identifier | `nanoid` short id + unique column | Option A (`nanoid`) |
| TD-08 | Cross-layer | Media delivery — streaming & download | Presigned GET direct from storage (Range + content-disposition) | Option A (presigned GET direct from storage) |
| TD-09 | Backend | Video processing status lifecycle | Status enum state machine; FE polls readiness | Option A (status enum state machine) |

---

## New Dependencies (indicative — reflecting the decisions above)

| Package / Service | Where | Purpose |
|-------------------|-------|---------|
| RabbitMQ (broker image) | Compose | Message queue (TD-01) |
| `@nestjs/microservices` + `amqplib` (or `amqp-connection-manager`) | `nestjs-project` (api + worker) | RMQ producer/consumer (TD-01/TD-05) |
| MinIO (image) | Compose | S3-compatible object storage, dev (TD-02) |
| `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` | `nestjs-project` (api + worker) | Storage client, presigned URLs, multipart (TD-02/TD-04/TD-08) |
| `nanoid` | `nestjs-project` | Unique video public id (TD-07) |
| FFmpeg / FFprobe (worker image, apt) | Worker Dockerfile | Metadata + thumbnail extraction (TD-06) |

## Files to Create/Modify (indicative)

| File | Action | Purpose |
|------|--------|---------|
| `nestjs-project/compose.yaml` | Modify | Add `minio`, `rabbitmq`, and `worker` services (TD-03) |
| `nestjs-project/src/config/storage.config.ts` | Create | `registerAs('storage', …)` — endpoint, bucket, credentials (TD-02) |
| `nestjs-project/src/config/queue.config.ts` | Create | `registerAs('queue', …)` — RabbitMQ URL/queue names (TD-01) |
| `nestjs-project/src/videos/entities/video.entity.ts` | Create | `Video` entity: `public_id`, `status`, metadata, storage key (TD-07/TD-09) |
| `nestjs-project/src/videos/**` | Create | Videos module, upload/presign controller + service, draft pre-registration (TD-04/TD-08/TD-09) |
| `nestjs-project/src/storage/**` | Create | S3 storage service (presign, multipart, get) (TD-02) |
| `nestjs-project/src/worker/**` + `main.worker.ts` | Create | Standalone worker entrypoint + processing consumer (TD-05/TD-06) |
| `nestjs-project/src/database/migrations/*` | Create | `videos` table migration (TD-07/TD-09) |
| `.env.example` / Joi schema | Modify | New storage + queue env vars (TD-01/TD-02) |
