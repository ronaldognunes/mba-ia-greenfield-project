import { VideoProcessorConsumer } from './video-processor.consumer';

describe('VideoProcessorConsumer', () => {
  describe('resolveThumbnailTimestamp', () => {
    it('uses the fixed 00:00:01 timestamp for videos of 2 seconds or longer', () => {
      expect(VideoProcessorConsumer.resolveThumbnailTimestamp(2)).toBe(
        '00:00:01',
      );
      expect(VideoProcessorConsumer.resolveThumbnailTimestamp(120)).toBe(
        '00:00:01',
      );
    });

    it('falls back to duration/2 for videos shorter than 2 seconds', () => {
      expect(VideoProcessorConsumer.resolveThumbnailTimestamp(1)).toBe('0.5');
      expect(VideoProcessorConsumer.resolveThumbnailTimestamp(1.4)).toBe('0.7');
    });
  });
});
