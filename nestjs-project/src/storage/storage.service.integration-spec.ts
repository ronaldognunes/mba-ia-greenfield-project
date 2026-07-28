import { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { ensureBucketExists } from '../test/minio';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let storageService: StorageService;

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

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storageService = module.get(StorageService);
  });

  function uniqueKey(suffix: string): string {
    return `test/${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`;
  }

  async function uploadSinglePart(
    key: string,
    uploadId: string,
    body: string,
  ): Promise<string> {
    const [part] = await storageService.getPresignedPartUrls(key, uploadId, 1);
    const response = await fetch(part.url, { method: 'PUT', body });
    const eTag = response.headers.get('etag');
    if (!eTag) {
      throw new Error('MinIO did not return an ETag for the uploaded part');
    }
    return eTag;
  }

  it('createMultipartUpload followed by getPresignedPartUrls returns URLs accepted by a direct PUT to MinIO', async () => {
    const key = uniqueKey('put.txt');
    const { uploadId } = await storageService.createMultipartUpload(
      key,
      'text/plain',
    );

    const [part] = await storageService.getPresignedPartUrls(key, uploadId, 1);
    const putResponse = await fetch(part.url, {
      method: 'PUT',
      body: 'hello from a presigned part url',
    });

    expect(putResponse.ok).toBe(true);
    expect(putResponse.headers.get('etag')).toBeTruthy();

    await storageService.abortMultipartUpload(key, uploadId);
  });

  it('completeMultipartUpload finalizes the object in the configured bucket', async () => {
    const key = uniqueKey('complete.txt');
    const content = 'the full object body';
    const { uploadId } = await storageService.createMultipartUpload(
      key,
      'text/plain',
    );
    const eTag = await uploadSinglePart(key, uploadId, content);

    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag },
    ]);

    const getUrl = await storageService.getPresignedGetUrl(key);
    const getResponse = await fetch(getUrl);

    expect(getResponse.ok).toBe(true);
    expect(await getResponse.text()).toBe(content);
  });

  it('getPresignedGetUrl with contentDisposition: attachment generates a URL whose GET returns the content-disposition header', async () => {
    const key = uniqueKey('thumbnail.jpg');
    const { uploadId } = await storageService.createMultipartUpload(key);
    const eTag = await uploadSinglePart(key, uploadId, 'fake-thumbnail-bytes');
    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag },
    ]);

    const url = await storageService.getPresignedGetUrl(key, {
      contentDisposition: 'attachment; filename="thumbnail.jpg"',
    });
    const response = await fetch(url);

    expect(response.ok).toBe(true);
    expect(response.headers.get('content-disposition')).toContain('attachment');
  });
});
