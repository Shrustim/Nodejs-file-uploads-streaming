import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
  region: process.env.AWS_REGION || 'ap-south-1',
  bucket: process.env.S3_BUCKET,
  dbPath: process.env.SQLITE_PATH || './data/files.db',
  maxBytes: Math.floor(Number(process.env.MAX_FILE_MB || 10) * 1024 * 1024),
  clamHost: process.env.CLAMAV_HOST || '127.0.0.1',
  clamPort: Number(process.env.CLAMAV_PORT || 3310),
};
if (!config.bucket) throw new Error('Set S3_BUCKET in .env');
if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes <= 0) {
  throw new Error('MAX_FILE_MB must be a positive number');
}
