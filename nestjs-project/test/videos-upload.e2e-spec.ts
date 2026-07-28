import { S3Client } from '@aws-sdk/client-s3';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { ensureBucketExists } from '../src/test/minio';
import { Video } from '../src/videos/entities/video.entity';

describe('Videos — upload complete/abort (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const config = storageConfig();
    const rawClient = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    await ensureBucketExists(rawClient, config.bucket);

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<{ access_token: string; refresh_token: string }> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return {
      access_token: res.body.access_token,
      refresh_token: res.body.refresh_token,
    };
  }

  async function createDraft(accessToken: string): Promise<{
    public_id: string;
    upload_id: string;
    part_url: string;
  }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        original_filename: 'my-video.mp4',
        content_type: 'video/mp4',
        file_size_bytes: 20 * 1024 * 1024,
      });
    return {
      public_id: res.body.public_id,
      upload_id: res.body.upload_id,
      part_url: res.body.parts[0].url,
    };
  }

  async function uploadPart(partUrl: string): Promise<string> {
    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: 'fake video bytes for upload-complete e2e',
    });
    const eTag = putResponse.headers.get('etag');
    if (!eTag) {
      throw new Error('MinIO did not return an ETag for the uploaded part');
    }
    return eTag;
  }

  describe('POST /videos/:publicId/upload-complete', () => {
    it('completa-upload-com-sucesso: 200 com status processing', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'complete1@example.com',
      );
      const { public_id, upload_id, part_url } =
        await createDraft(access_token);
      const eTag = await uploadPart(part_url);

      const res = await request(app.getHttpServer())
        .post(`/videos/${public_id}/upload-complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          upload_id,
          parts: [{ part_number: 1, e_tag: eTag }],
        });

      expect(res.status).toBe(200);
      expect(res.body.public_id).toBe(public_id);
      expect(res.body.status).toBe('processing');
    });

    it('rejeita-completar-upload-ja-concluido: 409 com errorCode UPLOAD_ALREADY_COMPLETED', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'complete2@example.com',
      );
      const { public_id, upload_id, part_url } =
        await createDraft(access_token);
      const eTag = await uploadPart(part_url);

      await request(app.getHttpServer())
        .post(`/videos/${public_id}/upload-complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ upload_id, parts: [{ part_number: 1, e_tag: eTag }] });

      const res = await request(app.getHttpServer())
        .post(`/videos/${public_id}/upload-complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ upload_id, parts: [{ part_number: 1, e_tag: eTag }] });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('UPLOAD_ALREADY_COMPLETED');
    });

    it('rejeita-partes-invalidas: 400 com errorCode INVALID_UPLOAD_PARTS', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'complete3@example.com',
      );
      const { public_id, upload_id } = await createDraft(access_token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${public_id}/upload-complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ upload_id, parts: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_UPLOAD_PARTS');
    });
  });

  describe('POST /videos/:publicId/upload-abort', () => {
    it('aborta-upload-com-sucesso: 204 e remove o rascunho', async () => {
      const { access_token } =
        await registerConfirmAndLogin('abort1@example.com');
      const { public_id } = await createDraft(access_token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${public_id}/upload-abort`)
        .set('Authorization', `Bearer ${access_token}`)
        .send();

      expect(res.status).toBe(204);

      const persisted = await dataSource
        .getRepository(Video)
        .findOneBy({ public_id });
      expect(persisted).toBeNull();
    });
  });
});
