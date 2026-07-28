import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import amqp from 'amqp-connection-manager';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { ConsumeMessage } from 'amqplib';
import queueConfig from '../config/queue.config';
import { QUEUE_TOPOLOGY_SUFFIXES } from './queue.constants';
import { QueueModule } from './queue.module';
import { QueueService } from './queue.service';

describe('QueueService (integration)', () => {
  let app: INestApplication;
  let queueService: QueueService;
  const config = queueConfig();
  const deadLetterQueue = `${config.videoProcessingQueue}${QUEUE_TOPOLOGY_SUFFIXES.DEAD_LETTER_QUEUE}`;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    queueService = app.get(QueueService);
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Opens a short-lived connection, consumes exactly one message from
   * `queue`, lets the caller ack/nack it via `onReceived`, then tears the
   * connection down. A fresh connection per call keeps each assertion
   * isolated from the others' consumer/ack state.
   */
  async function receiveOne(
    queue: string,
    onReceived: (channel: ChannelWrapper, message: ConsumeMessage) => void,
  ): Promise<{ payload: unknown; message: ConsumeMessage }> {
    const connection = amqp.connect([config.url]);
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
                  message,
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

  it('publishes a persistent message accepted by the configured queue', async () => {
    const payload = {
      videoId: 'video-1',
      publicId: 'public-1',
      storageKey: 'videos/video-1/original.mp4',
    };

    await queueService.publishVideoProcessingRequested(payload);

    const { payload: received, message } = await receiveOne(
      config.videoProcessingQueue,
      (channel, message) => channel.ack(message),
    );

    expect(received).toEqual(payload);
    expect(message.properties.deliveryMode).toBe(2);
  });

  it('redelivers an unacknowledged message once the consuming channel closes (durability)', async () => {
    const payload = {
      videoId: 'video-2',
      publicId: 'public-2',
      storageKey: 'videos/video-2/original.mp4',
    };
    await queueService.publishVideoProcessingRequested(payload);

    // Receive the message but deliberately do not ack it — closing the
    // connection right after should cause RabbitMQ to requeue it.
    await receiveOne(config.videoProcessingQueue, () => undefined);

    const { payload: redelivered, message } = await receiveOne(
      config.videoProcessingQueue,
      (channel, message) => channel.ack(message),
    );

    expect(redelivered).toEqual(payload);
    expect(message.fields.redelivered).toBe(true);
  });

  it('routes a rejected message to the dead-letter queue', async () => {
    const payload = {
      videoId: 'video-3',
      publicId: 'public-3',
      storageKey: 'videos/video-3/original.mp4',
    };
    await queueService.publishVideoProcessingRequested(payload);

    const { payload: received } = await receiveOne(
      config.videoProcessingQueue,
      (channel, message) => channel.nack(message, false, false),
    );
    expect(received).toEqual(payload);

    const { payload: deadLettered } = await receiveOne(
      deadLetterQueue,
      (channel, message) => channel.ack(message),
    );
    expect(deadLettered).toEqual(payload);
  });
});
