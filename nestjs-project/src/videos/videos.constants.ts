export const VIDEO_UPLOAD_LIMITS = {
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024 * 1024, // 10GB, per phase-03-upload-processing/TD-04
  PART_SIZE_BYTES: 16 * 1024 * 1024, // 16MB per part — within TD-04's suggested 8-64MB range
  MAX_PUBLIC_ID_RETRIES: 5,
} as const;

export function buildOriginalStorageKey(publicId: string): string {
  return `videos/${publicId}/original`;
}
