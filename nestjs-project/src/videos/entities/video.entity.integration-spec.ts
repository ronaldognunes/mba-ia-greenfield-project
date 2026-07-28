import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const suffix = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${suffix}`,
        nickname: `chan${suffix}`,
        user_id: user.id,
      }),
    );
  }

  it('should enforce unique public_id constraint', async () => {
    const channel1 = await createChannel();
    const channel2 = await createChannel();

    await videoRepository.save(
      videoRepository.create({
        public_id: 'dup-public-id',
        channel_id: channel1.id,
        original_filename: 'first.mp4',
        file_size_bytes: '1024',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: 'dup-public-id',
          channel_id: channel2.id,
          original_filename: 'second.mp4',
          file_size_bytes: '2048',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should default status to draft when not explicitly set', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        public_id: 'default-status-id',
        channel_id: channel.id,
        original_filename: 'no-status.mp4',
        file_size_bytes: '4096',
      }),
    );

    expect(video.status).toBe('draft');
  });

  it('should violate the FK constraint when channel_id does not exist', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: 'orphan-video-id',
          channel_id: '00000000-0000-0000-0000-000000000000',
          original_filename: 'orphan.mp4',
          file_size_bytes: '512',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        public_id: 'relation-video-id',
        channel_id: channel.id,
        original_filename: 'related.mp4',
        file_size_bytes: '8192',
      }),
    );

    const found = await videoRepository.findOne({
      where: { public_id: 'relation-video-id' },
      relations: ['channel'],
    });

    expect(found?.channel.nickname).toBe(channel.nickname);
  });
});
