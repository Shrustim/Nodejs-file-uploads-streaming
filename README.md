# Task 14 — File Uploads & Streaming (Node.js + Express + Amazon S3)

Practice-ready backend using **presigned POST**, **presigned GET**, **streaming multipart upload**, **file type/size/hash verification**, **ClamAV hook**, **quarantine**, **S3 key segregation**, and **optional S3 ObjectCreated → SQS events**.

> **Learning project, not a drop-in production service.** It intentionally uses an `X-User-Id` demo header rather than actual authentication; replace it with verified JWT/session auth. The SQLite file is a simple single-machine status store; use a shared durable database and worker leases in production. Do not deploy with this demo auth. Do not make the bucket public. AWS service charges may apply.

## 1. Learn the two flows

**Flow A: Direct S3 (default for apps)**

```
Client -> POST /files/sign-upload -> signed S3 POST form
Client -> POST file directly to S3 incoming/
Client -> POST /files/:id/complete (or S3 ObjectCreated -> SQS worker)
Scanner worker -> downloads one exact S3 object version -> checks SHA-256, size, magic bytes, ClamAV
                   -> copy into clean/ or quarantine/ -> status READY or blocked
Client -> GET /files/:id/download-url -> short lived S3 GET URL (READY only)
```

**Flow B: Server streaming (when API must receive multipart)**

```
Client -> multipart POST /files/stream
Multer custom storage -> file.stream -> bounded AWS multipart Upload -> incoming/
Scan worker -> clean/ or quarantine/
```

A successful S3 transfer is **not** proof of file safety. Only `READY` gets a download URL.

## 2. Requirements

- Node.js 22+ and npm.
- An AWS account with IAM access, AWS CLI, and a dedicated private S3 bucket.
- Docker Desktop (optional, to run ClamAV locally). Use Docker Desktop with enough available memory for signature databases.
- Postman for testing.
- Two or three terminal windows for API, scanning worker, optional event listener.

## 3. Install project

From a PowerShell terminal:

```powershell
cd nodejs-file-uploads-streaming-practice
npm install
Copy-Item .env.example .env
```

Fill in the `.env` fields (`S3_BUCKET` and `AWS_REGION` at minimum). Example:

```dotenv
PORT=3000
AWS_REGION=ap-south-1
S3_BUCKET=my-private-upload-practice-unique-name
SQLITE_PATH=./data/files.db
MAX_FILE_MB=10
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310
```

Do not commit `.env` if it includes sensitive values. **Use an IAM role for deployed AWS services** rather than a static access key embedded in source code.

## 4. Configure AWS CLI credentials (local only)

Install [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), create a development IAM identity with the minimal permissions below, then:

```powershell
aws configure
aws sts get-caller-identity
```

Choose the correct region (for example `ap-south-1`). The JS AWS SDK automatically uses the standard AWS credentials provider chain. The first command prompts for access key, secret key, region and output format. For production, prefer IAM roles or short-lived credentials.

## 5. Create S3 bucket

AWS Console > S3 > Create bucket:

1. Choose a globally unique name and the same AWS region as `.env`.
2. Keep **Block all public access enabled**.
3. Keep **ACLs disabled** and use Bucket owner enforced.
4. **Enable bucket versioning**. This matters: a presigned POST can be reused before expiry and upload a different version of the same key; scanning must target the exact version it validated.
5. Keep default server-side encryption enabled (SSE-S3 is sufficient for this practice).
6. Create the bucket. Do **not** configure static website/public-read access.
7. Configure a lifecycle rule that deletes expired noncurrent incoming objects, abandoned uploads and old quarantine items according to the retention policy you choose (e.g. 7–30 days). Configure AbortIncompleteMultipartUpload for incomplete multipart uploads.

The code writes to three logical prefixes; you do not need to create directories first:

```
incoming/user-alice/UUID     # untrusted
clean/user-alice/UUID        # scan approved
quarantine/user-alice/UUID   # rejected / unavailable
```

### IAM policy

Use `docs/iam-example.json` as a learning example. Replace all `REPLACE_BUCKET` placeholders with your bucket name. Attach it to the API/worker IAM principal. Separate roles for signing, scanning and downloading are recommended in production; only the scanner should be allowed to promote files into `clean/`. Restrict principal permissions to the required prefixes.

The S3 SDK `HeadObject` operation requires `s3:GetObject` permission. For immutable version access, include `s3:GetObjectVersion`.

### Bucket policy

See `docs/bucket-policy-example.json` for a **Deny insecure (non-TLS) transport** bucket policy. Replace the placeholder and apply to the practice bucket through S3 > Permissions > Bucket policy. Keep Block Public Access on. This example is a transport guardrail, not a complete least-privilege or S3 signature-age design.

### Browser CORS (only if uploading directly from a browser)

AWS Console > S3 > bucket > Permissions > Cross-origin resource sharing (CORS) > Edit. Paste `docs/s3-cors.json`. Change the localhost origin to your real frontend origin when applicable. For Postman, CORS is not required.

CORS is a browser control and **does not replace** S3 IAM or authorization.

## 6. Run ClamAV for local scanning

If Docker Desktop is available:

```powershell
docker run -d --name file-practice-clamav -p 127.0.0.1:3310:3310 clamav/clamav:stable
docker logs -f file-practice-clamav
```

Wait for the logs to confirm that `clamd` has initialized and loaded its definitions. ClamAV requires substantial RAM for its signature database. The daemon exposes an **unauthenticated and unencrypted** TCP protocol: bind it to localhost for this demo; in production use a restricted internal network / Unix socket, never a public port.

This project accepts files up to **10 MiB**. Confirm the daemon's `StreamMaxLength` is greater than this size (ClamAV's default is generally 25 MiB, but verify your container configuration). A limit error must be treated as an unsuccessful scan, not a clean verdict.

Stop when finished:

```powershell
docker stop file-practice-clamav
docker rm file-practice-clamav
```

## 7. Run API and scanner

Terminal 1:

```powershell
npm run dev
```

Terminal 2:

```powershell
npm run worker
```

The API uses `http://localhost:3000` by default. `X-User-Id: user-alice` is **demo-only** user identification: the user header can be forged and provides **no real security**. Replace the middleware with authentication before any public deployment.

The scanner worker polls SQLite for `UPLOADED` rows every 3 seconds. This polling is a practical local **virus-scan hook**. In production, use the optional S3 event worker described later, a durable job queue and multiple scan workers with leases/retry control.

## 8. Postman: flow A — direct signed S3 POST

Prepare `C:\files\invoice.pdf` (a real PDF). In PowerShell, calculate true values:

```powershell
$path = 'C:\files\invoice.pdf'
(Get-Item $path).Length
(Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower()
```

### Request 1 — Request signed upload form

- Method: **POST**
- URL: `http://localhost:3000/files/sign-upload`
- Headers: `X-User-Id: user-alice`, `Content-Type: application/json`
- Body > raw > JSON:

```json
{
  "filename": "invoice.pdf",
  "contentType": "application/pdf",
  "fileSize": 12345,
  "sha256": "YOUR_REAL_64_CHARACTER_SHA256_FROM_POWERSHELL"
}
```

Replace `12345` with the file's actual byte count and replace the SHA-256 string. The server returns `fileId`, `uploadUrl`, `fields`, `expiresIn`.

### Request 2 — Send file **directly to S3**

- Method: **POST**
- URL: use the returned **`uploadUrl`**, not `localhost`.
- Body > **form-data**. Add **every** key/value from response `fields` as **Text** fields, preserving case and values exactly (including `key`, `Content-Type`, `policy`, `x-amz-*` fields).
- Add one last `file` field with type **File**, selecting `invoice.pdf`.
- **Do not manually set the overall multipart `Content-Type` header**; let Postman calculate the boundary.
- Expected: HTTP 204 (or S3-configured success response). Treat any S3 `403` as an error, not a completed upload.

S3 POST policy includes a total multipart request length bound. It allows the configured maximum file bytes **plus modest form overhead**. Exact stored object size is checked after upload and again by the scanner.

### Request 3 — Verify upload and queue scan

- Method: **POST**
- URL: `http://localhost:3000/files/FILE_ID/complete`
- Header: `X-User-Id: user-alice`
- Expected: 202 `UPLOADED`, unless the optional S3 event handler already submitted it. If the latter happens, query status instead.

### Request 4 — Check progress

- Method: **GET**
- URL: `http://localhost:3000/files/FILE_ID`
- Header: `X-User-Id: user-alice`
- Expected: `PENDING_UPLOAD`, `UPLOADED`, `SCANNING`, then `READY`, `QUARANTINED` or `SCAN_ERROR`.

### Request 5 — Get signed download URL

- Method: **GET**
- URL: `http://localhost:3000/files/FILE_ID/download-url`
- Header: `X-User-Id: user-alice`
- Expected: 200 with `downloadUrl` for `READY` objects; 409 for any unapproved object.
- Paste returned URL in browser (or perform GET with Postman) before it expires.

Note: A signed download link is itself a bearer credential; do not publish or log it. Your server must validate file ownership before generating it.

### Optional: compare signed PUT

- Request `POST http://localhost:3000/files/sign-put` with the **same JSON** as Request 1.
- Receive `uploadUrl` and required headers.
- Send a second Postman request using **PUT** to `uploadUrl`, Body > **binary** > select the same file, and set the exact returned headers (`Content-Type` and `x-amz-checksum-sha256`).
- Complete with `POST /files/FILE_ID/complete` and status/download checks as above.

The SDK signs the content-type and checksum headers; S3 verifies the SHA-256 checksum. However, do **not** assume PUT alone enforces the declared `fileSize`; the HEAD and scanner checks still matter. This is why signed POST is the recommended path for this strict-size practice.

## 9. Postman: flow B — multipart streaming through Express

- Method: **POST**
- URL: `http://localhost:3000/files/stream`
- Headers: `X-User-Id: user-alice`
- Body > **form-data** > key `file` > type **File** > select supported PDF/PNG/JPEG.
- Do not set `Content-Type: multipart/form-data` yourself; Postman sets the proper boundary.
- Expected: 202 with file ID, SHA-256 and `UPLOADED` status.

The upload is processed by Multer's custom storage engine; `file.stream` is passed through a `Transform` to compute SHA-256 and count bytes while `@aws-sdk/lib-storage` uploads the stream to S3. Neither `multer.memoryStorage` nor `fs.readFile` is used. The multipart helper holds **bounded** upload-part buffers; streaming does not mean zero memory.

Then use Requests 4–5 above to check scan outcome and download.

## 10. Endpoint summary

| Endpoint | Method | Purpose | Response |
|---|---|---|---|
| `/health` | GET | API check | 200 |
| `/files/sign-upload` | POST | Create signed S3 POST policy | 201 |
| `/files/sign-put` | POST | Optional presigned PUT URL with SHA-256 and MIME headers | 201 |
| `uploadUrl` from response | POST | Upload directly to S3 | 204 typically |
| `/files/:id/complete` | POST | HEAD checks / queue for scanner | 202 |
| `/files/stream` | POST | Stream multipart through Express | 202 |
| `/files/:id` | GET | Check status and scan reason | 200 |
| `/files/:id/download-url` | GET | Signed S3 GET for READY file | 200 |

Demo identity: all API requests require the `X-User-Id` header, including `/health`.

## 11. Optional real S3 ObjectCreated -> SQS virus-scan event hook

The basic demo uses `/complete` or streaming route to mark an upload ready for scanning. For server-side event delivery (so the client cannot forget `/complete`):

1. Create a **standard** SQS queue in the same AWS Region as S3. Configure a dead-letter queue and redrive limit.
2. Allow S3 to publish into it via a **queue resource policy**. See `docs/sqs-resource-policy-example.json`; substitute bucket, AWS account and queue names.
3. In S3 bucket > **Properties** > Event notifications, configure `s3:ObjectCreated:*`, prefix `incoming/`, destination SQS queue.
4. Add `docs/sqs-iam-example.json` permissions to the event worker IAM principal, and ensure it has S3 GetObject rights.
5. Set `SQS_QUEUE_URL` in `.env`.
6. Start one more terminal:

   ```powershell
   npm run events
   ```

7. Upload directly to S3 via signed form, then check status. The event worker verifies an object exists and atomically transitions `PENDING_UPLOAD -> UPLOADED`. The scan worker continues as before.

**Delivery behavior:** S3 notifications are at-least-once and not ordered. Duplicate events are ignored using a conditional database transition. A real distributed deployment uses a shared database and a worker lease rather than the local SQLite pattern in this demo.

**Security:** Only object keys under `incoming/` trigger scanning. Copying into `clean/` or `quarantine/` must not generate another scan event. The queue is private and only authorized workers can consume messages.

## 12. How the scanner validates objects

The worker:

1. Atomically claims an `UPLOADED` record as `SCANNING`.
2. Performs `GetObject` for the exact S3 version when available.
3. Streams content into ClamAV using the documented `INSTREAM` TCP protocol.
4. Counts actual bytes, computes actual SHA-256 and accumulates at most 4,100 bytes for magic-number type detection.
5. Rejects content that mismatches expected size, checksum or actual PDF/PNG/JPEG MIME.
6. Only accepts a `stream: OK` verdict from ClamAV.
7. Promotes validated content by copying the **same version** into `clean/`, then marks status `READY`.
8. Moves rejected content to `quarantine/`; treats scanner errors as blocked `SCAN_ERROR`.
9. Never signs a download URL for statuses other than `READY`.

File signatures are a **best-effort detection**, not proof that a document is harmless. Malware scanning and checksum validation provide separate controls.

## 13. Run tests

```powershell
npm test
```

Unit tests cover extension/MIME validation, traversal-like filenames, size bounds, SHA-256 format and demo ID validation.

Run the **manual integration checklist** in `docs/test-matrix.md`. In particular, verify cross-user denial, duplicate `/complete`, forged MIME, wrong checksum, oversized stream and scan engine unavailable.

An industry-standard EICAR test signature can be used in a **private scanner-only integration test** without using real malware. This strict public API rejects `.txt` before upload; do not relax the production file allowlist just to test EICAR.

## 14. Mistakes to avoid

- Using `multer.memoryStorage()` for multi-megabyte uploads and assuming it streams to S3.
- Trusting filename extensions or `Content-Type` submitted by a browser.
- Using a presigned PUT URL and assuming it enforces a hard upload-size limit.
- Treating S3 `ObjectCreated` or 200/204 transfer success as a malware-clean verdict.
- Issuing a download URL while status is `PENDING_UPLOAD`, `UPLOADED`, `SCANNING` or `SCAN_ERROR`.
- Making a bucket public or sharing AWS credentials with a client.
- Using original filenames as S3 keys or allowing arbitrary S3 key paths supplied by clients.
- Not protecting against reuse of a signed upload URL that could overwrite a scanned object. Enable versioning and scan/copy the exact version.
- Assuming that the S3 ETag equals SHA-256 (it often does not, especially for multipart uploads).
- Missing Multer `fileSize`, `files`, `fields` and `parts` limits.
- Forgetting multipart request overhead when writing a presigned POST `content-length-range` policy.
- Ignoring ClamAV connection errors or `INSTREAM size limit exceeded` messages.
- Making `clamd` TCP port publicly accessible.
- Scanning synchronously inside the user-facing request and keeping HTTP requests open for slow work.
- Letting S3 `clean/` copy operations create recursive scan events.
- Assuming S3 event delivery is exactly once or in order.
- Forgetting AWS lifecycle cleanup for incomplete multipart uploads, abandoned pending objects and old quarantine data.
- Sending presigned URL query strings or sensitive filenames into public logs.

## 15. Definition of done

- [ ] 10 MiB max and 3 allowed MIME types are enforced.
- [ ] Valid direct S3 POST works with only a short signed policy.
- [ ] Optional signed PUT upload rejects incorrect SHA-256 and passes a valid file.
- [ ] Multer route streams uploads without buffering entire files in RAM.
- [ ] Actual byte count, SHA-256 and file signature are checked.
- [ ] ClamAV returns clean verdict for supported safe files.
- [ ] Invalid/malicious content is quarantined, inaccessible or blocked.
- [ ] Signed download works **only** for READY files owned by the caller.
- [ ] Another demo user cannot fetch a different user's status or download link.
- [ ] Oversized, mismatched, missing, duplicate and interrupted uploads are tested.
- [ ] Optional S3 event hook can queue verification asynchronously.

## 16. Production upgrades to complete outside this focused practice

This repository purposely avoids building a complete user service or production Kubernetes stack. Before public deployment, add verified auth, rate limits, database cleanup jobs, S3 least-privilege separation, SQS DLQ monitoring, scan-worker retries with leases, request timeout and concurrency controls, structured audit logs, a secure S3 bucket policy (TLS-only and optionally a maximum signature age), and automated real-S3 integration tests. Scan engines should be kept patched and signatures refreshed.

**Official references:**

- [S3 signed URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [S3 event notifications](https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html)
- [S3 CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html)
- [AWS SDK streaming multipart Upload](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-lib-storage/)
- [Multer storage-engine API](https://github.com/expressjs/multer/blob/main/StorageEngine.md)
- [ClamAV INSTREAM protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html)
