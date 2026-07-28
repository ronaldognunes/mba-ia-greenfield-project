import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { nanoid } from 'nanoid';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  VideoAccessForbiddenException,
  VideoAccessUnauthorizedException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

jest.mock('nanoid', () => ({ nanoid: jest.fn() }));

function makeUniqueViolation(): QueryFailedError {
  const driverError = Object.assign(new Error(), {
    code: '23505',
    detail: 'Key (public_id)=(colliding-id) already exists.',
  });
  return new QueryFailedError('INSERT', [], driverError);
}

describe('VideosService', () => {
  let service: VideosService;

  const dto: CreateVideoDto = {
    original_filename: 'movie.mp4',
    content_type: 'video/mp4',
    file_size_bytes: 1024,
  };

  const videoRepositoryMock = {
    create: jest.fn((data: Partial<Video>) => data as Video),
    save: jest.fn(),
    findOneBy: jest.fn(),
  };
  const channelsServiceMock = { findByUserId: jest.fn() };
  const storageServiceMock = {
    createMultipartUpload: jest.fn(),
    getPresignedPartUrls: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    getPresignedGetUrl: jest.fn(),
  };
  const queueServiceMock = { publishVideoProcessingRequested: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    (nanoid as jest.Mock).mockReset();

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepositoryMock },
        { provide: ChannelsService, useValue: channelsServiceMock },
        { provide: StorageService, useValue: storageServiceMock },
        { provide: QueueService, useValue: queueServiceMock },
      ],
    }).compile();

    service = module.get(VideosService);

    channelsServiceMock.findByUserId.mockResolvedValue({ id: 'channel-1' });
    storageServiceMock.createMultipartUpload.mockResolvedValue({
      uploadId: 'upload-1',
    });
    storageServiceMock.getPresignedPartUrls.mockResolvedValue([
      { partNumber: 1, url: 'https://example.com/part-1' },
    ]);
  });

  describe('createDraftAndInitiateUpload', () => {
    it('retries public_id generation on unique constraint collision', async () => {
      (nanoid as jest.Mock)
        .mockReturnValueOnce('colliding-id')
        .mockReturnValueOnce('fresh-id');

      videoRepositoryMock.save
        .mockRejectedValueOnce(makeUniqueViolation())
        .mockImplementation((video: Video) => Promise.resolve(video));

      const result = await service.createDraftAndInitiateUpload('user-1', dto);

      expect(result.public_id).toBe('fresh-id');
      expect(nanoid).toHaveBeenCalledTimes(2);
      // 1 failed insert + 1 successful insert + 1 update (storage_key/upload_id)
      expect(videoRepositoryMock.save).toHaveBeenCalledTimes(3);
    });

    it('does not touch the repository or storage when the file exceeds the size limit', async () => {
      await expect(
        service.createDraftAndInitiateUpload('user-1', {
          ...dto,
          file_size_bytes: 10 * 1024 * 1024 * 1024 + 1,
        }),
      ).rejects.toBeInstanceOf(FileTooLargeException);

      expect(channelsServiceMock.findByUserId).not.toHaveBeenCalled();
      expect(videoRepositoryMock.save).not.toHaveBeenCalled();
      expect(storageServiceMock.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('propagates non-collision errors without retrying', async () => {
      (nanoid as jest.Mock).mockReturnValue('some-id');
      const unexpectedError = new Error('connection lost');
      videoRepositoryMock.save.mockRejectedValue(unexpectedError);

      await expect(
        service.createDraftAndInitiateUpload('user-1', dto),
      ).rejects.toThrow('connection lost');
      expect(videoRepositoryMock.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPublicRepresentation', () => {
    function makeVideo(overrides: Partial<Video> = {}): Video {
      return {
        public_id: 'vid-1',
        channel_id: 'channel-1',
        status: 'processing',
        storage_key: 'videos/vid-1/original',
        thumbnail_key: 'videos/vid-1/thumbnail.jpg',
        duration_seconds: 120,
        metadata: null,
        ...overrides,
      } as Video;
    }

    it('throws VideoNotFoundException when the video does not exist', async () => {
      videoRepositoryMock.findOneBy.mockResolvedValue(null);

      await expect(
        service.getPublicRepresentation('missing-id'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('returns presigned URLs for a ready video without requiring a caller', async () => {
      videoRepositoryMock.findOneBy.mockResolvedValue(
        makeVideo({ status: 'ready' }),
      );
      storageServiceMock.getPresignedGetUrl
        .mockResolvedValueOnce('https://storage.example.com/stream')
        .mockResolvedValueOnce('https://storage.example.com/download')
        .mockResolvedValueOnce('https://storage.example.com/thumbnail');

      const result = await service.getPublicRepresentation('vid-1');

      if (result.status !== 'ready') {
        throw new Error('expected a ready representation');
      }
      expect(result.public_id).toBe('vid-1');
      expect(result.duration_seconds).toBe(120);
      expect(result.stream_url).toBe('https://storage.example.com/stream');
      expect(result.download_url).toBe('https://storage.example.com/download');
      expect(result.thumbnail_url).toBe(
        'https://storage.example.com/thumbnail',
      );
      expect(typeof result.expires_at).toBe('string');
      expect(storageServiceMock.getPresignedGetUrl).toHaveBeenCalledTimes(3);
      expect(channelsServiceMock.findByUserId).not.toHaveBeenCalled();
    });

    it('throws VideoAccessUnauthorizedException for a non-ready video with no caller', async () => {
      videoRepositoryMock.findOneBy.mockResolvedValue(
        makeVideo({ status: 'processing' }),
      );

      await expect(
        service.getPublicRepresentation('vid-1'),
      ).rejects.toBeInstanceOf(VideoAccessUnauthorizedException);
    });

    it('throws VideoAccessForbiddenException when the caller does not own the video', async () => {
      videoRepositoryMock.findOneBy.mockResolvedValue(
        makeVideo({ status: 'processing', channel_id: 'channel-1' }),
      );
      channelsServiceMock.findByUserId.mockResolvedValue({
        id: 'channel-2',
      });

      await expect(
        service.getPublicRepresentation('vid-1', 'user-2'),
      ).rejects.toBeInstanceOf(VideoAccessForbiddenException);
    });

    it('returns the owner status representation for the owning caller', async () => {
      videoRepositoryMock.findOneBy.mockResolvedValue(
        makeVideo({ status: 'processing', channel_id: 'channel-1' }),
      );
      channelsServiceMock.findByUserId.mockResolvedValue({
        id: 'channel-1',
      });

      const result = await service.getPublicRepresentation('vid-1', 'user-1');

      expect(result).toEqual({
        public_id: 'vid-1',
        status: 'processing',
        error: null,
      });
    });

    it('surfaces the failure reason from metadata when status is failed', async () => {
      videoRepositoryMock.findOneBy.mockResolvedValue(
        makeVideo({
          status: 'failed',
          channel_id: 'channel-1',
          metadata: { error: 'ffmpeg exited with code 1' },
        }),
      );
      channelsServiceMock.findByUserId.mockResolvedValue({
        id: 'channel-1',
      });

      const result = await service.getPublicRepresentation('vid-1', 'user-1');

      expect(result).toEqual({
        public_id: 'vid-1',
        status: 'failed',
        error: 'ffmpeg exited with code 1',
      });
    });
  });
});
