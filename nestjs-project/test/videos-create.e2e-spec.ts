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

describe('Videos — create draft (e2e)', () => {
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
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
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

  describe('POST /videos', () => {
    it('cria rascunho com sucesso: 201 com public_id, status draft, upload_id e parts', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'creator@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          original_filename: 'my-video.mp4',
          content_type: 'video/mp4',
          file_size_bytes: 20 * 1024 * 1024,
        });

      expect(res.status).toBe(201);
      expect(typeof res.body.public_id).toBe('string');
      expect(res.body.status).toBe('draft');
      expect(typeof res.body.upload_id).toBe('string');
      expect(Array.isArray(res.body.parts)).toBe(true);
      expect(res.body.parts.length).toBeGreaterThan(0);
      expect(res.body.parts[0]).toEqual(
        expect.objectContaining({
          part_number: expect.any(Number),
          url: expect.any(String),
        }),
      );
    });

    it('rejeita arquivo acima do limite de 10GB: 413 com errorCode FILE_TOO_LARGE', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'creator2@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          original_filename: 'huge-video.mp4',
          content_type: 'video/mp4',
          file_size_bytes: 10 * 1024 * 1024 * 1024 + 1,
        });

      expect(res.status).toBe(413);
      expect(res.body.error).toBe('FILE_TOO_LARGE');
    });

    it('rejeita requisição sem autenticação: 401', async () => {
      const res = await request(app.getHttpServer()).post('/videos').send({
        original_filename: 'my-video.mp4',
        content_type: 'video/mp4',
        file_size_bytes: 1024,
      });

      expect(res.status).toBe(401);
    });
  });
});
