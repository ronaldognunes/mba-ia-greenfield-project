import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { JwtPayload } from '../../auth/auth.types';
import { VideosService } from '../videos.service';

interface RequestWithOwnershipContext {
  params: Record<string, string>;
  user?: JwtPayload;
}

@Injectable()
export class VideoOwnershipGuard implements CanActivate {
  constructor(private readonly videosService: VideosService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<RequestWithOwnershipContext>();
    const publicId = request.params.publicId;
    if (!publicId) {
      return true;
    }

    await this.videosService.assertOwnershipOrPublicAccess(
      publicId,
      request.user?.sub,
    );
    return true;
  }
}
