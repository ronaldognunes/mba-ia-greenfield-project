import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import amqp from 'amqp-connection-manager';
import type {
  AmqpConnectionManager,
  ChannelWrapper,
} from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import queueConfig from '../config/queue.config';
import { QUEUE_TOPOLOGY_SUFFIXES } from './queue.constants';

export interface VideoProcessingRequestedPayload {
  videoId: string;
  publicId: string;
  storageKey: string;
}

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private connection: AmqpConnectionManager;
  private channelWrapper: ChannelWrapper;

  constructor(
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connection = amqp.connect([this.config.url]);
    this.channelWrapper = this.connection.createChannel({
      json: true,
      setup: (channel: ConfirmChannel) => this.assertTopology(channel),
    });
    await this.channelWrapper.waitForConnect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.channelWrapper.close();
    await this.connection.close();
  }

  async publishVideoProcessingRequested(
    payload: VideoProcessingRequestedPayload,
  ): Promise<void> {
    await this.channelWrapper.sendToQueue(
      this.config.videoProcessingQueue,
      payload,
      { persistent: true },
    );
  }

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
