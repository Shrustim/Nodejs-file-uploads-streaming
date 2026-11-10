import { randomUUID, createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { Upload } from '@aws-sdk/lib-storage';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { s3, incomingKey } from './s3.js';
import { config } from './config.js';

// Multer storage-engine API: Multer provides a streaming file.stream.
// The AWS Upload helper uses bounded multipart buffers rather than loading the entire file.
export const streamingS3Storage = {
  _handleFile(req, file, cb) {
    const id = randomUUID();
    const key = incomingKey(req.user.id, id);
    const sha = createHash('sha256');
    let size = 0;
    let exceeded = false;
    const meter = new Transform({
      transform(chunk, encoding, done) {
        size += chunk.length;
        sha.update(chunk);
        if (size > config.maxBytes) {
          exceeded = true;
          done(new Error('FILE_TOO_LARGE'));
        } else {
          done(null, chunk);
        }
      },
    });
    file.stream.on('limit', () => {
      exceeded = true;
      meter.destroy(new Error('FILE_TOO_LARGE'));
    });
    const body = file.stream.pipe(meter);
    const upload = new Upload({
      client: s3,
      params: { Bucket: config.bucket, Key: key, Body: body, ContentType: file.mimetype },
      queueSize: 2,
      partSize: 5 * 1024 * 1024,
      leavePartsOnError: false,
    });
    req.once('aborted', () => { void upload.abort().catch(() => {}); });
    upload.done()
      .then(() => {
        if (exceeded || file.stream.truncated || size === 0) {
          return s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
            .then(() => cb(new Error('Empty or oversized file')));
        }
        cb(null, { id, key, size, sha256: sha.digest('hex') });
      })
      .catch(err => cb(err));
  },
  _removeFile(req, file, cb) {
    if (!file.key) return cb(null);
    s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: file.key }))
      .then(() => cb(null), cb);
  },
};
