import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config.js';
import { s3 } from './s3.js';
import { db, transition } from './db.js';

// OPTIONAL AWS event hook: S3 ObjectCreated (incoming/ prefix) -> SQS -> this worker.
// Never expose this handler as a public unauthenticated webhook.
const queueUrl = process.env.SQS_QUEUE_URL;
if (!queueUrl) throw new Error('Set SQS_QUEUE_URL in .env');
const sqs = new SQSClient({ region: config.region });

async function processS3Notification(body) {
  const decoded = JSON.parse(body);
  const payload = decoded.Message ? JSON.parse(decoded.Message) : decoded;
  for (const event of payload.Records || []) {
    if (!event.eventName?.startsWith('ObjectCreated:')) continue;
    if (event.s3?.bucket?.name !== config.bucket) continue;
    const key = decodeURIComponent(event.s3.object.key.replace(/\+/g, ' '));
    if (!key.startsWith('incoming/')) continue;
    const file = db.prepare('SELECT * FROM files WHERE incoming_key = ?').get(key);
    if (!file || file.status !== 'PENDING_UPLOAD') continue; // safe on duplicate events

    // Bind the event to a specific immutable object version where available.
    const incomingVersion = event.s3.object.versionId;
    const object = await s3.send(new HeadObjectCommand({
      Bucket: config.bucket, Key: key,
      ...(incomingVersion ? { VersionId: incomingVersion } : {}),
    }));
    // Move to UPLOADED even on size/MIME mismatch: the scanner will quarantine it.
    // A malicious file must never be treated as READY just because S3 emitted an event.
    transition(file.id, 'PENDING_UPLOAD', 'UPLOADED', {
      version_id: incomingVersion || object.VersionId || null,
    });
    console.log('Queued via S3 event:', file.id);
  }
}

async function main() {
  console.log('S3 -> SQS event worker started');
  while (true) {
    try {
      const result = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl, WaitTimeSeconds: 20, MaxNumberOfMessages: 5,
        VisibilityTimeout: 120,
      }));
      for (const message of result.Messages || []) {
        try {
          await processS3Notification(message.Body);
          await sqs.send(new DeleteMessageCommand({
            QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle,
          }));
        } catch (err) {
          console.error('Message failed (SQS will retry):', err);
        }
      }
    } catch (err) {
      console.error('SQS poll error:', err);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
