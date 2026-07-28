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
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';

describe('Videos — detail (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
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

  async function seedVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    return videoRepository.save(
      videoRepository.create({
        public_id: `vd-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        channel_id: channelId,
        original_filename: 'movie.mp4',
        file_size_bytes: '1024',
        status: 'processing',
        ...overrides,
      }),
    );
  }

  describe('GET /videos/:publicId', () => {
    it('retorna-video-pronto-publicamente: 200 com stream_url, download_url e thumbnail_url sem autenticação', async () => {
      const { channel_id } = await registerConfirmAndLogin(
        'owner-ready@example.com',
      );
      const video = await seedVideo(channel_id, {
        status: 'ready',
        storage_key: 'videos/ready-1/original',
        thumbnail_key: 'videos/ready-1/thumbnail.jpg',
        duration_seconds: 90,
      });

      const res = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}`,
      );

      expect(res.status).toBe(200);
      expect(typeof res.body.stream_url).toBe('string');
      expect(typeof res.body.download_url).toBe('string');
      expect(typeof res.body.thumbnail_url).toBe('string');
    });

    it('nega-acesso-a-nao-dono-durante-processamento: 401 ou 403 para outro canal autenticado', async () => {
      const { channel_id: ownerChannelId } = await registerConfirmAndLogin(
        'owner-processing@example.com',
      );
      const { access_token: otherAccessToken } = await registerConfirmAndLogin(
        'other-channel@example.com',
      );
      const video = await seedVideo(ownerChannelId, { status: 'processing' });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${otherAccessToken}`);

      expect([401, 403]).toContain(res.status);
    });

    it('retorna-404-para-video-inexistente: 404 com errorCode VIDEO_NOT_FOUND', async () => {
      const res = await request(app.getHttpServer()).get(
        '/videos/does-not-exist',
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
