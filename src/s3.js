import { S3Client } from '@aws-sdk/client-s3';
import { config } from './config.js';

// AWS SDK standard credential provider chain: local AWS CLI profile or IAM role.
export const s3 = new S3Client({ region: config.region });
export function incomingKey(userId, fileId) {
  return `incoming/${userId}/${fileId}`; // no user-supplied pathname
}
export function cleanKey(userId, fileId) {
  return `clean/${userId}/${fileId}`;
}
export function quarantineKey(userId, fileId) {
  return `quarantine/${userId}/${fileId}`;
}
export function sourceForCopy(key, versionId) {
  const base = `${config.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  return versionId ? `${base}?versionId=${encodeURIComponent(versionId)}` : base;
}
