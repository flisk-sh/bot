import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  signApproval,
  verifyAndConsumeApproval,
  verifyWebhookSignature,
} from '../src/approvals.ts';

const SECRET = 'test-signing-secret';

describe('signed approvals (FND-07)', () => {
  test('verifies GitHub webhook signatures and rejects bad secret', () => {
    const body = '{"action":"opened"}';
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');

    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, sig, 'wrong-secret')).toBe(false);
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
  });

  test('valid approval runs once and marks id used', () => {
    const usedIds = new Set<string>();
    const action = { action_hash: 'hash-x', business: 'acme', commit_sha: 'abc123', amount_usd: 25 };
    const approval = signApproval({ id: 'appr-1', ...action, expires_at: 2000 }, SECRET);

    expect(verifyAndConsumeApproval(approval, action, { secret: SECRET, usedIds, now: 1000 })).toEqual({ ok: true });
    expect(usedIds.has('appr-1')).toBe(true);
  });

  test('refuses changed action with approval_mismatch', () => {
    const usedIds = new Set<string>();
    const action = { action_hash: 'hash-x', business: 'acme', commit_sha: 'abc123', amount_usd: 25 };
    const approval = signApproval({ id: 'appr-2', ...action, expires_at: 2000 }, SECRET);

    const res = verifyAndConsumeApproval(
      approval,
      { ...action, action_hash: 'hash-y' },
      { secret: SECRET, usedIds, now: 1000 },
    );
    expect(res).toEqual({ ok: false, reason: 'approval_mismatch' });
  });

  test('refuses expired approval with approval_expired', () => {
    const usedIds = new Set<string>();
    const action = { action_hash: 'hash-x', business: 'acme', commit_sha: 'abc123', amount_usd: 25 };
    const approval = signApproval({ id: 'appr-3', ...action, expires_at: 1000 }, SECRET);

    const res = verifyAndConsumeApproval(approval, action, { secret: SECRET, usedIds, now: 1500 });
    expect(res).toEqual({ ok: false, reason: 'approval_expired' });
  });

  test('refuses replay of already-used approval', () => {
    const usedIds = new Set<string>();
    const action = { action_hash: 'hash-x', business: 'acme', commit_sha: 'abc123', amount_usd: 25 };
    const approval = signApproval({ id: 'appr-4', ...action, expires_at: 2000 }, SECRET);

    expect(verifyAndConsumeApproval(approval, action, { secret: SECRET, usedIds, now: 1000 })).toEqual({ ok: true });
    expect(verifyAndConsumeApproval(approval, action, { secret: SECRET, usedIds, now: 1100 })).toEqual({
      ok: false,
      reason: 'approval_replay',
    });
  });

  test('refuses approval signed with bad secret', () => {
    const usedIds = new Set<string>();
    const action = { action_hash: 'hash-x', business: 'acme', commit_sha: 'abc123', amount_usd: 25 };
    const approval = signApproval({ id: 'appr-5', ...action, expires_at: 2000 }, 'wrong-secret');

    expect(verifyAndConsumeApproval(approval, action, { secret: SECRET, usedIds, now: 1000 })).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });
});
