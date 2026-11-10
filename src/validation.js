import path from 'node:path';

export const accepted = Object.freeze({
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
});

export function validateFilenameAndType(filename, contentType) {
  if (typeof filename !== 'string' || !filename || filename.length > 160 ||
      /[\\/\u0000-\u001f\u007f"<>:|?*]/u.test(filename)) {
    throw Object.assign(new Error('Invalid filename'), { status: 400 });
  }
  const extension = path.extname(filename).toLowerCase();
  if (accepted[extension] !== contentType) {
    throw Object.assign(new Error('Unsupported file extension or content type'), { status: 415 });
  }
  return { filename, contentType };
}

export function validateClaimedSize(value, maxBytes) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maxBytes) {
    throw Object.assign(new Error(`fileSize must be between 1 and ${maxBytes} bytes`), { status: 413 });
  }
  return value;
}

export function validateSha256(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw Object.assign(new Error('sha256 must contain exactly 64 hexadecimal characters'), { status: 400 });
  }
  return value.toLowerCase();
}

export function validateUserId(value) {
  if (typeof value !== 'string' || !/^user-[a-z0-9_-]{1,30}$/.test(value)) {
    throw Object.assign(new Error('For demo, provide X-User-Id: user-alice'), { status: 401 });
  }
  return value;
}
