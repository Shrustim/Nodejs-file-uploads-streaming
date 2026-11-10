import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateFilenameAndType, validateClaimedSize, validateSha256, validateUserId,
} from '../src/validation.js';

test('accept supported filename and matching type', () => {
  assert.equal(validateFilenameAndType('invoice.pdf', 'application/pdf').filename, 'invoice.pdf');
});
test('reject spoofed extension and traversal-like name', () => {
  assert.throws(() => validateFilenameAndType('virus.exe', 'application/pdf'));
  assert.throws(() => validateFilenameAndType('../invoice.pdf', 'application/pdf'));
});
test('reject oversize and empty file', () => {
  assert.throws(() => validateClaimedSize(0, 10));
  assert.throws(() => validateClaimedSize(11, 10));
});
test('accept only SHA-256 hex', () => {
  assert.equal(validateSha256('A'.repeat(64)), 'a'.repeat(64));
  assert.throws(() => validateSha256('bad'));
});
test('demo user identifier cannot contain key/path traversal', () => {
  assert.equal(validateUserId('user-alice'), 'user-alice');
  assert.throws(() => validateUserId('user-../admin'));
});
