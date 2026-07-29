import { ExecutionContext } from '@nestjs/common';
import { VideoAccessForbiddenException } from '../../common/exceptions/domain.exception';
import { VideosService } from '../videos.service';
import { VideoOwnershipGuard } from './video-ownership.guard';

describe('VideoOwnershipGuard', () => {
  let guard: VideoOwnershipGuard;
  const videosServiceMock = { assertOwnershipOrPublicAccess: jest.fn() };

  function makeContext(params: Record<string, string>, user?: unknown) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ params, user }),
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new VideoOwnershipGuard(
      videosServiceMock as unknown as VideosService,
    );
  });

  it('allows the request without querying VideosService when the route has no publicId param', async () => {
    const result = await guard.canActivate(makeContext({}));

    expect(result).toBe(true);
    expect(
      videosServiceMock.assertOwnershipOrPublicAccess,
    ).not.toHaveBeenCalled();
  });

  it('bypasses the ownership check for a caller-less request when the video allows public access (status: ready)', async () => {
    videosServiceMock.assertOwnershipOrPublicAccess.mockResolvedValue({});

    const result = await guard.canActivate(
      makeContext({ publicId: 'vid-1' }, undefined),
    );

    expect(result).toBe(true);
    expect(
      videosServiceMock.assertOwnershipOrPublicAccess,
    ).toHaveBeenCalledWith('vid-1', undefined);
  });

  it('delegates the caller id to VideosService for an authenticated request', async () => {
    videosServiceMock.assertOwnershipOrPublicAccess.mockResolvedValue({});

    await guard.canActivate(
      makeContext({ publicId: 'vid-1' }, { sub: 'user-1' }),
    );

    expect(
      videosServiceMock.assertOwnershipOrPublicAccess,
    ).toHaveBeenCalledWith('vid-1', 'user-1');
  });

  it('propagates the exception thrown by VideosService for a non-owner caller', async () => {
    videosServiceMock.assertOwnershipOrPublicAccess.mockRejectedValue(
      new VideoAccessForbiddenException(),
    );

    await expect(
      guard.canActivate(makeContext({ publicId: 'vid-1' }, { sub: 'user-2' })),
    ).rejects.toBeInstanceOf(VideoAccessForbiddenException);
  });
});
