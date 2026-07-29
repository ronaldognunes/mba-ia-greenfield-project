import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { nanoid } from 'nanoid';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  InvalidUploadPartsException,
  UploadAlreadyCompletedException,
  VideoAccessForbiddenException,
  VideoAccessUnauthorizedException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { QueueService } from '../queue/queue.service';
import { STORAGE_DEFAULTS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
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

export interface CompleteUploadResult {
  public_id: string;
  status: 'processing';
}

export interface VideoOwnerRepresentation {
  public_id: string;
  status: Exclude<VideoStatus, 'ready'>;
  error: string | null;
}

export interface VideoPublicRepresentation {
  public_id: string;
  status: 'ready';
  duration_seconds: number;
  stream_url: string;
  download_url: string;
  thumbnail_url: string;
  expires_at: string;
}

export type GetPublicRepresentationResult =
  | VideoOwnerRepresentation
  | VideoPublicRepresentation;

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly queueService: QueueService,
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

  async completeUpload(
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.findDraftUploadOrThrow(publicId);

    if (
      !dto.parts ||
      dto.parts.length === 0 ||
      dto.upload_id !== video.upload_id
    ) {
      throw new InvalidUploadPartsException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key!,
        video.upload_id,
        dto.parts.map((part) => ({
          partNumber: part.part_number,
          eTag: part.e_tag,
        })),
      );
    } catch {
      throw new InvalidUploadPartsException();
    }

    video.status = 'processing';
    await this.videoRepository.save(video);

    await this.queueService.publishVideoProcessingRequested({
      videoId: video.id,
      publicId: video.public_id,
      storageKey: video.storage_key!,
    });

    return { public_id: video.public_id, status: 'processing' };
  }

  async abortUpload(publicId: string): Promise<void> {
    const video = await this.findDraftUploadOrThrow(publicId);

    await this.storageService.abortMultipartUpload(
      video.storage_key!,
      video.upload_id!,
    );

    await this.videoRepository.remove(video);
  }

  async getPublicRepresentation(
    publicId: string,
    requestingUserId?: string,
  ): Promise<GetPublicRepresentationResult> {
    const video = await this.assertOwnershipOrPublicAccess(
      publicId,
      requestingUserId,
    );

    if (video.status === 'ready') {
      return this.buildPublicRepresentation(video);
    }

    const metadata = video.metadata as { error?: string } | null;
    return {
      public_id: video.public_id,
      status: video.status,
      error: video.status === 'failed' ? (metadata?.error ?? null) : null,
    };
  }

  async assertOwnershipOrPublicAccess(
    publicId: string,
    requestingUserId?: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOneBy({
      public_id: publicId,
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.status === 'ready') {
      return video;
    }

    if (!requestingUserId) {
      throw new VideoAccessUnauthorizedException();
    }

    const channel = await this.channelsService.findByUserId(requestingUserId);
    if (!channel || channel.id !== video.channel_id) {
      throw new VideoAccessForbiddenException();
    }

    return video;
  }

  private async buildPublicRepresentation(
    video: Video,
  ): Promise<VideoPublicRepresentation> {
    if (
      !video.storage_key ||
      !video.thumbnail_key ||
      video.duration_seconds === null
    ) {
      throw new Error(
        `Video "${video.public_id}" is ready but missing storage_key/thumbnail_key/duration_seconds`,
      );
    }

    const [streamUrl, downloadUrl, thumbnailUrl] = await Promise.all([
      this.storageService.getPresignedGetUrl(video.storage_key),
      this.storageService.getPresignedGetUrl(video.storage_key, {
        contentDisposition: 'attachment',
      }),
      this.storageService.getPresignedGetUrl(video.thumbnail_key),
    ]);

    return {
      public_id: video.public_id,
      status: 'ready',
      duration_seconds: video.duration_seconds,
      stream_url: streamUrl,
      download_url: downloadUrl,
      thumbnail_url: thumbnailUrl,
      expires_at: new Date(
        Date.now() + STORAGE_DEFAULTS.PRESIGNED_URL_EXPIRES_IN_SECONDS * 1000,
      ).toISOString(),
    };
  }

  private async findDraftUploadOrThrow(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({
      public_id: publicId,
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== 'draft') {
      throw new UploadAlreadyCompletedException();
    }
    if (!video.storage_key || !video.upload_id) {
      throw new Error(
        `Video "${publicId}" is missing storage_key/upload_id required to finalize the upload`,
      );
    }
    return video;
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
