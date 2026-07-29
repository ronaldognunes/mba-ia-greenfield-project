import * as fs from 'node:fs';
import * as path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import amqp from 'amqp-connection-manager';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { ensureBucketExists } from '../test/minio';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { WorkerModule } from './worker.module';

describe('VideoProcessorConsumer (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let storageService: StorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  const qConfig = queueConfig();

  beforeAll(async () => {
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

    // Purge leftover messages from other integration suites (e.g.
    // videos.service.integration-spec.ts publishes to this same real,
    // durable queue) BEFORE the consumer attaches — otherwise it would
    // drain that backlog first and starve this suite's own messages.
    const purgeConnection = amqp.connect([qConfig.url]);
    const purgeChannel = purgeConnection.createChannel();
    await purgeChannel.waitForConnect();
    await purgeChannel.purgeQueue(qConfig.videoProcessingQueue);
    await purgeChannel.purgeQueue(`${qConfig.videoProcessingQueue}.dlq`);
    await purgeChannel.close();
    await purgeConnection.close();

    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    app = module.createNestApplication();
    await app.init();

    dataSource = module.get(DataSource);
    storageService = module.get(StorageService);
    userRepository = module.get(getRepositoryToken(User));
    channelRepository = module.get(getRepositoryToken(Channel));
    videoRepository = module.get(getRepositoryToken(Video));
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
        email: `vpc_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${suffix}`,
        nickname: `vpc${suffix}`,
        user_id: user.id,
      }),
    );
  }

  async function uploadObject(
    key: string,
    body: Buffer | string,
    contentType: string,
  ): Promise<void> {
    const { uploadId } = await storageService.createMultipartUpload(
      key,
      contentType,
    );
    const [part] = await storageService.getPresignedPartUrls(key, uploadId, 1);
    const putResponse = await fetch(part.url, {
      method: 'PUT',
      body: body as unknown as BodyInit,
    });
    const eTag = putResponse.headers.get('etag');
    if (!eTag) {
      throw new Error('MinIO did not return an ETag for the uploaded part');
    }
    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag },
    ]);
  }

  async function seedProcessingVideo(
    channelEntity: Channel,
    suffix: string,
  ): Promise<Video> {
    return videoRepository.save(
      videoRepository.create({
        public_id: `vpc-${suffix}`,
        channel_id: channelEntity.id,
        original_filename: 'sample.mp4',
        file_size_bytes: '1024',
        status: 'processing',
        storage_key: `videos/vpc-${suffix}/original`,
      }),
    );
  }

  async function publish(payload: {
    videoId: string;
    publicId: string;
    storageKey: string;
  }): Promise<void> {
    const connection = amqp.connect([qConfig.url]);
    const channel = connection.createChannel({ json: true });
    await channel.waitForConnect();
    await channel.sendToQueue(qConfig.videoProcessingQueue, payload, {
      persistent: true,
    });
    await channel.close();
    await connection.close();
  }

  async function waitForStatus(
    videoId: string,
    timeoutMs = 20000,
  ): Promise<Video> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const video = await videoRepository.findOneBy({ id: videoId });
      if (video && video.status !== 'processing') {
        return video;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(
      `Timed out waiting for video "${videoId}" to leave "processing" status`,
    );
  }

  async function dlqMessageCount(): Promise<number> {
    const connection = amqp.connect([qConfig.url]);
    const channel = connection.createChannel();
    await channel.waitForConnect();
    const { messageCount } = await channel.checkQueue(
      `${qConfig.videoProcessingQueue}.dlq`,
    );
    await channel.close();
    await connection.close();
    return messageCount;
  }

  async function waitForDlqCount(
    atLeast: number,
    timeoutMs = 10000,
  ): Promise<number> {
    const start = Date.now();
    let count = await dlqMessageCount();
    while (count < atLeast && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      count = await dlqMessageCount();
    }
    return count;
  }

  it('processes a fixture video longer than 2s: status becomes ready with duration_seconds and thumbnail_key populated', async () => {
    const channelEntity = await createChannel();
    const video = await seedProcessingVideo(channelEntity, `${Date.now()}-ok`);
    const fixture = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'sample-3s.mp4'),
    );
    await uploadObject(video.storage_key!, fixture, 'video/mp4');

    await publish({
      videoId: video.id,
      publicId: video.public_id,
      storageKey: video.storage_key!,
    });

    const updated = await waitForStatus(video.id);

    expect(updated.status).toBe('ready');
    expect(updated.duration_seconds).toBe(3);
    expect(updated.thumbnail_key).toBe(
      `videos/${video.public_id}/thumbnail.jpg`,
    );
    expect(updated.metadata).toBeTruthy();

    const thumbnailUrl = await storageService.getPresignedGetUrl(
      updated.thumbnail_key!,
    );
    const thumbnailResponse = await fetch(thumbnailUrl);
    expect(thumbnailResponse.ok).toBe(true);
    expect(thumbnailResponse.headers.get('content-type')).toContain('image');
  }, 30000);

  it('a real ffprobe failure marks the video as failed and dead-letters the message', async () => {
    const channelEntity = await createChannel();
    const video = await seedProcessingVideo(
      channelEntity,
      `${Date.now()}-fail`,
    );
    await uploadObject(
      video.storage_key!,
      'this is not a real video file',
      'video/mp4',
    );
    const dlqCountBefore = await dlqMessageCount();

    await publish({
      videoId: video.id,
      publicId: video.public_id,
      storageKey: video.storage_key!,
    });

    const updated = await waitForStatus(video.id);

    expect(updated.status).toBe('failed');
    expect((updated.metadata as { error?: string } | null)?.error).toBeTruthy();

    const dlqCountAfter = await waitForDlqCount(dlqCountBefore + 1);
    expect(dlqCountAfter).toBeGreaterThanOrEqual(dlqCountBefore + 1);
  }, 30000);
});
