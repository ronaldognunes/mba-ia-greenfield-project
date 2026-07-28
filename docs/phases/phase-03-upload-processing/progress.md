# phase-03-upload-processing — Progress

**Status:** in_progress
**SIs:** 1/10 completed

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
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.3 — Storage Module (MinIO / S3 client wrapper)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

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
