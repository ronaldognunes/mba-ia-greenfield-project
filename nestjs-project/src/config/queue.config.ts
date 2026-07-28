import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  url: process.env.QUEUE_URL || 'amqp://streamtube:streamtube@rabbitmq:5672',
  videoProcessingQueue:
    process.env.QUEUE_VIDEO_PROCESSING_NAME || 'video-processing',
}));
