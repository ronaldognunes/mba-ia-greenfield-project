---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.6
target_file: test/videos-upload.e2e-spec.ts
---

# Upload Complete/Abort Test Plan

## Application Overview

`POST /videos/:publicId/upload-complete` and `POST /videos/:publicId/upload-abort` close out the multipart upload session a `draft` video started via `POST /videos`. Completing finalizes the S3 multipart upload, transitions the video to `processing`, and enqueues the `video.processing.requested` job for the worker; aborting cancels the multipart session and discards the draft.

## Test Scenarios

### 1. Completar upload multipart

**Setup:** `beforeEach` truncates test tables (`cleanAllTables()`); Nest test module bootstrapped via `Test.createTestingModule({ imports: [AppModule] }).compile()` + `app.init()`, reproducing `main.ts`'s global pipes/filters; a `Video` in `draft` status with an active `upload_id` is seeded directly via the repository for the authenticated owning channel (simulating a prior `POST /videos` call).

#### 1.1. completa-upload-com-sucesso

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-28T17:10:19Z

**Steps:**
  1. POST /videos/:publicId/upload-complete com `upload_id` e `parts` válidas (`part_number` + `e_tag`) e `Authorization` do canal dono
    - expect: status 200
    - expect: corpo contém `public_id` e `status: "processing"`

#### 1.2. rejeita-completar-upload-ja-concluido

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-28T17:10:19Z

**Steps:**
  1. Dado um vídeo cujo upload já foi completado anteriormente, POST /videos/:publicId/upload-complete novamente com `Authorization` do canal dono
    - expect: status 409
    - expect: corpo contém `errorCode: "UPLOAD_ALREADY_COMPLETED"`

#### 1.3. rejeita-partes-invalidas

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-28T17:10:19Z

**Steps:**
  1. POST /videos/:publicId/upload-complete com `parts` ausente ou inconsistente com a sessão multipart e `Authorization` do canal dono
    - expect: status 400
    - expect: corpo contém `errorCode: "INVALID_UPLOAD_PARTS"`

### 2. Abortar upload multipart

**Setup:** mesma base do grupo 1 — vídeo em `draft` com `upload_id` ativo, seedado diretamente via o repositório para o canal dono autenticado.

#### 2.1. aborta-upload-com-sucesso

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-28T17:10:19Z

**Steps:**
  1. POST /videos/:publicId/upload-abort com `Authorization` do canal dono
    - expect: status 204
    - expect: o rascunho do vídeo deixa de existir (consulta direta ao repositório confirma remoção, ou um `GET` subsequente ao mesmo `publicId` retorna 404)
