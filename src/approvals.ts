// GitHub webhook verification and single-use signed approvals (FND-07).
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ApprovalPayload {
  id: string;
  action_hash: string;
  business: string;
  commit_sha: string;
  amount_usd: number;
  expires_at: number;
}

export interface SignedApproval {
  payload: ApprovalPayload;
  signature: string;
}

export function verifyWebhookSignature(rawBody: string, headerSig: string | null, secret: string): boolean {
  if (!headerSig || !headerSig.startsWith('sha256=') || !secret) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(headerSig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function canonicalApprovalString(p: ApprovalPayload): string {
  return `${p.id}|${p.action_hash}|${p.business}|${p.commit_sha}|${p.amount_usd}|${p.expires_at}`;
}

export function signApproval(payload: ApprovalPayload, secret: string): SignedApproval {
  const signature = createHmac('sha256', secret).update(canonicalApprovalString(payload)).digest('hex');
  return { payload, signature };
}

export function verifyAndConsumeApproval(
  approval: SignedApproval,
  action: { action_hash: string; business: string; commit_sha: string; amount_usd: number },
  opts: { secret: string; usedIds: Set<string>; now?: number },
): { ok: true } | { ok: false; reason: 'invalid_signature' | 'approval_expired' | 'approval_replay' | 'approval_mismatch' } {
  const now = opts.now ?? Date.now();
  const expectedSig = createHmac('sha256', opts.secret)
    .update(canonicalApprovalString(approval.payload))
    .digest('hex');
  const a = Buffer.from(approval.signature);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  if (opts.usedIds.has(approval.payload.id)) {
    return { ok: false, reason: 'approval_replay' };
  }

  if (approval.payload.expires_at <= now) {
    return { ok: false, reason: 'approval_expired' };
  }

  if (
    approval.payload.action_hash !== action.action_hash ||
    approval.payload.business !== action.business ||
    approval.payload.commit_sha !== action.commit_sha ||
    approval.payload.amount_usd !== action.amount_usd
  ) {
    return { ok: false, reason: 'approval_mismatch' };
  }

  opts.usedIds.add(approval.payload.id);
  return { ok: true };
}
