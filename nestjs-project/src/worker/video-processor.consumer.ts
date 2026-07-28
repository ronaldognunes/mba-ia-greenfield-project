import { spawn } from 'node:child_process';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import amqp from 'amqp-connection-manager';
import type {
  AmqpConnectionManager,
  ChannelWrapper,
} from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import { QUEUE_TOPOLOGY_SUFFIXES } from '../queue/queue.constants';
import type { VideoProcessingRequestedPayload } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';

const THUMBNAIL_FALLBACK_DURATION_THRESHOLD_SECONDS = 2;
const FIXED_THUMBNAIL_TIMESTAMP = '00:00:01';

interface ProbeResult {
  durationSeconds: number;
  metadata: Record<string, unknown>;
}

@Injectable()
export class VideoProcessorConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoProcessorConsumer.name);
  private connection: AmqpConnectionManager;
  private channelWrapper: ChannelWrapper;

  constructor(
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connection = amqp.connect([this.config.url]);
    this.channelWrapper = this.connection.createChannel({
      setup: (channel: ConfirmChannel) => this.assertTopology(channel),
    });
    await this.channelWrapper.waitForConnect();
    await this.channelWrapper.consume(
      this.config.videoProcessingQueue,
      (msg) => void this.onMessage(msg),
      { prefetch: 1, noAck: false },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.channelWrapper.close();
    await this.connection.close();
  }

  static resolveThumbnailTimestamp(durationSeconds: number): string {
    return durationSeconds < THUMBNAIL_FALLBACK_DURATION_THRESHOLD_SECONDS
      ? String(durationSeconds / 2)
      : FIXED_THUMBNAIL_TIMESTAMP;
  }

  private async onMessage(msg: ConsumeMessage): Promise<void> {
    const payload = JSON.parse(
      msg.content.toString(),
    ) as VideoProcessingRequestedPayload;

    try {
      await this.processVideo(payload);
      this.channelWrapper.ack(msg);
    } catch (error) {
      this.logger.error(
        `Failed to process video "${payload.publicId}": ${(error as Error).message}`,
      );
      await this.markFailed(payload.videoId, error as Error);
      this.channelWrapper.nack(msg, false, false);
    }
  }

  private async processVideo(
    payload: VideoProcessingRequestedPayload,
  ): Promise<void> {
    const sourceUrl = await this.storageService.getPresignedGetUrl(
      payload.storageKey,
    );

    const { durationSeconds, metadata } = await this.probe(sourceUrl);
    const timestamp =
      VideoProcessorConsumer.resolveThumbnailTimestamp(durationSeconds);
    const thumbnailBuffer = await this.extractThumbnail(sourceUrl, timestamp);

    const thumbnailKey = `videos/${payload.publicId}/thumbnail.jpg`;
    await this.uploadThumbnail(thumbnailKey, thumbnailBuffer);

    await this.videoRepository.update(payload.videoId, {
      status: 'ready',
      duration_seconds: Math.round(durationSeconds),
      metadata,
      thumbnail_key: thumbnailKey,
    });
  }

  private async markFailed(videoId: string, error: Error): Promise<void> {
    await this.videoRepository.update(videoId, {
      status: 'failed',
      metadata: { error: error.message },
    });
  }

  private async uploadThumbnail(key: string, body: Buffer): Promise<void> {
    const { uploadId } = await this.storageService.createMultipartUpload(
      key,
      'image/jpeg',
    );
    const [part] = await this.storageService.getPresignedPartUrls(
      key,
      uploadId,
      1,
    );
    const response = await fetch(part.url, { method: 'PUT', body });
    const eTag = response.headers.get('etag');
    if (!response.ok || !eTag) {
      throw new Error(`Failed to upload thumbnail to storage key "${key}"`);
    }
    await this.storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag },
    ]);
  }

  private async probe(url: string): Promise<ProbeResult> {
    const stdout = await this.runProcess('ffprobe', [
      '-show_format',
      '-show_streams',
      '-print_format',
      'json',
      url,
    ]);
    const parsed = JSON.parse(stdout.toString()) as {
      format?: { duration?: string };
    };
    const durationSeconds = Number(parsed.format?.duration);
    if (!Number.isFinite(durationSeconds)) {
      throw new Error('ffprobe did not report a valid duration');
    }
    return { durationSeconds, metadata: parsed };
  }

  private extractThumbnail(url: string, timestamp: string): Promise<Buffer> {
    return this.runProcess('ffmpeg', [
      '-ss',
      timestamp,
      '-i',
      url,
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1',
    ]);
  }

  private runProcess(command: string, args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args);
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `${command} exited with code ${code}: ${Buffer.concat(stderrChunks).toString()}`,
            ),
          );
          return;
        }
        resolve(Buffer.concat(stdoutChunks));
      });
    });
  }

  // Duplicated from QueueService.assertTopology: the worker is a separate
  // process (TD-05) with no shared module graph, and either process may be
  // the first to connect, so both must idempotently assert the same topology.
  private async assertTopology(channel: ConfirmChannel): Promise<void> {
    const queue = this.config.videoProcessingQueue;
    const deadLetterExchange = `${queue}${QUEUE_TOPOLOGY_SUFFIXES.DEAD_LETTER_EXCHANGE}`;
    const deadLetterQueue = `${queue}${QUEUE_TOPOLOGY_SUFFIXES.DEAD_LETTER_QUEUE}`;

    await channel.assertExchange(deadLetterExchange, 'direct', {
      durable: true,
    });
    await channel.assertQueue(deadLetterQueue, { durable: true });
    await channel.bindQueue(deadLetterQueue, deadLetterExchange, queue);

    await channel.assertQueue(queue, {
      durable: true,
      deadLetterExchange,
      deadLetterRoutingKey: queue,
    });
  }
}
