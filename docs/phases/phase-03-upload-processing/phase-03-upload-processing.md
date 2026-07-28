---
kind: phase
name: phase-03-upload-processing
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-upload-processing/context.md: "2026-07-28T10:44:36-03:00"
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-07-28T10:42:03-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o pipeline de upload e processamento de vídeos da Fase 03 — serviço de armazenamento de arquivos (vídeos e thumbnails), serviço de processamento em segundo plano (filas), upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance, pré-cadastro automático do vídeo como rascunho ao iniciar o upload, processamento automático do vídeo após upload (extração de duração e metadados), geração automática de thumbnail a partir de um frame do vídeo, URL única por vídeo sem conflito, reprodução via streaming e download — cobrindo os entregáveis: upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

---

## Step Implementations

### SI-03.1 — Instalar dependências, criar namespaces de configuração e atualizar o Compose

**Description:** Prepara a fundação de infraestrutura do pipeline de vídeo — dependências npm, configuração namespaced e os novos serviços de compose (MinIO, RabbitMQ, worker) — antes de qualquer código de domínio.

**Technical actions:**

1. Adicionar `@nestjs/microservices`, `amqp-connection-manager`, `amqplib`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `nanoid` ao `nestjs-project/package.json` (per `phase-03-upload-processing/TD-01`, `TD-02`, `TD-04`, `TD-07`)
2. Criar `src/config/storage.config.ts` (`registerAs`) — endpoint, credenciais e bucket do MinIO (per `phase-03-upload-processing/TD-02`, seguindo o padrão de `phase-01-configuracao-base/TD-03`)
3. Criar `src/config/queue.config.ts` (`registerAs`) — URL de conexão e nome da fila do RabbitMQ (per `phase-03-upload-processing/TD-01`)
4. Adicionar os serviços `minio`, `rabbitmq` e `worker` ao `nestjs-project/compose.yaml`, expondo a porta do MinIO no host (per `phase-03-upload-processing/TD-03`)
5. Atualizar `.env.example` e o schema Joi de validação com as novas variáveis de storage/queue (per `phase-01-configuracao-base/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `storage.config.ts` / `queue.config.ts` | Unit: compilation/config validation test | `src/config/storage-queue.config.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose config` valida sem erros com os três novos serviços declarados
- A aplicação falha na inicialização com uma mensagem clara de validação Joi quando uma variável de storage/queue obrigatória está ausente
- `ConfigModule` expõe `storageConfig` e `queueConfig` via `ConfigType` injetável

---

### SI-03.2 — Entidade `Video` e migração

**Description:** Cria a tabela `videos` e a entidade TypeORM que suporta o ciclo de vida do vídeo — do rascunho ao status final.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com os campos `id`, `public_id`, `channel_id`, `original_filename`, `title`, `status`, `storage_key`, `thumbnail_key`, `duration_seconds`, `metadata`, `file_size_bytes`, `upload_id`, `created_at`, `updated_at` (per `phase-03-upload-processing/TD-07`, `TD-09`, `TD-02`, `TD-04`, `TD-06`)
2. Adicionar a relação `@ManyToOne(() => Channel)` em `Video` e `@OneToMany(() => Video)` em `Channel`
3. Gerar e commitar a migração criando a tabela `videos` com índice único em `public_id` e índices em `channel_id` e `status`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints (unique `public_id`), default `status: draft`, FK `channel_id` | `src/videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Inserir dois vídeos com o mesmo `public_id` viola a constraint de unicidade
- Criar um `Video` sem `status` explícito persiste com `status: draft`
- Inserir um `Video` com `channel_id` inexistente viola a FK constraint

---

### SI-03.3 — Storage Module (MinIO / S3 client wrapper)

**Description:** Encapsula o cliente `@aws-sdk/client-s3` num serviço único que gera URLs presignadas e conduz o ciclo de vida do multipart upload.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `storage.service.ts` configurando um `S3Client` a partir de `storage.config.ts` (per `phase-03-upload-processing/TD-02`)
2. Implementar `createMultipartUpload`, `getPresignedPartUrls`, `completeMultipartUpload` e `abortMultipartUpload` (per `phase-03-upload-processing/TD-04`)
3. Implementar `getPresignedGetUrl(key, { contentDisposition? })` reutilizado para streaming (Range nativo do storage), download (`content-disposition=attachment`) e thumbnail (per `phase-03-upload-processing/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: real MinIO (docker compose) — ciclo completo de multipart + presign | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — depende do `storage.config.ts` e do serviço `minio` no compose

**Acceptance criteria:**

- `createMultipartUpload` seguido de `getPresignedPartUrls` retorna URLs válidas aceitas por um `PUT` direto ao MinIO
- `completeMultipartUpload` com todas as partes finaliza o objeto no bucket configurado
- `getPresignedGetUrl` com `contentDisposition: attachment` gera uma URL cujo `GET` retorna o header `content-disposition`

---

### SI-03.4 — Queue Module (produtor RabbitMQ)

**Description:** Encapsula a conexão RabbitMQ num serviço produtor que publica o evento de processamento de vídeo com entrega durável.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` e `queue.service.ts` conectando via `amqp-connection-manager`/`amqplib` a partir de `queue.config.ts`, declarando a fila durável e sua dead-letter queue (per `phase-03-upload-processing/TD-01`)
2. Implementar `publishVideoProcessingRequested(payload)` publicando na fila `video.processing.requested` (per `phase-03-upload-processing/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueService` | Integration: real RabbitMQ (docker compose) — publish e consumo de uma mensagem de teste | `src/queue/queue.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — depende do `queue.config.ts` e do serviço `rabbitmq` no compose

**Acceptance criteria:**

- `publishVideoProcessingRequested` publica uma mensagem persistente na fila configurada
- Ao reiniciar a conexão, mensagens não confirmadas (sem ack) permanecem na fila (durabilidade)
- Uma mensagem malformada rejeitada N vezes é roteada à dead-letter queue

---

### SI-03.5 — Endpoint `POST /videos` (criação de rascunho + início do upload)

**Description:** Implementa o pré-cadastro automático do vídeo como rascunho e o início do upload multipart, conforme `### API Contracts`.

**Route:** POST /videos
**Test Specs:** _pending /plan-test-specs_

**Technical actions:**

1. Criar `CreateVideoDto` (`original_filename`, `content_type`, `file_size_bytes`) com `class-validator` — `file_size_bytes` limitado a 10GB (per `phase-02-auth/TD-06`, `phase-03-upload-processing/TD-04`)
2. Implementar `VideosService.createDraftAndInitiateUpload()` — gera `public_id` via `nanoid` com retry-on-collision (per `phase-03-upload-processing/TD-07`), persiste o `Video` com `status: draft`, chama `StorageService.createMultipartUpload` + `getPresignedPartUrls` (per `phase-03-upload-processing/TD-02`, `TD-04`)
3. Criar `VideosController` com `POST /videos`, protegido pelo guard JWT herdado (per `phase-02-auth/TD-02`), retornando `201` conforme `### API Contracts`
4. Registrar `VideosModule` (importando `StorageModule`) em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createDraftAndInitiateUpload` | Unit: branch de retry-on-collision do `public_id` (mock repo) | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos` com corpo válido retorna `201` com `public_id`, `status: draft`, `upload_id` e a lista de `parts`
- `POST /videos` com `file_size_bytes` acima de 10GB retorna `413` com `errorCode: "FILE_TOO_LARGE"`
- `POST /videos` sem token de autenticação retorna `401`
- Uma colisão simulada de `public_id` é resolvida automaticamente sem expor o conflito ao chamador

---

### SI-03.6 — Endpoints de conclusão e aborto do upload

**Description:** Implementa a conclusão e o aborto do multipart upload, disparando o processamento assíncrono ao concluir.

**Route:** POST /videos/:publicId/upload-complete, POST /videos/:publicId/upload-abort
**Test Specs:** _pending /plan-test-specs_

**Technical actions:**

1. Criar `CompleteUploadDto` (`upload_id`, `parts[]`) com validação (per `phase-03-upload-processing/TD-04`)
2. Implementar `VideosService.completeUpload()` — chama `StorageService.completeMultipartUpload`, transiciona `status: draft → processing` e chama `QueueService.publishVideoProcessingRequested()` (per `phase-03-upload-processing/TD-04`, `TD-01`, `TD-09`)
3. Implementar `VideosService.abortUpload()` — chama `StorageService.abortMultipartUpload` e remove o rascunho (per `phase-03-upload-processing/TD-04`)
4. Criar em `VideosController` os endpoints `POST /videos/:publicId/upload-complete` e `POST /videos/:publicId/upload-abort` conforme `### API Contracts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Integration: publica de fato na fila real (RabbitMQ) | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4, SI-03.5

**Acceptance criteria:**

- `POST /videos/:publicId/upload-complete` com partes válidas retorna `200` com `status: processing` e publica a mensagem `video.processing.requested`
- `POST /videos/:publicId/upload-complete` num upload já concluído retorna `409` com `errorCode: "UPLOAD_ALREADY_COMPLETED"`
- `POST /videos/:publicId/upload-complete` com `parts` ausente ou inconsistente retorna `400` com `errorCode: "INVALID_UPLOAD_PARTS"`
- `POST /videos/:publicId/upload-abort` remove o rascunho e retorna `204`

---

### SI-03.7 — Endpoint `GET /videos/:publicId`

**Description:** Implementa a leitura do vídeo — polling de status para o dono enquanto não estiver pronto, e a representação pública de reprodução (streaming, download, thumbnail) uma vez `ready`.

**Route:** GET /videos/:publicId
**Test Specs:** _pending /plan-test-specs_

**Technical actions:**

1. Implementar `VideosService.getPublicRepresentation()` — ramifica por `status`: `draft`/`processing`/`failed` (somente dono) vs `ready` (anônimo, gera URLs presignadas de stream/download/thumbnail via `StorageService`) (per `phase-03-upload-processing/TD-08`, `TD-09`)
2. Criar em `VideosController` o endpoint `GET /videos/:publicId` conforme `### Authorization Matrix`
3. Criar `VideoNotFoundException`, mapeada pelo filtro de exceção herdado (per `phase-02-auth/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPublicRepresentation` | Unit: branch de status (mock repo) | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `GET /videos/:publicId` com `status: ready`, sem autenticação, retorna `200` com `stream_url`, `download_url` e `thumbnail_url`
- `GET /videos/:publicId` com `status: processing`, chamado por um usuário que não é o dono, retorna `401`/`403`
- `GET /videos/:publicId` com `publicId` inexistente retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`

---

### SI-03.8 — Bootstrap do Video Worker

**Description:** Cria o worker standalone que consome a fila de processamento, isolado da API conforme a arquitetura C4.

**Technical actions:**

1. Criar `src/worker/main.worker.ts` — bootstrap de application-context standalone do Nest (per `phase-03-upload-processing/TD-05`)
2. Criar `src/worker/worker.module.ts` importando as entidades de `VideosModule`, `StorageModule`, `queue.config.ts` e a conexão TypeORM (per `phase-03-upload-processing/TD-05`)
3. Adicionar o serviço `worker` ao `compose.yaml`/imagem do worker, instalando `ffmpeg`/`ffprobe` via apt (per `phase-03-upload-processing/TD-03`, `TD-06`)
4. Adicionar o script `worker:start` ao `package.json` (per `nestjs-project/CLAUDE.md`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: teste de compilação (DI wiring) | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `main.worker.ts` inicia um application context standalone sem expor HTTP
- `WorkerModule` compila com todas as dependências resolvidas via DI
- A imagem do worker contém os binários `ffmpeg` e `ffprobe` instalados

---

### SI-03.9 — Lógica de processamento do vídeo no worker

**Description:** Implementa o consumidor da fila que extrai metadados/duração, gera a thumbnail e finaliza o status do vídeo.

**Technical actions:**

1. Implementar `VideoProcessorConsumer` — handler RMQ inscrito na fila de processamento, com ack manual (per `phase-03-upload-processing/TD-01`, `TD-05`)
2. Implementar a extração de duração/metadados via `ffprobe` com `child_process.spawn` (`-show_format -show_streams -print_format json`) (per `phase-03-upload-processing/TD-06`)
3. Implementar a extração da thumbnail via `ffmpeg -ss 00:00:01 -frames:v 1` com fallback para `duration/2` em vídeos com menos de 2s, enviando o resultado ao storage via `StorageService` (per `phase-03-upload-processing/TD-06`, revisão de 2026-07-28)
4. Ao sucesso, atualizar `Video` para `status: ready` com `duration_seconds`, `metadata` e `thumbnail_key`; ao falhar, atualizar para `status: failed` e aplicar nack/dead-letter (per `phase-03-upload-processing/TD-09`, `TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessorConsumer` | Integration: `ffmpeg`/`ffprobe` reais contra um vídeo de fixture | `src/worker/video-processor.consumer.integration-spec.ts` |
| `VideoProcessorConsumer` | Unit: branch de seleção do timestamp da thumbnail (`00:00:01` vs `duration/2`) | `src/worker/video-processor.consumer.spec.ts` |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- Processar um vídeo de fixture com mais de 2s atualiza `status: ready` com `duration_seconds` e `thumbnail_key` populados
- Processar um vídeo de fixture com menos de 2s extrai a thumbnail em `duration/2`, não em `00:00:01`
- Uma falha do `ffmpeg`/`ffprobe` atualiza `status: failed` e envia a mensagem à dead-letter queue

---

### SI-03.10 — Guard de posse (ownership) dos endpoints de vídeo

**Description:** Garante que apenas o canal dono de um vídeo possa mutá-lo ou ler seu status enquanto não estiver `ready`.

**Technical actions:**

1. Criar `VideoOwnershipGuard` — verifica que `Video.channel_id` corresponde ao canal do usuário autenticado; ignora a checagem quando `status: ready` (acesso anônimo) (per `phase-03-upload-processing/TD-09`, guard JWT reaproveitado de `phase-02-auth/TD-02`)
2. Aplicar o guard aos endpoints de mutação (`POST /videos`, `upload-complete`, `upload-abort`) e, condicionalmente, em `GET /videos/:publicId`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoOwnershipGuard` | E2E: não-dono recebe `403`, dono recebe `200`/`201` | `test/videos-ownership.e2e-spec.ts` |
| `VideoOwnershipGuard` | Unit: branch de bypass quando `status: ready` | `src/videos/guards/video-ownership.guard.spec.ts` |

**Dependencies:** SI-03.5, SI-03.6, SI-03.7

**Acceptance criteria:**

- Um usuário que não é dono do vídeo recebe `403` ao chamar `upload-complete`/`upload-abort`
- O dono do vídeo recebe `200`/`201`/`204` nos mesmos endpoints
- `GET /videos/:publicId` com `status: ready` não exige autenticação, independentemente do dono

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(21) | unique, not null — short URL-safe identifier *(per phase-03-upload-processing/TD-07)* |
| channel_id | uuid | FK → `channels.id`, not null — owning channel |
| original_filename | varchar(255) | not null |
| title | varchar(255) | nullable — defaults to `original_filename` at creation; editable in a future phase |
| status | enum(`draft`, `processing`, `ready`, `failed`) | not null, default `draft` *(per phase-03-upload-processing/TD-09)* |
| storage_key | varchar(1024) | not null — object storage key of the uploaded file *(per phase-03-upload-processing/TD-02, TD-04)* |
| thumbnail_key | varchar(1024) | nullable — set by the worker once the thumbnail is extracted *(per phase-03-upload-processing/TD-06)* |
| duration_seconds | integer | nullable — set by the worker from `ffprobe` output *(per phase-03-upload-processing/TD-06)* |
| metadata | jsonb | nullable — raw `ffprobe`-derived metadata (codec, width, height, bitrate) *(per phase-03-upload-processing/TD-06)* |
| file_size_bytes | bigint | nullable — set on multipart upload completion |
| upload_id | varchar(255) | nullable — S3 multipart upload session id; cleared once the upload completes or is aborted *(per phase-03-upload-processing/TD-04)* |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | auto-updated |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to one `Channel`.
**Indexes:** unique on `public_id`; index on `channel_id`; index on `status`.

### API Contracts

#### POST /videos (SI-03.5)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer \<accessToken\> *(per phase-02-auth/TD-02)*

**Request body:**
- original_filename: string, required
- content_type: string, required
- file_size_bytes: integer, required — must be ≤ 10GB *(per phase-03-upload-processing/TD-04)*

**Response 201:**
- public_id: string *(per phase-03-upload-processing/TD-07)*
- status: `draft`
- upload_id: string — S3 multipart upload session id
- parts: array of `{ part_number: integer, url: string }` — presigned part-upload URLs
- expires_at: string (ISO-8601)

**Error responses:**
- 413 FILE_TOO_LARGE: when `file_size_bytes` exceeds 10GB
- 400 validation error: when the request body fails schema validation
- 401 UNAUTHORIZED: when no valid access token is presented

---

#### POST /videos/:publicId/upload-complete (SI-03.6)

**Request headers:**
- Authorization: Bearer \<accessToken\>

**Request body:**
- upload_id: string, required
- parts: array of `{ part_number: integer, e_tag: string }`, required

**Response 200:**
- public_id: string
- status: `processing`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `publicId` does not match any video
- 409 UPLOAD_ALREADY_COMPLETED: when the upload was already completed or aborted
- 400 INVALID_UPLOAD_PARTS: when `parts` is missing or inconsistent with the storage-side multipart session
- 401 UNAUTHORIZED / 403 FORBIDDEN: when the caller is not the owning channel

---

#### POST /videos/:publicId/upload-abort (SI-03.6)

**Request headers:**
- Authorization: Bearer \<accessToken\>

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 UPLOAD_ALREADY_COMPLETED
- 401 UNAUTHORIZED / 403 FORBIDDEN

---

#### GET /videos/:publicId (SI-03.7)

**Response 200 — status `draft` / `processing` / `failed` (owner only):**
- public_id: string
- status: string
- error: string, nullable — populated when `status: failed`

**Response 200 — status `ready` (anonymous) *(per phase-03-upload-processing/TD-08)*:**
- public_id: string
- status: `ready`
- duration_seconds: integer
- stream_url: string — presigned GET URL, supports HTTP Range requests
- download_url: string — presigned GET URL with `response-content-disposition=attachment`
- thumbnail_url: string — presigned GET URL for the thumbnail image
- url expiry: all three URLs carry a short-lived `expires_at` (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 401 UNAUTHORIZED / 403 FORBIDDEN: when the video is not `ready` and the caller is not the owning channel

---

#### Validation Rules — Video upload

- `original_filename`: required, non-empty
- `content_type`: required, non-empty
- `file_size_bytes`: required, integer, `> 0` and `<= 10737418240` (10GB) *(per phase-03-upload-processing/TD-04)*
- `parts`: required on upload-complete, non-empty array, each item requires `part_number` (integer, >= 1) and `e_tag` (string)

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✗ | ✓ |
| POST /videos/:publicId/upload-complete | ✗ | ✗ | ✓ |
| POST /videos/:publicId/upload-abort | ✗ | ✗ | ✓ |
| GET /videos/:publicId — status `ready` | ✓ | ✓ | ✓ |
| GET /videos/:publicId — status `draft` / `processing` / `failed` | ✗ | ✗ | ✓ |

Ownership is enforced via `channel_id` on `Video` matched against the authenticated user's channel *(per phase-03-upload-processing/TD-09, guard implemented in SI-03.10; JWT guard inherited from phase-02-auth/TD-02)*. The state-dependent row on `GET /videos/:publicId` reflects that watch/stream access is anonymous only once processing has finished *(per the strict-BFF + storage carve-out anchor and phase-03-upload-processing/TD-08)*.

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| FILE_TOO_LARGE | 413 | Upload de vídeo maior que 10GB |
| VIDEO_NOT_FOUND | 404 | `publicId` não corresponde a nenhum vídeo |
| UPLOAD_ALREADY_COMPLETED | 409 | Tentativa de completar ou abortar um upload já finalizado/abortado |
| INVALID_UPLOAD_PARTS | 400 | Lista de `parts` ausente ou inconsistente ao completar o upload |

Error response shape (`{ statusCode, error, message }`) is inherited from `phase-02-auth/TD-07` — this phase only adds the domain-specific `error` codes above.

### Events/Messages

#### video.processing.requested

**Payload:**

```json
{ "videoId": "uuid", "publicId": "string", "storageKey": "string" }
```

**Producer:** `VideosService` (per `phase-03-upload-processing/TD-01`, `TD-04`; published in SI-03.6)
**Consumer:** Video Worker (per `phase-03-upload-processing/TD-05`; consumed in SI-03.9)
**Trigger:** `POST /videos/:publicId/upload-complete` successfully finalizes the S3 multipart upload
**Delivery semantics:** at-least-once, manual ack, dead-letter queue on repeated failure (per `phase-03-upload-processing/TD-01`)

The worker does not publish a completion event back to the API — it holds a direct connection to the same PostgreSQL database and writes the `Video` entity's `status`, `duration_seconds`, `metadata`, and `thumbnail_key` fields directly (per `phase-03-upload-processing/TD-05`'s shared-entities-via-import design).

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.3
└── SI-03.4

SI-03.2 (no deps)

SI-03.2 + SI-03.3
├── SI-03.5
└── SI-03.7

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.8
    └── SI-03.9

SI-03.4 + SI-03.5
└── SI-03.6

SI-03.5 + SI-03.6 + SI-03.7
└── SI-03.10
```

---

## Deliverables

- [ ] SI-03.1 — Instalar dependências, criar namespaces de configuração e atualizar o Compose
- [ ] SI-03.2 — Entidade `Video` e migração
- [ ] SI-03.3 — Storage Module (MinIO / S3 client wrapper)
- [ ] SI-03.4 — Queue Module (produtor RabbitMQ)
- [ ] SI-03.5 — Endpoint `POST /videos` (criação de rascunho + início do upload)
- [ ] SI-03.6 — Endpoints de conclusão e aborto do upload
- [ ] SI-03.7 — Endpoint `GET /videos/:publicId`
- [ ] SI-03.8 — Bootstrap do Video Worker
- [ ] SI-03.9 — Lógica de processamento do vídeo no worker
- [ ] SI-03.10 — Guard de posse (ownership) dos endpoints de vídeo

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Build succeeds (`docker compose exec nestjs-api npm run build`)
