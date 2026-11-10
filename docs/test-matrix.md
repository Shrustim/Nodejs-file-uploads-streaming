# Security and integration test checklist

Run these with a **dedicated private test bucket**, ClamAV and the scanner worker.

| Test | Expected |
|---|---|
| Valid PDF via presigned POST | Status `UPLOADED` then `READY` |
| Valid PNG via streaming proxy | Status `UPLOADED` then `READY` |
| File is 1 byte larger than 10 MiB | 413 from Multer or rejection by signed policy / verification |
| MIME says PDF, bytes are PNG | QUARANTINED; download denied |
| `.exe` extension | 415 |
| Claim wrong SHA-256 for a valid file | QUARANTINED |
| `X-User-Id: user-bob` requests Alice's file | 404 |
| Download while status is `UPLOADED` | 409 |
| Replay signed POST after processing | Never changes clean copy; use S3 versioning |
| S3 object not present during complete | Request fails; cannot become READY |
| ClamAV unavailable | `SCAN_ERROR`; cannot download |
| EICAR safe test string file, if your format policy permits a test fixture | Detector gives FOUND; QUARANTINED |
| Terminate multipart request midway | Upload fails; check no exposed incomplete/READY object |
| Duplicate complete calls | One succeeds, other 409 |
| Abandoned presigned form | Remains PENDING_UPLOAD; cleanup by retention job |

EICAR is a harmless industry-standard antivirus test signature, not real malware.
For this strict PDF/PNG/JPEG demo, EICAR `.txt` is intentionally rejected by type policy;
for a scanner integration test use a separate private scanner test fixture (outside the public upload API).
