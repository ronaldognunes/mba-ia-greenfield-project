import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { envValidationSchema } from './env.validation';
import queueConfig from './queue.config';
import storageConfig from './storage.config';

const ENV_KEYS = [
  'STORAGE_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_BUCKET',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
  'STORAGE_FORCE_PATH_STYLE',
  'QUEUE_URL',
  'QUEUE_VIDEO_PROCESSING_NAME',
] as const;

const loadConfig = async (
  env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
): Promise<{
  storage: ConfigType<typeof storageConfig>;
  queue: ConfigType<typeof queueConfig>;
}> => {
  for (const key of ENV_KEYS) {
    if (env[key] !== undefined) {
      process.env[key] = env[key];
    } else {
      delete process.env[key];
    }
  }

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        load: [storageConfig, queueConfig],
      }),
    ],
  }).compile();

  const storage = module.get<ConfigType<typeof storageConfig>>(
    storageConfig.KEY,
  );
  const queue = module.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  await module.close();
  return { storage, queue };
};

describe('storageConfig', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('should apply defaults when no storage env vars are set', async () => {
    const { storage } = await loadConfig({});
    expect(storage).toEqual({
      endpoint: 'http://minio:9000',
      region: 'us-east-1',
      bucket: 'streamtube-videos',
      accessKeyId: 'streamtube',
      secretAccessKey: 'streamtube',
      forcePathStyle: true,
    });
  });

  it('should read storage values from environment variables', async () => {
    const { storage } = await loadConfig({
      STORAGE_ENDPOINT: 'https://s3.example.com',
      STORAGE_REGION: 'sa-east-1',
      STORAGE_BUCKET: 'my-bucket',
      STORAGE_ACCESS_KEY: 'my-key',
      STORAGE_SECRET_KEY: 'my-secret',
      STORAGE_FORCE_PATH_STYLE: 'false',
    });
    expect(storage).toEqual({
      endpoint: 'https://s3.example.com',
      region: 'sa-east-1',
      bucket: 'my-bucket',
      accessKeyId: 'my-key',
      secretAccessKey: 'my-secret',
      forcePathStyle: false,
    });
  });
});

describe('queueConfig', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('should apply defaults when no queue env vars are set', async () => {
    const { queue } = await loadConfig({});
    expect(queue).toEqual({
      url: 'amqp://streamtube:streamtube@rabbitmq:5672',
      videoProcessingQueue: 'video-processing',
    });
  });

  it('should read queue values from environment variables', async () => {
    const { queue } = await loadConfig({
      QUEUE_URL: 'amqp://user:pass@broker:5672',
      QUEUE_VIDEO_PROCESSING_NAME: 'custom-queue',
    });
    expect(queue).toEqual({
      url: 'amqp://user:pass@broker:5672',
      videoProcessingQueue: 'custom-queue',
    });
  });
});

describe('envValidationSchema — storage/queue', () => {
  const requiredEnv = {
    DB_USERNAME: 'user',
    DB_PASSWORD: 'pass',
    DB_NAME: 'db',
    JWT_SECRET: 'secret',
    JWT_REFRESH_SECRET: 'refresh-secret',
    STORAGE_BUCKET: 'bucket',
    STORAGE_ACCESS_KEY: 'key',
    STORAGE_SECRET_KEY: 'secret',
    QUEUE_URL: 'amqp://guest:guest@rabbitmq:5672',
  };

  const validate = (env: Record<string, string | undefined>) =>
    envValidationSchema.validate(
      { ...requiredEnv, ...env },
      { allowUnknown: true, abortEarly: false },
    );

  it('should fail validation when STORAGE_BUCKET is missing', () => {
    const { error } = validate({ STORAGE_BUCKET: undefined });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_BUCKET');
  });

  it('should fail validation when STORAGE_ACCESS_KEY is missing', () => {
    const { error } = validate({ STORAGE_ACCESS_KEY: undefined });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ACCESS_KEY');
  });

  it('should fail validation when STORAGE_SECRET_KEY is missing', () => {
    const { error } = validate({ STORAGE_SECRET_KEY: undefined });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_SECRET_KEY');
  });

  it('should fail validation when QUEUE_URL is missing', () => {
    const { error } = validate({ QUEUE_URL: undefined });
    expect(error).toBeDefined();
    expect(error!.message).toContain('QUEUE_URL');
  });

  it('should reject STORAGE_FORCE_PATH_STYLE with an invalid value', () => {
    const { error } = validate({ STORAGE_FORCE_PATH_STYLE: 'nope' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_FORCE_PATH_STYLE');
  });

  it('should reject QUEUE_URL with a non-amqp scheme', () => {
    const { error } = validate({ QUEUE_URL: 'https://rabbitmq:5672' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('QUEUE_URL');
  });

  it('should accept a fully valid storage/queue environment', () => {
    const { error } = validate({});
    expect(error).toBeUndefined();
  });
});
