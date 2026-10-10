import { createHash } from 'node:crypto';
import { ApiError } from './common.mjs';
import { validateDeployment } from './gpu.mjs';

export function requireMutationId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new ApiError(400, '需要有效的 requestId / operationId');
  return value;
}
export function fingerprintMutation({ kind, serviceId = null, payload = {} }) {
  if (!['create', 'update', 'start', 'stop', 'delete'].includes(kind)) throw new ApiError(400, '操作类型无效');
  const business = ['create', 'update'].includes(kind) ? { ...validateDeployment(payload), nodeId: payload.nodeId ?? null } : {};
  if (payload.expectedRevision !== undefined) business.expectedRevision = payload.expectedRevision;
  const canonical = Object.fromEntries(Object.keys(business).sort().map(key => [key, business[key]]));
  return createHash('sha256').update(JSON.stringify({ kind, serviceId, payload: canonical })).digest('hex');
}
export function getReceipt(data, requestId, fingerprint) {
  requireMutationId(requestId);
  const receipt = data.mutationReceipts?.find(item => item.requestId === requestId) || null;
  if (receipt && receipt.fingerprint !== fingerprint) throw new ApiError(409, '该请求 ID 已用于另一份操作，请重新确认');
  return receipt;
}
export function pruneReceipts(receipts = [], now = Date.now()) {
  const pending = receipts.filter(item => item.status === 'pending');
  const completed = receipts.filter(item => item.status !== 'pending' && now - (item.completedAt ?? item.acceptedAt) < 7 * 86400000).sort((a, b) => (b.completedAt ?? b.acceptedAt) - (a.completedAt ?? a.acceptedAt)).slice(0, 10000);
  return [...pending, ...completed];
}
