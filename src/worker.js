import net from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config.js';
import { db, nextUploaded, transition } from './db.js';
import { s3, cleanKey, quarantineKey, sourceForCopy } from './s3.js';

function connectToClamAV() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.clamHost, port: config.clamPort });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function writeChunk(socket, chunk) {
  if (!socket.write(chunk)) await once(socket, 'drain');
}

// ClamAV clamd INSTREAM: zINSTREAM\0, then 4-byte BE length + chunk, end length 0.
// Read the same S3 stream once, while calculating SHA-256, size and file signature.
async function inspectAndScan(readable) {
  const socket = await connectToClamAV();
  socket.setTimeout(90_000, () => socket.destroy(new Error('ClamAV timeout')));
  let prefix = Buffer.alloc(0);
  let bytes = 0;
  const hash = createHash('sha256');
  let response = '';
  const verdict = new Promise((resolve, reject) => {
    socket.on('data', data => {
      response += data.toString('utf8');
      if (response.length > 4096) { reject(new Error('Unexpected ClamAV response')); return; }
      const nul = response.indexOf('\0');
      if (nul !== -1) resolve(response.slice(0, nul));
    });
    socket.once('error', reject);
    socket.once('close', () => {
      if (!response.includes('\0')) reject(new Error('ClamAV connection closed before verdict'));
    });
  });
  // Mark promise rejection as handled even if an earlier streaming error occurs.
  void verdict.catch(() => {});
  try {
    await writeChunk(socket, Buffer.from('zINSTREAM\0'));
    for await (const data of readable) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      bytes += chunk.length;
      if (bytes > config.maxBytes) throw new Error('File exceeds configured maximum');
      hash.update(chunk);
      if (prefix.length < 4100) prefix = Buffer.concat([prefix, chunk.subarray(0, 4100 - prefix.length)]);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(chunk.length);
      await writeChunk(socket, length);
      await writeChunk(socket, chunk);
    }
    await writeChunk(socket, Buffer.alloc(4));
    const scanReply = await verdict;
    const detected = await fileTypeFromBuffer(prefix);
    return { bytes, sha256: hash.digest('hex'), detectedMime: detected?.mime, scanReply };
  } finally {
    socket.destroy();
    // If the stream failed early, consume no additional data or memory.
    readable.destroy();
  }
}

async function copyTo(row, destinationKey) {
  await s3.send(new CopyObjectCommand({
    Bucket: config.bucket,
    Key: destinationKey,
    CopySource: sourceForCopy(row.incoming_key, row.version_id),
  }));
  // This hides the incoming key's current version. Versioned originals are later
  // removed by S3 lifecycle retention rules; don't expose incoming/ via the API.
  await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: row.incoming_key }));
}

async function quarantine(row, reason, state = 'QUARANTINED') {
  const target = quarantineKey(row.user_id, row.id);
  try {
    await copyTo(row, target);
    transition(row.id, 'SCANNING', state, { quarantine_key: target, reason: reason.slice(0, 500) });
  } catch (err) {
    console.error(`Could not copy ${row.id} into quarantine:`, err);
    transition(row.id, 'SCANNING', 'SCAN_ERROR', { reason: 'Quarantine operation failed; incoming file remains private' });
  }
}

async function processRow(row) {
  // Atomic status transition guards against multiple workers taking the same file.
  if (!transition(row.id, 'UPLOADED', 'SCANNING')) return;
  try {
    const object = await s3.send(new GetObjectCommand({
      Bucket: config.bucket, Key: row.incoming_key,
      ...(row.version_id ? { VersionId: row.version_id } : {}),
    }));
    const result = await inspectAndScan(object.Body);
    const valid = result.bytes === row.expected_size &&
      result.sha256 === row.expected_sha256 &&
      result.detectedMime === row.content_type;
    if (!valid) {
      await quarantine(row, 'File byte count, SHA-256 or actual type failed verification');
      return;
    }
    if (!/^stream: OK$/i.test(result.scanReply)) {
      if (/FOUND$/i.test(result.scanReply)) {
        await quarantine(row, 'ClamAV detected suspicious content');
      } else {
        await quarantine(row, `ClamAV did not return a clean verdict: ${result.scanReply}`, 'SCAN_ERROR');
      }
      return;
    }
    const target = cleanKey(row.user_id, row.id);
    await copyTo(row, target);
    transition(row.id, 'SCANNING', 'READY', { clean_key: target, reason: null });
    console.log('READY', row.id);
  } catch (err) {
    console.error('Scan failed', row.id, err.message);
    await quarantine(row, `Scan failure: ${err.message}`, 'SCAN_ERROR');
  }
}

async function main() {
  console.log('Scanner worker running; querying uploaded files every 3 seconds');
  // After an unexpected process termination, a SCANNING record remains blocked.
  // For this single-worker demo, recover those records at startup. In a production
  // multi-worker system use a leased claim/heartbeat and bounded retries instead.
  db.prepare("UPDATE files SET status = 'UPLOADED' WHERE status = 'SCANNING'").run();
  while (true) {
    try {
      const next = nextUploaded();
      if (next) await processRow(next);
      else await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (err) {
      console.error('Worker error:', err);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
