export const emptyState = () => ({ nodes: [], deployments: [], gateway: { baseUrl: '未连接控制节点' } });
export const sharedState = ({ nodes, services, apiBase }) => ({ nodes, deployments: services, gateway: { baseUrl: apiBase } });
export function createApi(baseUrl = '') {
  return async (path, { method = 'GET', body } = {}) => {
    let response;
    try { response = await fetch(baseUrl + path, { method, headers: { 'X-GPU-Console': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin', signal: AbortSignal.timeout(65000) }); }
    catch { throw new Error('本地服务连接失败或请求超时，请检查服务是否运行'); }
    let result;
    try { result = await response.json(); } catch { throw new Error('后台返回了无效响应'); }
    if (!response.ok) throw new Error(result.error?.message || `请求失败 (${response.status})`);
    return result;
  };
}
export const api = createApi();
export function selectLogService(snapshot, selectedId, nodeId = snapshot.nodes[0]?.id) {
  const services = snapshot.services || [];
  if (services.some(service => service.id === selectedId)) return selectedId;
  const priority = { running: 0, starting: 1, restarting: 1, stopping: 2 };
  return services.filter(service => service.nodeId === nodeId)
    .sort((a, b) => (priority[a.status] ?? 3) - (priority[b.status] ?? 3)
      || (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))[0]?.id || null;
}
export async function readRuntime(client, selectedId, nodeId) {
  const snapshot = await client('/api/control/state');
  selectedId = selectLogService(snapshot, selectedId, nodeId);
  let logs = null; let logError = null;
  if (selectedId) {
    try { logs = (await client(`/api/control/deployments/${selectedId}/logs`)).logs; }
    catch (cause) { logError = cause.message; }
  }
  return { snapshot, selectedId, logs, logError };
}
