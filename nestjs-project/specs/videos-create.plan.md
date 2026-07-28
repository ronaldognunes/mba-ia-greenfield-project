---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.5
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` is the entry point of the video upload flow: an authenticated channel owner submits basic file metadata (`original_filename`, `content_type`, `file_size_bytes`) and the API pre-registers the video as a `draft`, generates its short `public_id`, and initiates an S3 multipart upload session, returning the presigned part URLs the client will upload directly to.

## Test Scenarios

### 1. Criar rascunho e iniciar upload multipart

**Setup:** `beforeEach` truncates test tables (`cleanAllTables()`); Nest test module bootstrapped via `Test.createTestingModule({ imports: [AppModule] }).compile()` + `app.init()`, reproducing `main.ts`'s global pipes/filters; a test channel is authenticated and its `accessToken` obtained via the `phase-02-auth` login flow.

#### 1.1. cria-rascunho-com-sucesso

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-28T17:10:19Z

**Steps:**
  1. POST /videos com body `{ original_filename, content_type, file_size_bytes }` válido e header `Authorization: Bearer <accessToken>`
    - expect: status 201
    - expect: corpo contém `public_id` (string), `status: "draft"`, `upload_id` (string) e `parts` (array de `{ part_number, url }`)

#### 1.2. rejeita-arquivo-acima-do-limite

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-28T17:10:19Z

**Steps:**
  1. POST /videos com `file_size_bytes` acima de 10737418240 (10GB) e header `Authorization` válido
    - expect: status 413
    - expect: corpo contém `errorCode: "FILE_TOO_LARGE"`

#### 1.3. rejeita-sem-autenticacao

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-28T17:10:19Z

**Steps:**
  1. POST /videos com body válido, sem header `Authorization`
    - expect: status 401
