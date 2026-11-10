import express from 'express';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config.js';
import { s3, incomingKey, cleanKey } from './s3.js';
import { createFile, getFileForUser, transition } from './db.js';
import { streamingS3Storage } from './stream-storage.js';
import { validateFilenameAndType, validateClaimedSize, validateSha256, validateUserId } from './validation.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// DEMONSTRATION ONLY. Replace this header with verified JWT/session auth in production.
app.use((req, res, next) => {
  try { req.user = { id: validateUserId(req.get('x-user-id')) }; next(); }
  catch (err) { next(err); }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Flow 1: Client -> signed POST form -> S3, without sending file bytes to Express.
app.post('/files/sign-upload', async (req, res, next) => {
  try {
    const { filename, contentType } = validateFilenameAndType(req.body.filename, req.body.contentType);
    const fileSize = validateClaimedSize(req.body.fileSize, config.maxBytes);
    const sha256 = validateSha256(req.body.sha256);
    const id = randomUUID();
    const key = incomingKey(req.user.id, id);
    createFile({
      id, user_id: req.user.id, original_name: filename, content_type: contentType,
      expected_size: fileSize, expected_sha256: sha256, incoming_key: key,
      status: 'PENDING_UPLOAD',
    });
    // POST policy length covers the entire multipart form, not only file bytes;
    // add modest space for the signed form fields; HEAD then checks exact object size.
    const signed = await createPresignedPost(s3, {
      Bucket: config.bucket,
      Key: key,
      Expires: 120,
      Fields: { key, 'Content-Type': contentType },
      Conditions: [['content-length-range', 1, config.maxBytes + 64 * 1024]],
    });
    res.status(201).json({ fileId: id, uploadUrl: signed.url, fields: signed.fields, expiresIn: 120 });
  } catch (err) { next(err); }
});

// Optional learning comparison: PUT signed URL with checksum and type headers.
// A signed PUT URL alone is NOT a hard file-size enforcement mechanism.
app.post('/files/sign-put', async (req, res, next) => {
  try {
    const { filename, contentType } = validateFilenameAndType(req.body.filename, req.body.contentType);
    const fileSize = validateClaimedSize(req.body.fileSize, config.maxBytes);
    const sha256 = validateSha256(req.body.sha256);
    const id = randomUUID();
    const key = incomingKey(req.user.id, id);
    const checksumBase64 = Buffer.from(sha256, 'hex').toString('base64');
    createFile({ id, user_id: req.user.id, original_name: filename,
      content_type: contentType, expected_size: fileSize,
      expected_sha256: sha256, incoming_key: key, status: 'PENDING_UPLOAD' });
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
      Bucket: config.bucket, Key: key,
      ContentType: contentType, ChecksumSHA256: checksumBase64,
    }), {
      expiresIn: 120,
      signableHeaders: new Set(['content-type']),
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
    });
    res.status(201).json({ fileId: id, uploadUrl, method: 'PUT',
      headers: { 'Content-Type': contentType, 'x-amz-checksum-sha256': checksumBase64 },
      expiresIn: 120 });
  } catch (err) { next(err); }
});

// POST is an upload policy, not a final acceptance decision. Confirm via S3 HEAD.
app.post('/files/:id/complete', async (req, res, next) => {
  try {
    const file = getFileForUser(req.params.id, req.user.id);
    if (!file) return res.status(404).json({ error: 'Not found' });
    if (file.status !== 'PENDING_UPLOAD') return res.status(409).json({ error: 'Not awaiting upload' });
    const object = await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: file.incoming_key }));
    const mismatch = object.ContentLength !== file.expected_size ||
      object.ContentType !== file.content_type;
    if (!transition(file.id, 'PENDING_UPLOAD', 'UPLOADED', { version_id: object.VersionId || null })) {
      return res.status(409).json({ error: 'Already submitted' });
    }
    // Even failed verification enters isolated scanner path to be quarantined.
    if (mismatch) {
      return res.status(422).json({ error: 'Uploaded size/type mismatches request',
        status: 'UPLOADED', next: 'Scanner will quarantine if verification fails' });
    }
    res.status(202).json({ fileId: file.id, status: 'UPLOADED', next: 'Scanner worker will process the file' });
  } catch (err) { next(err); }
});

// Flow 2: Client -> Express Multer custom engine -> streamed to S3.
const upload = multer({
  storage: streamingS3Storage,
  limits: { fileSize: config.maxBytes, files: 1, fields: 0, parts: 1, fieldSize: 1024 },
  fileFilter(req, file, cb) {
    try { validateFilenameAndType(file.originalname, file.mimetype); cb(null, true); }
    catch (err) { cb(err); }
  },
});
app.post('/files/stream', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Provide a file field' });
    createFile({
      id: req.file.id, user_id: req.user.id, original_name: req.file.originalname,
      content_type: req.file.mimetype, expected_size: req.file.size,
      expected_sha256: req.file.sha256, incoming_key: req.file.key, status: 'UPLOADED',
    });
    res.status(202).json({ fileId: req.file.id, status: 'UPLOADED', sha256: req.file.sha256 });
  } catch (err) {
    if (req.file?.key) await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: req.file.key })).catch(() => {});
    next(err);
  }
});

app.get('/files/:id', (req, res) => {
  const file = getFileForUser(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json({
    fileId: file.id, filename: file.original_name, contentType: file.content_type,
    size: file.expected_size, sha256: file.expected_sha256, status: file.status,
    reason: file.reason, createdAt: file.created_at,
  });
});

app.get('/files/:id/download-url', async (req, res, next) => {
  try {
    const file = getFileForUser(req.params.id, req.user.id);
    if (!file) return res.status(404).json({ error: 'Not found' });
    if (file.status !== 'READY' || !file.clean_key) {
      return res.status(409).json({ error: 'File is not approved for download' });
    }
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: config.bucket, Key: file.clean_key,
      ResponseContentDisposition: `attachment; filename="${file.original_name}"`,
    }), { expiresIn: 60 });
    res.json({ downloadUrl: url, expiresIn: 60 });
  } catch (err) { next(err); }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err instanceof multer.MulterError
    ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
    : (err.status || (err.message === 'FILE_TOO_LARGE' ? 413 : 500));
  if (status >= 500) console.error('Request failed:', err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

app.listen(config.port, () => {
  console.log(`Upload practice API: http://localhost:${config.port}`);
  console.log('Demo auth: include X-User-Id: user-alice in all requests');
});
