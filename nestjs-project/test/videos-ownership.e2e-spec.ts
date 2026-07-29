import { S3Client } from '@aws-sdk/client-s3';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { ensureBucketExists } from '../src/test/minio';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';

describe('Videos — ownership guard (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

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
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
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
  ): Promise<{ access_token: string; channel_id: string }> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    const user = await userRepository.findOneBy({ email });
    const channel = await channelRepository.findOneBy({ user_id: user!.id });

    return {
      access_token: res.body.access_token,
      channel_id: channel!.id,
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
      body: 'fake video bytes for ownership e2e',
    });
    const eTag = putResponse.headers.get('etag');
    if (!eTag) {
      throw new Error('MinIO did not return an ETag for the uploaded part');
    }
    return eTag;
  }

  async function seedDraft(channelId: string): Promise<Video> {
    return videoRepository.save(
      videoRepository.create({
        public_id: `vd-own-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        channel_id: channelId,
        original_filename: 'movie.mp4',
        file_size_bytes: '1024',
        status: 'draft',
        storage_key: 'videos/vd-own/original',
        upload_id: 'fake-upload-id',
      }),
    );
  }

  describe('POST /videos', () => {
    it('permite-criacao-para-o-proprio-canal: 201 mesmo com o guard de posse aplicado', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'creator@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          original_filename: 'my-video.mp4',
          content_type: 'video/mp4',
          file_size_bytes: 1024,
        });

      expect(res.status).toBe(201);
    });
  });

  describe('POST /videos/:publicId/upload-complete', () => {
    it('nega-nao-dono: 403 ao tentar completar upload de vídeo de outro canal', async () => {
      const { channel_id: ownerChannelId } = await registerConfirmAndLogin(
        'complete-owner@example.com',
      );
      const { access_token: otherAccessToken } = await registerConfirmAndLogin(
        'complete-other@example.com',
      );
      const draft = await seedDraft(ownerChannelId);

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.public_id}/upload-complete`)
        .set('Authorization', `Bearer ${otherAccessToken}`)
        .send({
          upload_id: draft.upload_id,
          parts: [{ part_number: 1, e_tag: '"etag"' }],
        });

      expect(res.status).toBe(403);
    });

    it('permite-dono: 200 ao completar o próprio upload', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'complete-self@example.com',
      );
      const { public_id, upload_id, part_url } =
        await createDraft(access_token);
      const eTag = await uploadPart(part_url);

      const res = await request(app.getHttpServer())
        .post(`/videos/${public_id}/upload-complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ upload_id, parts: [{ part_number: 1, e_tag: eTag }] });

      expect(res.status).toBe(200);
    });
  });

  describe('POST /videos/:publicId/upload-abort', () => {
    it('nega-nao-dono: 403 ao tentar abortar upload de vídeo de outro canal', async () => {
      const { channel_id: ownerChannelId } = await registerConfirmAndLogin(
        'abort-owner@example.com',
      );
      const { access_token: otherAccessToken } = await registerConfirmAndLogin(
        'abort-other@example.com',
      );
      const draft = await seedDraft(ownerChannelId);

      const res = await request(app.getHttpServer())
        .post(`/videos/${draft.public_id}/upload-abort`)
        .set('Authorization', `Bearer ${otherAccessToken}`)
        .send();

      expect(res.status).toBe(403);

      const persisted = await videoRepository.findOneBy({
        public_id: draft.public_id,
      });
      expect(persisted).not.toBeNull();
    });

    it('permite-dono: 204 ao abortar o próprio upload', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'abort-self@example.com',
      );
      const { public_id } = await createDraft(access_token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${public_id}/upload-abort`)
        .set('Authorization', `Bearer ${access_token}`)
        .send();

      expect(res.status).toBe(204);
    });
  });
});
