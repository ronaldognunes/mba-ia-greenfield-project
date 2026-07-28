import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { nanoid } from 'nanoid';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { FileTooLargeException } from '../common/exceptions/domain.exception';
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
  };
  const channelsServiceMock = { findByUserId: jest.fn() };
  const storageServiceMock = {
    createMultipartUpload: jest.fn(),
    getPresignedPartUrls: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    (nanoid as jest.Mock).mockReset();

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepositoryMock },
        { provide: ChannelsService, useValue: channelsServiceMock },
        { provide: StorageService, useValue: storageServiceMock },
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
});
