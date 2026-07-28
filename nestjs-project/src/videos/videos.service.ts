import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { nanoid } from 'nanoid';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { FileTooLargeException } from '../common/exceptions/domain.exception';
import { STORAGE_DEFAULTS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import {
  buildOriginalStorageKey,
  VIDEO_UPLOAD_LIMITS,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';

interface PostgresDriverError {
  code?: string;
  detail?: string;
}

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driverError = err.driverError as PostgresDriverError;
  return (
    driverError.code === PG_UNIQUE_VIOLATION &&
    typeof driverError.detail === 'string' &&
    driverError.detail.includes(column)
  );
}

export interface CreateDraftAndInitiateUploadResult {
  public_id: string;
  status: 'draft';
  upload_id: string;
  parts: { part_number: number; url: string }[];
  expires_at: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
  ) {}

  async createDraftAndInitiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateDraftAndInitiateUploadResult> {
    if (dto.file_size_bytes > VIDEO_UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES) {
      throw new FileTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`No channel found for authenticated user "${userId}"`);
    }

    const video = await this.saveWithUniquePublicId(channel.id, dto);

    const storageKey = buildOriginalStorageKey(video.public_id);
    const { uploadId } = await this.storageService.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    const partCount = Math.max(
      1,
      Math.ceil(dto.file_size_bytes / VIDEO_UPLOAD_LIMITS.PART_SIZE_BYTES),
    );
    const parts = await this.storageService.getPresignedPartUrls(
      storageKey,
      uploadId,
      partCount,
    );

    video.storage_key = storageKey;
    video.upload_id = uploadId;
    await this.videoRepository.save(video);

    return {
      public_id: video.public_id,
      status: 'draft',
      upload_id: uploadId,
      parts: parts.map((part) => ({
        part_number: part.partNumber,
        url: part.url,
      })),
      expires_at: new Date(
        Date.now() + STORAGE_DEFAULTS.PRESIGNED_URL_EXPIRES_IN_SECONDS * 1000,
      ).toISOString(),
    };
  }

  private async saveWithUniquePublicId(
    channelId: string,
    dto: CreateVideoDto,
  ): Promise<Video> {
    for (
      let attempt = 0;
      attempt <= VIDEO_UPLOAD_LIMITS.MAX_PUBLIC_ID_RETRIES;
      attempt++
    ) {
      const video = this.videoRepository.create({
        public_id: nanoid(),
        channel_id: channelId,
        original_filename: dto.original_filename,
        file_size_bytes: String(dto.file_size_bytes),
      });
      try {
        return await this.videoRepository.save(video);
      } catch (err) {
        const isLastAttempt =
          attempt === VIDEO_UPLOAD_LIMITS.MAX_PUBLIC_ID_RETRIES;
        if (
          !isPgUniqueViolationOnColumn(err, PUBLIC_ID_COLUMN) ||
          isLastAttempt
        ) {
          throw err;
        }
      }
    }

    throw new Error('Could not generate a unique public_id after max retries');
  }
}
