---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.7
target_file: test/videos-detail.e2e-spec.ts
---

# GET /videos/:publicId Test Plan

## Application Overview

`GET /videos/:publicId` serves two purposes depending on the video's `status`: while `draft`/`processing`/`failed`, it lets only the owning channel poll for progress; once `ready`, it returns presigned streaming, download, and thumbnail URLs to any caller, authenticated or not.

## Test Scenarios

### 1. Consultar vídeo por public_id

**Setup:** `beforeEach` truncates test tables (`cleanAllTables()`); Nest test module bootstrapped via `Test.createTestingModule({ imports: [AppModule] }).compile()` + `app.init()`, reproducing `main.ts`'s global pipes/filters; test videos are seeded directly via the repository in different statuses (`ready`, `processing`), associated with an authenticated "owner" channel and a second "non-owner" channel.

#### 1.1. retorna-video-pronto-publicamente

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-28T17:10:19Z

**Steps:**
  1. GET /videos/:publicId de um vídeo com `status: "ready"`, sem header `Authorization`
    - expect: status 200
    - expect: corpo contém `stream_url`, `download_url` e `thumbnail_url` (strings de URL presignada)

#### 1.2. nega-acesso-a-nao-dono-durante-processamento

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-28T17:10:19Z

**Steps:**
  1. GET /videos/:publicId de um vídeo com `status: "processing"`, autenticado como um canal diferente do dono
    - expect: status 401 ou 403

#### 1.3. retorna-404-para-video-inexistente

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-28T17:10:19Z

**Steps:**
  1. GET /videos/:publicId com um `publicId` que não corresponde a nenhum vídeo
    - expect: status 404
    - expect: corpo contém `errorCode: "VIDEO_NOT_FOUND"`
