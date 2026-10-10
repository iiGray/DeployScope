export function newRequestId(random = globalThis.crypto) {
  if (random.randomUUID) return random.randomUUID();
  return [...random.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
}
export function createMutationIntent({ kind, id = null, payload = {}, revision = null, shared = false }, requestId = newRequestId()) {
  if (!['create', 'update', 'start', 'stop', 'delete'].includes(kind)) throw new Error('无效操作');
  if (shared && kind !== 'create' && (!Number.isInteger(revision) || revision < 1)) throw new Error('缺少服务版本，请刷新后重新确认');
  const clean = {};
  if (['create', 'update'].includes(kind)) for (const key of ['alias', 'nodeId', 'modelRoot', 'modelPath', 'gpuIds', 'maxModelLen', 'gpuMemoryUtilization', 'dtype']) {
    if (payload[key] !== undefined) clean[key] = Array.isArray(payload[key]) ? Object.freeze([...payload[key]]) : payload[key];
  }
  return Object.freeze({ kind, id, payload: Object.freeze(clean), requestId, revision, shared });
}
export function mutationBody(intent) {
  return { ...structuredClone(intent.payload), ...(intent.shared ? { requestId: intent.requestId, ...(intent.kind !== 'create' ? { expectedRevision: intent.revision } : {}) } : {}) };
}
