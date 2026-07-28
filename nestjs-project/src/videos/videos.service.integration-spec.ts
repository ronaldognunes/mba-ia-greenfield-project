import { S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import amqp from 'amqp-connection-manager';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { ConsumeMessage } from 'amqplib';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { ensureBucketExists } from '../test/minio';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video];

describe('VideosService (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  const qConfig = queueConfig();

  beforeAll(async () => {
    const ds = createTestDataSource(ALL_ENTITIES);
    const sConfig = storageConfig();
    const rawClient = new S3Client({
      endpoint: sConfig.endpoint,
      region: sConfig.region,
      forcePathStyle: sConfig.forcePathStyle,
      credentials: {
        accessKeyId: sConfig.accessKeyId,
        secretAccessKey: sConfig.secretAccessKey,
      },
    });
    await ensureBucketExists(rawClient, sConfig.bucket);

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
        VideosModule,
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();

    dataSource = module.get(DataSource);
    videosService = module.get(VideosService);
    storageService = module.get(StorageService);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const suffix = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `vsi_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${suffix}`,
        nickname: `vsi${suffix}`,
        user_id: user.id,
      }),
    );
  }

  async function seedDraftVideo(
    channel: Channel,
  ): Promise<{ video: Video; eTag: string }> {
    const key = `test/videos-integration/${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { uploadId } = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    const [part] = await storageService.getPresignedPartUrls(key, uploadId, 1);
    const putResponse = await fetch(part.url, {
      method: 'PUT',
      body: 'fake video bytes for integration test',
    });
    const eTag = putResponse.headers.get('etag');
    if (!eTag) {
      throw new Error('MinIO did not return an ETag for the uploaded part');
    }

    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `vsi-${counter}-${Date.now()}`,
        channel_id: channel.id,
        original_filename: 'movie.mp4',
        file_size_bytes: '1024',
        status: 'draft',
        storage_key: key,
        upload_id: uploadId,
      }),
    );
    return { video, eTag };
  }

  async function receiveOne(
    queue: string,
    onReceived: (channel: ChannelWrapper, message: ConsumeMessage) => void,
  ): Promise<{ payload: unknown }> {
    const connection = amqp.connect([qConfig.url]);
    const channel = connection.createChannel({ json: true });
    await channel.waitForConnect();
    try {
      return await new Promise((resolve, reject) => {
        channel
          .consume(
            queue,
            (message: ConsumeMessage) => {
              try {
                onReceived(channel, message);
                resolve({
                  payload: JSON.parse(message.content.toString()) as unknown,
                });
              } catch (error) {
                reject(error as Error);
              }
            },
            { noAck: false },
          )
          .catch(reject);
      });
    } finally {
      await channel.close();
      await connection.close();
    }
  }

  describe('completeUpload', () => {
    it('transitions status to processing and publishes video.processing.requested to the real queue', async () => {
      const channel = await createChannel();
      const { video, eTag } = await seedDraftVideo(channel);

      const result = await videosService.completeUpload(video.public_id, {
        upload_id: video.upload_id!,
        parts: [{ part_number: 1, e_tag: eTag }],
      });

      expect(result).toEqual({
        public_id: video.public_id,
        status: 'processing',
      });

      const updated = await videoRepository.findOneBy({ id: video.id });
      expect(updated!.status).toBe('processing');

      const { payload } = await receiveOne(
        qConfig.videoProcessingQueue,
        (ch, message) => ch.ack(message),
      );
      expect(payload).toEqual({
        videoId: video.id,
        publicId: video.public_id,
        storageKey: video.storage_key,
      });
    });
  });
});
