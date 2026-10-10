import { createInitialState, createDeployment, updateDeployment, startDeployment, stopDeployment, deleteDeployment, validateDraft, renderLogOptions, renderModelIssue, renderDeleteButton, renderDeleteDialog, renderAliasCopyButton, renderLocalApi, escapeHtml as esc } from './app-state.mjs';
import { buildCommand } from './command.mjs';
import { api as requestApi, emptyState, sharedState, readRuntime, selectLogService } from './api.mjs';
import { DEFAULT_MODEL_ROOT, createDirectoryReader, renderDirectoryDialog, renderModelOptions } from './model-browser.mjs';
import { createSessionEpoch, renderLogin } from './shared-session.mjs';
import { createMutationIntent, mutationBody } from './mutation.mjs';

const STORE = 'gpu-monitor-preview-v1';
const demo = new URLSearchParams(location.search).get('demo') === '1';
const epoch = createSessionEpoch();
let session = { mode: 'local', authenticated: demo, ready: demo };
let loginMessage = '';
let editingRevision = null;
let confirmationIntent = null;
let retryIntent = null;
let state = emptyState();
if (demo) {
  try { state = JSON.parse(localStorage.getItem(STORE)) || createInitialState(); } catch { state = createInitialState(); }
  if (!state?.nodes?.length || !Array.isArray(state.deployments)) state = createInitialState();
}
const emptyNode = { id: '', name: '未注册机器', host: '—', models: [], gpus: [], modelRoot: '', status: 'offline' };

let machineId = state.nodes[0]?.id || '';
let connectedId = null;
let connecting = false;
let editingId = null;
let selectedId = null;
let error = '';
let commandOpen = false;
let busy = false;
let polling = false;
let rawLog = '';
let lastRawLog = '';
let controlError = '';
let activeView = 'deploy';
let logState = 'idle';
let runtimeLogError = '';
let directorySnapshot = null;
let directoryLoading = false;
let directoryIssue = '';
let directoryPicker = null;
let rootDraft = DEFAULT_MODEL_ROOT;
let draft = newDraft();
const directoryReader = createDirectoryReader(async (path, options) => {
  if (!demo) return api(path, options);
  const machine = state.nodes.find(n => n.id === decodeURIComponent(path.split('/')[4]));
  const requested = options.body.path || DEFAULT_MODEL_ROOT;
  const directories = new Set(['/', DEFAULT_MODEL_ROOT]);
  for (const full of [...(machine?.models || []).map(m => m.path), ...(machine?.models || []).map(m => `${DEFAULT_MODEL_ROOT}/${m.alias}`), DEFAULT_MODEL_ROOT]) {
    let parent = ''; for (const part of full.split('/').filter(Boolean)) { parent += '/' + part; directories.add(parent); }
  }
  const parentOf = value => value.slice(0, value.lastIndexOf('/')) || '/';
  if (!directories.has(requested)) throw new Error('演示目录不存在');
  return { root:'/', path:requested, parent:requested==='/' ? null : parentOf(requested), children:[...directories].filter(p => p!=='/' && parentOf(p)===requested).sort().map(p => ({name:p.split('/').at(-1),path:p})) };
});
let logs = [{ time: 'READY', message: '选择机器并连接，查看 GPU 状态。', type: 'muted' }];

const shared = () => session.mode === 'shared';
async function api(path, options) {
  const captured = epoch.current();
  try {
    const result = await requestApi(path, options);
    if (!epoch.isCurrent(captured)) throw new Error('会话已变化');
    return result;
  } catch (cause) {
    if (epoch.isCurrent(captured) && shared() && cause.status === 401) resetSession(false, '会话已失效，请重新登录');
    throw cause;
  }
}
function resetSession(authenticated, message = '') {
  epoch.advance(); directoryReader.cancel();
  session = { ...session, authenticated, ready: true }; loginMessage = message;
  state = emptyState(); machineId = ''; connectedId = null; selectedId = null; editingId = null; editingRevision = null;
  directorySnapshot = null; directoryPicker = null; directoryLoading = false; directoryIssue = ''; confirmationIntent = null; retryIntent = null;
  rawLog = ''; lastRawLog = ''; runtimeLogError = ''; controlError = ''; error = ''; logs = []; busy = false; connecting = false; polling = false;
  rootDraft = DEFAULT_MODEL_ROOT; draft = newDraft();
  document.querySelector('#modal-root').replaceChildren(); document.querySelector('#toast-root').replaceChildren(); render();
}
async function login() {
  const field = document.querySelector('#team-password'); const password = field.value; field.value = '';
  const captured = epoch.advance(); document.querySelector('#team-login button').disabled = true;
  try {
    await requestApi('/api/session/login', { method: 'POST', body: { password } });
    if (!epoch.isCurrent(captured)) return;
    resetSession(true);
    const loggedIn = epoch.current();
    try { await pullState(true); await poll(); }
    catch (cause) { if (epoch.isCurrent(loggedIn)) { controlError = cause.message; error = cause.message; render(); } }
  } catch (cause) { if (epoch.isCurrent(captured)) { loginMessage = cause.message; render(); } }
}
async function logout() {
  const pending = requestApi('/api/session/logout', { method: 'POST', body: {} });
  resetSession(false, '已退出团队管理网页');
  const captured = epoch.current();
  try { await pending; } catch (cause) { if (epoch.isCurrent(captured)) { loginMessage = `服务器尚未确认退出：${cause.message}`; render(); } }
}
function intent(kind, item = null, payload = {}) { return createMutationIntent({ kind, id: item?.id || null, payload, revision: kind === 'update' ? editingRevision : item?.revision, shared: shared() }); }
async function runIntent(frozen, onSuccess) {
  const captured = epoch.current();
  const ok = await perform(async () => {
    const path = frozen.kind === 'create' ? '/api/control/deployments' : `/api/control/deployments/${frozen.id}${['start', 'stop'].includes(frozen.kind) ? '/' + frozen.kind : ''}`;
    const method = frozen.kind === 'delete' ? 'DELETE' : frozen.kind === 'update' ? 'PATCH' : 'POST';
    try { const result = await api(path, { method, body: mutationBody(frozen) }); retryIntent = null; await onSuccess(result); }
    catch (cause) { if (epoch.isCurrent(captured)) retryIntent = frozen.shared && (!cause.status || cause.status >= 500) ? { frozen, onSuccess } : null; throw cause; }
  });
  return epoch.isCurrent(captured) && ok;
}
function apiHeader() {
  if (state.inferenceMode === 'per-node') return '<span>本机推理 API · 仅在部署服务器调用</span>';
  return `<span>统一 API</span><code>${esc(state.gateway.baseUrl || '')}</code><button class="icon-button" data-action="copy-api" aria-label="复制统一 API 地址">${icon('copy')}</button>`;
}

const paths = {
  gpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3M19 9h3m-3 6h3"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M17 6.5h1M17 17.5h1"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 7a7 7 0 0 1 12-2l3 3M4 16l3 3a7 7 0 0 0 12-2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  terminal: '<path d="m5 6 6 6-6 6M13 18h6"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  edit: '<path d="m15 4 5 5M4 20l4-1L20 7a2 2 0 0 0-4-4L4 15z"/>',
  clear: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  link: '<path d="m10 13 4-4m-7 1-3 3a4 4 0 0 0 6 6l3-3m-2-8 3-3a4 4 0 0 1 6 6l-3 3"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.gpu}</svg>`;
const node = () => state.nodes.find((item) => item.id === machineId) || emptyNode;
const deployment = (id) => state.deployments.find((item) => item.id === id);
const connected = () => !!machineId && connectedId === machineId && (demo || node().status === 'online');
const labels = { running: '运行中', stopped: '已停止', starting: '启动中', restarting: '重启中', stopping: '停止中', failed: '异常', unknown: '未确认', orphaned: '残留进程' };
const status = (value) => `<span class="status ${esc(value)}"><i></i>${labels[value] || value}</span>`;
const available = (gpu) => !gpu.externalBusy && (!gpu.deploymentId || gpu.deploymentId === editingId);

function newDraft() {
  const machine = state.nodes.find((item) => item.id === machineId);
  return { alias: '', nodeId: machineId, modelRoot:rootDraft || machine?.defaultModelRoot || DEFAULT_MODEL_ROOT, modelPath: directorySnapshot?.nodeId===machineId ? directorySnapshot.children[0]?.path || '' : '', gpuIds: [], maxModelLen: 32768, gpuMemoryUtilization: 0.9, dtype: 'auto' };
}
function save() {
  if (!demo) return;
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { notify('浏览器无法保存本地演示数据'); }
}
function log(message, type = 'info') {
  logs.push({ time: new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }), message, type });
  logs = logs.slice(-50);
}
function notify(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.querySelector('#toast-root').append(toast);
  setTimeout(() => toast.remove(), 3200);
}
function updatePreview() {
  const command = document.querySelector('#command-text');
  if (command) command.textContent = buildCommand(draft);
}

function gpuChoices() {
  if (!connected()) return `<div class="waiting-inline">${icon('gpu')}连接机器后，可选择空闲 GPU。</div>`;
  if (node().gpuError || !node().gpus.length) return `<div class="waiting-inline telemetry-error">${esc(node().gpuError || '未发现 NVIDIA GPU')}</div>`;
  return `<div class="gpu-choices">${node().gpus.map((gpu) => `<button class="gpu-choice ${draft.gpuIds.includes(gpu.id) ? 'selected' : ''}" data-gpu="${gpu.id}" aria-pressed="${draft.gpuIds.includes(gpu.id)}" ${available(gpu) ? '' : 'disabled'} title="${esc(available(gpu) ? '选择 GPU ' + gpu.id : gpu.externalBusy ? '外部进程占用' : '已被 ' + (deployment(gpu.deploymentId)?.alias || '其他部署') + ' 占用')}"><span class="gpu-check">${draft.gpuIds.includes(gpu.id) ? icon('check') : icon('gpu')}</span><strong>GPU ${gpu.id}</strong><span>${available(gpu) ? gpu.memoryTotal + ' GiB' : '已占用'}</span></button>`).join('')}</div>`;
}

function gpuStatus() {
  if (!connected()) return `<div class="gpu-waiting">${icon('gpu')}<strong>等待连接机器</strong><span>连接后显示利用率、显存和温度。</span></div>`;
  if (node().gpuError || !node().gpus.length) return `<div class="gpu-waiting telemetry-error">${icon('gpu')}<strong>无法读取显卡状态</strong><span>${esc(node().gpuError || '未发现 NVIDIA GPU')}</span></div>`;
  return `<div class="gpu-table-wrap"><table class="gpu-table"><thead><tr><th>GPU</th><th>利用率</th><th>显存</th><th>温度</th><th>分配</th></tr></thead><tbody>${node().gpus.map((gpu) => `<tr><td><strong>${gpu.id}</strong><small>${esc(gpu.name.replace('NVIDIA ', ''))}</small></td><td><span>${gpu.utilization == null ? '—' : gpu.utilization + '%'}</span><div class="meter"><i style="width:${gpu.utilization || 0}%"></i></div></td><td><span>${gpu.memoryUsed ?? '—'} / ${gpu.memoryTotal}<small> GiB</small></span><div class="meter"><i style="width:${(gpu.memoryUsed || 0) / gpu.memoryTotal * 100}%"></i></div></td><td>${gpu.temperature ?? '—'}<small>°C</small></td><td>${gpu.deploymentId || gpu.externalBusy ? `<span class="allocated" title="${esc(gpu.externalBusy ? '外部进程' : deployment(gpu.deploymentId)?.alias)}">${gpu.externalBusy ? '外部占用' : '占用'}</span>` : '<span class="free">空闲</span>'}</td></tr>`).join('')}</tbody></table></div><div class="gpu-footer"><span>${esc(node().host)} · 驱动 ${esc(node().driver)}</span><span class="simulated">${demo ? '模拟状态' : '实时 · 每 3 秒刷新'}</span></div>`;
}

function serviceRows() {
  if (!state.deployments.length) return '<tr><td colspan="4" class="empty-services">暂无部署 · 连接机器后选择模型和 GPU 启动</td></tr>';
  return state.deployments.map((item) => {
    const machine = state.nodes.find((candidate) => candidate.id === item.nodeId);
    const restartable = ['stopped', 'failed', 'unknown'].includes(item.status);
    const blocked = busy || item.deletePending;
    return `<tr class="${selectedId === item.id ? 'selected-row' : ''}"><td><div class="service-name-line"><button class="service-name" data-select="${esc(item.id)}" title="选中服务查看日志">${esc(item.alias)}</button>${renderAliasCopyButton(item)}</div><small>${esc(item.modelPath.split('/').at(-1))}</small></td><td title="${esc(item.error || '')}">${status(item.status)}</td><td><span>${esc(machine?.name || '未知机器')}${state.inferenceMode === 'per-node' ? ` · GPU ${item.gpuIds.join(', ')} · TP ${item.tensorParallelSize}` : ''}</span>${state.inferenceMode === 'per-node' ? renderLocalApi(item, machine) : `<small>GPU ${item.gpuIds.join(', ')} · TP ${item.tensorParallelSize}</small>`}</td><td class="service-actions"><button class="tiny-button" data-edit="${esc(item.id)}" ${blocked ? 'disabled' : ''}>${icon('edit')}修改</button><button class="tiny-button ${restartable ? '' : 'stop-text'}" data-${restartable ? 'start' : 'stop'}="${esc(item.id)}" ${blocked ? 'disabled' : ''}>${icon(restartable ? 'play' : 'stop')}${restartable ? '启动' : '停止'}</button>${renderDeleteButton(item, busy)}</td></tr>`;
  }).join('');
}

function logOptions() {
  return renderLogOptions(state.deployments, selectedId, labels);
}

function selectService(id, view = activeView) {
  selectedId = id; rawLog = ''; lastRawLog = ''; runtimeLogError = ''; logState = id ? 'loading' : 'idle'; activeView = view;
  render(); if (!demo) poll();
}

function render() {
  if (!session.ready || (shared() && !session.authenticated)) { document.querySelector('#app').innerHTML = session.ready ? renderLogin(loginMessage) : '<main class="login-page">正在连接 DeployScope…</main>'; return; }
  const machine = node();
  const selected = deployment(selectedId);
  document.querySelector('#app').innerHTML = `<main class="console" data-view="${activeView}">
    <header class="app-header"><div class="app-brand">${icon('gpu')}<h1>GPU Monitor</h1><span class="header-divider"></span><span class="header-label">推理部署</span></div><div class="header-tools"><a class="text-button" href="${demo ? '/' : '/?demo=1'}">${demo ? '真实模式' : '演示'}</a><span class="preview-label"><i></i>${demo ? '前端演示' : '共享控制节点'}</span>${demo ? '' : `<button class="icon-button" data-action="settings" aria-label="连接设置" title="连接设置">${icon('settings')}</button>`}</div></header>
    <nav class="workspace-tabs" aria-label="工作区切换">${[['deploy', '部署'], ['gpus', '显卡'], ['logs', '日志'], ['services', '服务']].map(([view, title]) => `<button data-view="${view}" aria-pressed="${activeView === view}">${title}</button>`).join('')}</nav>
    <div class="console-grid">
      <div class="config-column">
        <section class="panel connection-panel"><h2 class="sr-only">机器连接</h2><div class="connection-fields"><label class="grow"><span class="sr-only">机器</span><select id="machine" aria-label="机器" ${connecting || busy || editingId ? 'disabled' : ''}>${!state.nodes.length ? '<option>请先添加机器</option>' : state.nodes.map((item) => `<option value="${esc(item.id)}" ${machineId === item.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label><span class="connection-state ${connected() ? 'online' : ''}"><i></i>${connecting ? '连接中' : connected() ? demo ? '已连接 · 模拟' : '已连接' : '未连接'}</span><button class="button ${connected() ? 'secondary' : 'primary'} connect-button" data-action="connect" ${connecting || busy || !machineId ? 'disabled' : ''}>${icon(connected() ? 'refresh' : 'link')}${connecting ? '连接中' : connected() ? '重新连接' : '连接机器'}</button></div></section>
        <section class="panel model-panel"><div class="panel-title">${icon('folder')}<h2>模型</h2>${editingId ? '<span class="editing-tag">修改部署</span><button class="text-button" data-action="clear-form">取消修改</button>' : ''}</div><label>模型目录<button id="model-root" class="directory-picker-button" data-action="browse-directory" aria-label="选择模型目录" title="${esc(rootDraft)}" ${!connected() || connecting || busy || directoryLoading ? 'disabled' : ''}>${icon('folder')}<span>${esc(rootDraft)}</span>${icon('down')}</button></label><div class="model-fields"><label class="model-path-field">模型路径<select id="model-path" aria-label="模型路径" ${!connected() || directoryLoading || busy ? 'disabled' : ''}>${renderModelOptions(directorySnapshot?.nodeId===machineId ? directorySnapshot.children : [],draft.modelPath,!!editingId)}</select></label><label class="alias-field">服务别名<input id="service-alias" value="${esc(draft.alias)}" placeholder="例如 qwen-32b" aria-label="服务别名"/></label></div></section>
        <section class="panel gpu-select-panel"><div class="panel-title">${icon('gpu')}<h2>GPU 选择</h2><span class="section-meta">独占分配</span>${connected() ? `<button class="text-button" data-action="toggle-gpus">${draft.gpuIds.length ? '取消全选' : '选择空闲'}</button>` : ''}</div>${gpuChoices()}<div class="selection-footer"><span>已选 <strong>${draft.gpuIds.length}</strong> 张 GPU</span><span>Tensor Parallel <strong>${draft.gpuIds.length || '—'}</strong></span></div></section>
        <details class="panel params-panel" open><summary>${icon('settings')}<h2>vLLM 参数</h2>${icon('down')}</summary><div class="parameter-fields"><label>最大上下文<select id="max-model-len" aria-label="最大上下文">${[...new Set([4096, 8192, 16384, 32768, 65536, 131072, Number(draft.maxModelLen)])].sort((a, b) => a - b).map((value) => `<option value="${value}" ${Number(draft.maxModelLen) === value ? 'selected' : ''}>${value.toLocaleString()}</option>`).join('')}</select></label><label>显存比例<input id="gpu-memory" type="number" min="0.5" max="0.98" step="0.01" value="${draft.gpuMemoryUtilization}" aria-label="显存比例"/></label><label>精度<select id="model-dtype" aria-label="精度">${['auto', 'bfloat16', 'float16'].map((value) => `<option ${draft.dtype === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label></div></details>
        <section class="action-panel"><button class="button primary deploy-button" data-action="deploy" ${connected() && !connecting && !busy && !machine.gpuError && machine.gpus.length && !deployment(editingId)?.deletePending ? '' : 'disabled'}>${icon(editingId ? 'refresh' : 'play')}${busy ? '处理中…' : editingId ? '保存并重启部署' : '启动部署'}</button><div class="action-row"><button class="button stop-button" data-action="stop-selected" ${selected && selected.status !== 'stopped' && !selected.deletePending && !busy ? '' : 'disabled'}>${icon('stop')}停止${selected ? '选中服务' : ''}</button><button class="button secondary" data-action="clear-form" ${busy ? 'disabled' : ''}>${icon('clear')}清空</button><button class="button secondary" data-action="copy-command">${icon('copy')}复制命令</button></div><div id="error-box" class="form-error" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</div></section>
        <details class="panel command-panel" ${commandOpen ? 'open' : ''}><summary>${icon('terminal')}<h2>启动命令</h2>${icon('down')}</summary><pre id="command-text">${esc(buildCommand(draft))}</pre></details>
      </div>
      <div class="runtime-column">
        <section class="panel log-panel"><div class="panel-title">${icon('terminal')}<h2>vLLM 日志</h2><span class="log-indicator">${demo ? '演示' : runtimeLogError ? '读取失败' : selected ? '每 3 秒同步' : '等待部署'}</span><button class="text-button" data-action="refresh-log">刷新</button><button class="text-button" data-action="clear-log">清空显示</button></div><label class="log-picker"><span class="sr-only">日志服务</span><select id="log-service" aria-label="日志服务" ${state.deployments.length ? '' : 'disabled'}>${logOptions()}</select></label><div class="terminal" role="log" aria-label="部署日志" aria-live="off">${terminalContent()}</div></section>
        <section class="panel gpu-status-panel"><div class="panel-title">${icon('gpu')}<h2>显卡状态</h2>${connected() ? `<span class="section-meta">${machine.gpus.length} 张</span><button class="icon-button" data-action="refresh-gpus" aria-label="刷新显卡状态" title="刷新状态">${icon('refresh')}</button>` : ''}</div>${gpuStatus()}</section>
      </div>
    </div>
    <section class="panel services-panel"><div class="panel-title">${icon('server')}<h2>已部署服务</h2><span class="section-meta">${state.deployments.length} 个</span><div class="api-inline"><span>统一 API</span><code>${esc(state.gateway.baseUrl)}</code><button class="icon-button" data-action="copy-api" aria-label="复制统一 API 地址" title="复制 API 地址">${icon('copy')}</button></div></div><div class="services-table-wrap"><table class="services-table"><thead><tr><th>服务别名 / 模型</th><th>状态</th><th>机器 / GPU</th><th class="align-right">操作</th></tr></thead><tbody>${serviceRows()}</tbody></table></div></section>
    <footer><span id="control-status"><i class="demo-dot"></i>${demo ? '机器连接、显卡指标与部署日志均为模拟数据。' : esc(controlError || '本地客户端 · 部署状态由共享控制节点同步')}</span><span>vLLM · GPU 独占 · 紧凑 v2</span></footer>
  </main>`;
  document.title = 'GPU Monitor · 推理部署';
  document.querySelector('.api-inline').innerHTML = apiHeader();
  if (shared()) document.querySelector('.header-tools').insertAdjacentHTML('beforeend', '<button class="text-button" data-action="logout">退出</button>');
  if (retryIntent) document.querySelector('#error-box').insertAdjacentHTML('beforeend', '<button class="text-button" data-action="retry-mutation">重试原提交</button>');
  if (shared()) document.querySelector('#control-status').textContent = controlError || '团队共享管理 · 草稿独立 · 先提交先占用';
  document.querySelector('.model-panel').insertAdjacentHTML('beforeend', `<div class="model-notice">${renderModelIssue(directoryIssue)}</div>`);
  document.querySelector('.command-panel')?.addEventListener('toggle', (event) => { commandOpen = event.target.open; });
  const terminal = document.querySelector('.terminal');
  terminal.scrollTop = terminal.scrollHeight;
}

function terminalContent() {
  if (!demo && selectedId) {
    if (runtimeLogError) return `<div class="log-empty log-error">${esc(runtimeLogError)}<br/>可点击“刷新”重试；部署状态不受影响。</div>`;
    if (rawLog) return `<pre class="remote-log">${esc(rawLog)}</pre>`;
    return `<div class="log-empty">${logState === 'ready' ? 'vLLM 暂无输出，启动后会自动同步日志。' : '正在读取 vLLM 部署日志…'}</div>`;
  }
  return logs.map((entry) => `<div class="log-line ${entry.type}"><span>${esc(entry.time)}</span><span>${esc(entry.message)}</span></div>`).join('') + (rawLog ? `<pre class="remote-log">${esc(rawLog)}</pre>` : '');
}
function updateRuntime() {
  const choice = document.querySelector('.gpu-select-panel .gpu-choices, .gpu-select-panel .waiting-inline');
  if (choice) choice.outerHTML = gpuChoices();
  const telemetry = document.querySelector('.gpu-status-panel .gpu-table-wrap, .gpu-status-panel .gpu-waiting');
  if (telemetry) { document.querySelector('.gpu-footer')?.remove(); telemetry.outerHTML = gpuStatus(); }
  const count = document.querySelector('.gpu-status-panel .section-meta'); if (count) count.textContent = `${node().gpus.length} 张`;
  document.querySelector('.services-table tbody').innerHTML = serviceRows();
  document.querySelector('.services-panel .section-meta').textContent = `${state.deployments.length} 个`;
  document.querySelector('.api-inline').innerHTML = apiHeader();
  document.querySelector('#control-status').textContent = controlError || (shared() ? '团队共享管理 · 草稿独立 · 先提交先占用' : '本地客户端 · 部署状态由共享控制节点同步');
  const connection = document.querySelector('.connection-state');
  connection.classList.toggle('online', connected()); connection.innerHTML = `<i></i>${connected() ? '已连接' : '未连接'}`;
  document.querySelector('[data-action="deploy"]').disabled = !connected() || connecting || busy || directoryLoading || !!node().gpuError || !node().gpus.length || !!deployment(editingId)?.deletePending;
  const stopButton = document.querySelector('[data-action="stop-selected"]');
  stopButton.disabled = !deployment(selectedId) || deployment(selectedId).status === 'stopped' || deployment(selectedId).deletePending || busy;
  const picker = document.querySelector('#log-service');
  if (picker.innerHTML !== logOptions()) picker.innerHTML = logOptions();
  picker.disabled = !state.deployments.length;
  document.querySelector('.log-indicator').textContent = runtimeLogError ? '读取失败' : selectedId ? '每 3 秒同步' : '等待部署';
  const terminal = document.querySelector('.terminal');
  const nearBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 40;
  const content = terminalContent(); if (terminal.innerHTML !== content) { terminal.innerHTML = content; if (nearBottom) terminal.scrollTop = terminal.scrollHeight; }
  document.querySelector('.model-notice').innerHTML = renderModelIssue(directoryIssue);
}
async function pullState(full = false, snapshot = null) {
  const captured = epoch.current();
  const received = snapshot || await api('/api/control/state');
  if (!epoch.isCurrent(captured)) return false;
  const previousIds = state.nodes.map((n) => n.id).join(',');
  state = sharedState(received); controlError = '';
  if (!state.nodes.some((n) => n.id === machineId)) {
    machineId = state.nodes[0]?.id || ''; connectedId = null; resetDirectory(); rootDraft = node().defaultModelRoot || DEFAULT_MODEL_ROOT; draft = newDraft(); full = true;
  }
  if (previousIds !== state.nodes.map((n) => n.id).join(',')) full = true;
  const nextSelected = selectLogService({ nodes: state.nodes, services: state.deployments }, selectedId, machineId);
  if (nextSelected !== selectedId) { selectedId = nextSelected; rawLog = ''; lastRawLog = ''; runtimeLogError = ''; logState = nextSelected ? 'loading' : 'idle'; }
  if (full) render(); else updateRuntime();
}
async function poll() {
  if (demo || !session.ready || !session.authenticated || busy || polling || document.hidden) return;
  const captured = epoch.current();
  polling = true;
  try {
    const id = selectedId;
    const target = machineId;
    const result = await readRuntime(api, id, target || undefined);
    if (!epoch.isCurrent(captured)) return;
    const selectionUnchanged = selectedId === id && machineId === target;
    await pullState(false, result.snapshot);
    if (selectionUnchanged && selectedId === result.selectedId) {
      if (result.logs !== null && result.logs !== lastRawLog) { rawLog = result.logs; lastRawLog = result.logs; }
      runtimeLogError = result.logError ? `日志读取失败：${result.logError}` : '';
      logState = result.logs !== null ? 'ready' : 'idle';
      updateRuntime();
    }
  } catch (cause) {
    if (!epoch.isCurrent(captured)) return;
    controlError = cause.message;
    for (const n of state.nodes) { n.status = 'offline'; n.gpus = []; }
    for (const s of state.deployments) s.status = 'unknown';
    updateRuntime();
  } finally { if (epoch.isCurrent(captured)) polling = false; }
}
async function perform(work) {
  if (busy) return false;
  const captured = epoch.current();
  busy = true; error = ''; render();
  try { await work(); if (!epoch.isCurrent(captured)) return false; await pullState(); return true; }
  catch (cause) { if (!epoch.isCurrent(captured)) return false; error = cause.message; log(cause.message, 'muted'); await pullState().catch(() => {}); return false; }
  finally { if (epoch.isCurrent(captured)) { busy = false; render(); } }
}
async function showSettings() {
  const captured = epoch.current();
  let settings;
  try { settings = await api('/api/local/settings'); } catch (cause) { if (epoch.isCurrent(captured)) notify(cause.message); return; }
  document.querySelector('#modal-root').innerHTML = `<div class="dialog-backdrop"><section class="confirm-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><h2 id="settings-title">连接设置</h2><p>每位用户连接同一个控制节点，共享机器和部署。</p><label>控制节点地址<input id="controller-url" value="${esc(settings.controllerUrl)}" placeholder="http://控制节点IP:8080" aria-label="控制节点地址"/></label><label>管理密钥<input id="admin-token" type="password" autocomplete="off" placeholder="${settings.configured ? '已保存，留空保持不变' : '控制节点 adminToken'}" aria-label="管理密钥"/></label><div class="settings-actions"><button class="button primary" data-action="save-settings">保存并连接</button></div><details><summary>添加 / 更新机器</summary><label>机器名称<input id="agent-name" placeholder="例如 gpu-01" aria-label="机器名称"/></label><label>Agent 地址<input id="agent-url" placeholder="http://机器IP:9000" aria-label="Agent 地址"/></label><label>Agent 密钥<input id="agent-token" type="password" autocomplete="off" aria-label="Agent 密钥"/></label><div class="settings-actions"><button class="button secondary" data-action="register-node">添加机器</button></div></details><p class="settings-error" role="alert"></p><div class="settings-actions"><button class="button secondary" data-action="close-settings">关闭</button></div></section></div>`;
  document.querySelector('#controller-url').focus();
  if (shared()) {
    document.querySelector('#settings-title').textContent = '团队管理';
    document.querySelector('.settings-dialog > p').textContent = '服务端连接固定。所有成员可管理共同的机器和部署。';
    document.querySelector('#controller-url').readOnly = true;
    document.querySelector('#admin-token').closest('label').remove();
    document.querySelector('[data-action="save-settings"]').closest('.settings-actions').remove();
  }
}
async function saveSettings(register = false) {
  const captured = epoch.current();
  const button = document.querySelector(`[data-action="${register ? 'register-node' : 'save-settings'}"]`);
  if (button.disabled) return;
  button.disabled = true; const dialogError = document.querySelector('.settings-error'); dialogError.textContent = '';
  try {
    if (register) await api('/api/control/nodes', { method: 'POST', body: { name: document.querySelector('#agent-name').value, url: document.querySelector('#agent-url').value, token: document.querySelector('#agent-token').value } });
    else await api('/api/local/settings', { method: 'PUT', body: { controllerUrl: document.querySelector('#controller-url').value, adminToken: document.querySelector('#admin-token').value } });
    await pullState(true);
    if (!epoch.isCurrent(captured)) return;
    if (!shared()) { resetDirectory(); rootDraft = node().defaultModelRoot || DEFAULT_MODEL_ROOT; draft = newDraft(); render(); }
    document.querySelector(register ? '#agent-token' : '#admin-token').value = '';
    notify(register ? '机器已添加，选择后连接' : '已连接共享控制节点');
  } catch (cause) { if (epoch.isCurrent(captured) && dialogError.isConnected) dialogError.textContent = cause.message; }
  finally { if (epoch.isCurrent(captured) && button.isConnected) button.disabled = false; }
}

function clearForm() {
  editingId = null; editingRevision = null; retryIntent = null; draft = newDraft(); error = ''; render();
}

function resetDirectory() {
  directoryReader.cancel(); directorySnapshot=null; directoryLoading=false; directoryIssue='';
}
function acceptDirectory(result, target, preserve=false) {
  directorySnapshot={...result,nodeId:target}; rootDraft=result.path; draft.modelRoot=result.path;
  if (!preserve || !draft.modelPath) draft.modelPath=result.children[0]?.path || '';
  directoryIssue='';
}
async function loadDirectory(path,preserve=false) {
  const captured = epoch.current();
  const target=machineId; directoryLoading=true; directoryIssue=''; rootDraft=path; render();
  try {
    const result=await directoryReader.read(target,path);
    if (!result || target!==machineId || !epoch.isCurrent(captured)) return;
    acceptDirectory(result,target,preserve); directoryLoading=false; render();
  } catch(cause) {
    if (target!==machineId || !epoch.isCurrent(captured)) return;
    directoryLoading=false; directoryIssue=cause.message; directorySnapshot=null;
    if (!preserve) draft.modelPath=''; render();
  }
}
function renderDirectoryPicker() {
  if (!directoryPicker) return;
  const picker=directoryPicker;
  document.querySelector('#modal-root').innerHTML=`<div class="dialog-backdrop">${renderDirectoryDialog(picker.listing,{name:node().name,loading:picker.loading,error:picker.error,defaultPath:node().defaultModelRoot || DEFAULT_MODEL_ROOT})}</div>`;
}
async function navigateDirectory(path) {
  const picker=directoryPicker; if(!picker) return;
  const target=machineId; picker.loading=true; picker.error=''; picker.listing={...picker.listing,path,children:[]}; renderDirectoryPicker();
  try {
    const result=await directoryReader.read(target,path);
    if (!result || directoryPicker!==picker || machineId!==target) return;
    picker.listing=result; picker.loading=false; renderDirectoryPicker();
  } catch(cause) {
    if(directoryPicker!==picker || machineId!==target) return;
    picker.loading=false; picker.error=cause.message; renderDirectoryPicker();
  }
  document.querySelector('[data-action="cancel-directory"]')?.focus();
}
async function browseDirectory() {
  if(!connected() || busy || directoryLoading) return;
  const storageRoot=node().modelBrowseRoot || '/data';
  directoryPicker={listing:directorySnapshot || {root:storageRoot,path:rootDraft,parent:storageRoot,children:[]},loading:false,error:''};
  await navigateDirectory(rootDraft);
}
function chooseDirectory() {
  if(!directoryPicker || directoryPicker.loading || directoryPicker.error) return;
  acceptDirectory(directoryPicker.listing,machineId);
  closeDialog(); error=''; render(); document.querySelector('#model-path')?.focus();
}

function refreshMockTelemetry() {
  for (const machine of state.nodes) {
    for (const gpu of machine.gpus) {
      if (!gpu.deploymentId) { gpu.utilization = Math.min(gpu.utilization, 3); gpu.memoryUsed = Math.min(gpu.memoryUsed, 3); }
      else if (gpu.memoryUsed < 10) { gpu.memoryUsed = Math.round(gpu.memoryTotal * 0.9); gpu.utilization = 12; }
    }
  }
}

async function connectMachine() {
  if (connecting) return;
  const captured = epoch.current();
  connecting = true; error = ''; connectedId = null;
  const target = machineId;
  log(`连接 ${node().name} (${node().host})…`, 'muted');
  render();
  if (!demo) {
    try {
      const result = await api(`/api/control/nodes/${target}/connect`, { method: 'POST', body: {} });
      state.nodes = state.nodes.map((n) => n.id === target ? result : n);
      if (machineId === target) {
        connectedId = target;
        const selectedRoot=editingId ? rootDraft : result.defaultModelRoot || DEFAULT_MODEL_ROOT;
        await loadDirectory(selectedRoot,!!editingId);
      }
      if (!epoch.isCurrent(captured)) return;
      log(`已连接 ${result.name} · ${result.gpus.length} 张 GPU`, 'success');
      if (result.gpuError) log(result.gpuError, 'muted');
      if (result.modelError) log(result.modelError, 'muted');
    } catch (cause) { if (epoch.isCurrent(captured)) { error = cause.message; log(cause.message, 'muted'); } }
    finally { if (epoch.isCurrent(captured)) { connecting = false; render(); } }
    return;
  }
  setTimeout(async () => {
    connecting = false;
    if (machineId !== target) { render(); return; }
    connectedId = target;
    await loadDirectory(editingId ? rootDraft : DEFAULT_MODEL_ROOT,!!editingId);
    log(`演示连接成功 · ${node().gpus.length} 张 ${node().gpus[0].name.replace('NVIDIA ', '')}`, 'success');
    render();
  }, 650);
}

function completeDeployment(id) {
  setTimeout(() => {
    const item = deployment(id);
    if (!item || !['starting', 'restarting'].includes(item.status)) return;
    item.status = 'running'; item.uptime = '刚刚启动';
    refreshMockTelemetry(); save();
    log(`${item.alias} 已就绪。使用 model="${item.alias}" 调用统一 API。`, 'success');
    render();
  }, 1600);
}

async function deploy() {
  error = '';
  if (!connected()) { error = '请先连接部署机器'; render(); return; }
  const result = validateDraft(draft, state, editingId);
  if (!result.valid) { error = Object.values(result.errors).join('；'); render(); return; }
  if (!Number.isInteger(Number(draft.maxModelLen)) || Number(draft.maxModelLen) < 1 || !Number.isFinite(Number(draft.gpuMemoryUtilization)) || Number(draft.gpuMemoryUtilization) < 0.5 || Number(draft.gpuMemoryUtilization) > 0.98) { error = '显存比例必须为 0.50–0.98，请检查推理参数'; render(); return; }
  if (!demo) {
    const existingId = editingId; const submitted = structuredClone(draft);
    await runIntent(intent(existingId ? 'update' : 'create', existingId ? { id: existingId } : null, submitted), async item => {
      selectedId = item.id; rawLog = ''; lastRawLog = '';
      log(`${item.alias} · ${labels[item.status] || item.status} · GPU ${item.gpuIds.join(', ')}`);
      if (item.error) log(item.error, 'muted');
      editingId = null; editingRevision = null; draft = newDraft();
    });
    return;
  }
  try {
    const existingId = editingId;
    state = existingId ? updateDeployment(state, existingId, draft) : createDeployment(state, draft);
    selectedId = existingId || state.deployments[0].id;
    log(`${existingId ? '重启' : '启动'} ${draft.alias} · GPU ${draft.gpuIds.join(', ')} · TP ${draft.gpuIds.length}`, 'info');
    log('模拟加载模型权重…', 'muted');
    refreshMockTelemetry(); save();
    const id = selectedId;
    draft = newDraft(); editingId = null;
    render(); completeDeployment(id);
  } catch (cause) { error = cause.message; render(); }
}

function editService(id) {
  const item = deployment(id);
  if (!item) return;
  if (['starting', 'restarting'].includes(item.status)) { notify('服务正在启动，请稍后修改'); return; }
  machineId = item.nodeId;
  resetDirectory(); rootDraft = item.modelRoot || item.modelPath.slice(0,item.modelPath.lastIndexOf('/')) || '/';
  draft = structuredClone(item);
  editingRevision = item.revision; retryIntent = null;
  editingId = id; selectedId = id; rawLog = ''; lastRawLog = ''; runtimeLogError = ''; logState = 'loading'; activeView = 'deploy'; error = '';
  log(`载入 ${item.alias} 的部署配置。${connected() ? '修改后保存并重启。' : '请先连接对应机器。'}`, 'muted');
  render();
  if(connected()) loadDirectory(rootDraft,true);
  if (!demo) poll();
}

function requestStop(id) {
  const item = deployment(id);
  if (!item || item.status === 'stopped') return;
  confirmationIntent = demo ? null : intent('stop', item);
  document.querySelector('#modal-root').innerHTML = `<div class="dialog-backdrop"><section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="stop-title"><h2 id="stop-title">停止 ${esc(item.alias)}？</h2><p>停止后释放 GPU ${item.gpuIds.join(', ')}，部署配置会保留。</p><div><button class="button secondary" data-action="cancel-stop">取消</button><button class="button stop-button" data-confirm-stop="${id}">停止服务</button></div></section></div>`;
  document.querySelector('[data-action="cancel-stop"]').focus();
}
function requestDelete(id) {
  if (busy) return;
  const html = renderDeleteDialog(deployment(id));
  if (!html) { notify('只能删除已停止的服务，请先核对部署状态'); return; }
  confirmationIntent = demo ? null : intent('delete', deployment(id));
  document.querySelector('#modal-root').innerHTML = `<div class="dialog-backdrop">${html}</div>`;
  document.querySelector('[data-action="cancel-delete"]').focus();
}

async function confirmDelete(id) {
  const item = deployment(id); const frozen = confirmationIntent; const captured = epoch.current(); closeDialog();
  if (!renderDeleteDialog(item)) { notify('服务状态已变化，删除已取消'); return; }
  let confirmed = demo;
  if (!demo) {
    if (!frozen || frozen.id !== id || frozen.kind !== 'delete') return;
    const ok = await runIntent(frozen, async result => {
      if (result.id !== id || result.deleted !== true) throw new Error('后台未确认删除结果，请恢复连接后重试');
      confirmed = true;
      if (selectedId === id) { selectedId = null; rawLog = ''; lastRawLog = ''; runtimeLogError = ''; logState = 'idle'; }
      if (editingId === id) { editingId = null; editingRevision = null; draft = newDraft(); }
    });
    if (!epoch.isCurrent(captured)) return;
    if (!ok && !confirmed && deployment(id)) { notify(error || '删除结果尚未确认，请恢复连接后重试'); return; }
  } else { state = deleteDeployment(state, id); save(); }
  if (confirmed || !deployment(id)) {
    state.deployments = state.deployments.filter(candidate => candidate.id !== id);
    if (selectedId === id) { selectedId = null; rawLog = ''; lastRawLog = ''; runtimeLogError = ''; logState = 'idle'; }
    if (editingId === id) { editingId = null; draft = newDraft(); }
    error = ''; log(`已删除部署 ${item.alias}，模型文件与日志保留。`, 'success');
    render(); notify(`已删除 ${item.alias}`); if (!demo) poll();
  }
}
function closeDialog() {
  confirmationIntent = null;
  const wasDirectory=!!directoryPicker;
  if(wasDirectory) { directoryReader.cancel(); directoryPicker=null; }
  document.querySelector('#modal-root').innerHTML = '';
  if(wasDirectory) document.querySelector('#model-root')?.focus();
}
async function copy(text,message='已复制') {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const field = document.createElement('textarea'); field.value = text; field.readOnly = true; field.style.cssText = 'position:fixed;opacity:0';
      document.body.append(field); field.select();
      try { if (!document.execCommand('copy')) throw new Error(); } finally { field.remove(); }
    }
    notify(message);
  } catch { notify('复制不可用，请手动选择文本'); }
}

document.addEventListener('input', (event) => {
  const fields = { 'model-path': 'modelPath', 'service-alias': 'alias', 'gpu-memory': 'gpuMemoryUtilization' };
  if (fields[event.target.id]) { retryIntent = null; document.querySelector('[data-action="retry-mutation"]')?.remove(); draft[fields[event.target.id]] = event.target.value; updatePreview(); }
});
document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.id === 'machine') {
    retryIntent = null; editingRevision = null;
    machineId = target.value; connectedId = null; editingId = null; selectedId = null; rawLog = ''; lastRawLog = '';
    runtimeLogError = ''; logState = 'idle';
    closeDialog(); resetDirectory(); rootDraft = node().defaultModelRoot || DEFAULT_MODEL_ROOT;
    draft = newDraft(); error = '';
    logs = [{ time: 'READY', message: `已切换到 ${node().name}，等待连接。`, type: 'muted' }];
    render();
    if (!demo) poll();
  }
  if (target.id === 'log-service') selectService(target.value || null, 'logs');
  if (target.id === 'model-path') { draft.modelPath=target.value; updatePreview(); }
  if (target.id === 'max-model-len') { draft.maxModelLen = Number(target.value); updatePreview(); }
  if (target.id === 'model-dtype') { draft.dtype = target.value; updatePreview(); }
  if (['model-path', 'max-model-len', 'model-dtype'].includes(target.id)) { retryIntent = null; document.querySelector('[data-action="retry-mutation"]')?.remove(); }
});
document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  if (target.dataset.copyAlias) {
    const item=deployment(target.dataset.copyAlias);
    if (item) await copy(item.alias,`已复制 model：${item.alias}`);
    else notify('服务已移除，请刷新列表');
    return;
  }
  if (target.dataset.copyLocalApi) {
    const item = deployment(target.dataset.copyLocalApi); const machine = state.nodes.find(n => n.id === item?.nodeId);
    if (item && renderLocalApi(item, machine)) await copy(machine.inference.apiBase, `已复制：仅在 ${machine.name} 上调用`);
    return;
  }
  if (target.dataset.browsePath!==undefined) { await navigateDirectory(target.dataset.browsePath); return; }
  if (target.dataset.gpu !== undefined) {
    retryIntent = null;
    const id = Number(target.dataset.gpu);
    draft.gpuIds = draft.gpuIds.includes(id) ? draft.gpuIds.filter((value) => value !== id) : [...draft.gpuIds, id].sort((a, b) => a - b);
    error = ''; render(); document.querySelector(`[data-gpu="${id}"]`)?.focus(); return;
  }
  if (target.dataset.view) { activeView = target.dataset.view; render(); return; }
  if (target.dataset.select) { selectService(target.dataset.select, 'logs'); return; }
  if (target.dataset.edit) { editService(target.dataset.edit); return; }
  if (target.dataset.delete) { requestDelete(target.dataset.delete); return; }
  if (target.dataset.confirmDelete) { await confirmDelete(target.dataset.confirmDelete); return; }
  if (target.dataset.stop) { requestStop(target.dataset.stop); return; }
  if (target.dataset.confirmStop) {
    const item = deployment(target.dataset.confirmStop);
    if (!demo) {
      const frozen = confirmationIntent;
      closeDialog();
      if (!frozen || frozen.id !== target.dataset.confirmStop || frozen.kind !== 'stop') return;
      await runIntent(frozen, async result => { selectedId = frozen.id; log(`${result.alias} · ${labels[result.status] || result.status}`); });
      return;
    }
    state = stopDeployment(state, item.id); selectedId = item.id;
    refreshMockTelemetry(); save(); log(`${item.alias} 已停止，GPU ${item.gpuIds.join(', ')} 已释放。`, 'muted');
    if (editingId === item.id) { editingId = null; draft = newDraft(); }
    closeDialog(); render(); return;
  }
  if (target.dataset.start) {
    const item = deployment(target.dataset.start);
    if (connectedId !== item.nodeId) { editService(item.id); notify('先连接服务所在机器，再启动'); return; }
    if (!demo) {
      await runIntent(intent('start', item), async result => { selectedId = item.id; log(`${item.alias} · ${labels[result.status] || result.status}`); });
      return;
    }
    try {
      state = startDeployment(state, item.id); selectedId = item.id;
      refreshMockTelemetry(); save(); log(`重新启动 ${item.alias}…`); render(); completeDeployment(item.id);
    } catch (cause) { notify(cause.message); }
    return;
  }
  switch (target.dataset.action) {
    case 'logout': await logout(); break;
    case 'retry-mutation': { const retry = retryIntent; if (retry) await runIntent(retry.frozen, retry.onSuccess); break; }
    case 'settings': await showSettings(); break;
    case 'save-settings': await saveSettings(); break;
    case 'register-node': await saveSettings(true); break;
    case 'close-settings': closeDialog(); break;
    case 'browse-directory': await browseDirectory(); break;
    case 'choose-directory': chooseDirectory(); break;
    case 'cancel-directory': closeDialog(); break;
    case 'connect': connectMachine(); break;
    case 'deploy': deploy(); break;
    case 'clear-form': clearForm(); break;
    case 'toggle-gpus': retryIntent = null; draft.gpuIds = draft.gpuIds.length ? [] : node().gpus.filter(available).map((gpu) => gpu.id); render(); break;
    case 'refresh-gpus': if (!demo) { await poll(); } else { log('显卡状态已刷新（模拟数据）。', 'muted'); render(); } break;
    case 'copy-command': if (!draft.alias.trim() || !draft.gpuIds.length) { notify('请填写服务别名并选择 GPU'); break; } await copy(buildCommand(draft)); break;
    case 'copy-api': await copy(state.gateway.baseUrl); break;
    case 'clear-log': logs = []; rawLog = ''; render(); break;
    case 'refresh-log': lastRawLog = ''; runtimeLogError = ''; logState = 'loading'; render(); if (!demo) await poll(); break;
    case 'stop-selected': requestStop(selectedId); break;
    case 'cancel-stop': closeDialog(); break;
    case 'cancel-delete': closeDialog(); break;
  }
});
document.addEventListener('submit', event => { if (event.target.id === 'team-login') { event.preventDefault(); login(); } });
document.addEventListener('keydown', (event) => {
  const dialog = document.querySelector('.confirm-dialog');
  if (!dialog) return;
  if (event.key === 'Escape') closeDialog();
  if (event.key === 'Tab') {
    const buttons = [...dialog.querySelectorAll('button:not(:disabled), input, select')].filter((el) => el.getClientRects().length);
    if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
  }
});

render();
if (demo) { for (const item of state.deployments) if (['starting', 'restarting'].includes(item.status)) completeDeployment(item.id); }
else {
  const bootEpoch = epoch.current();
  requestApi('/api/session').then(async result => {
    if (!epoch.isCurrent(bootEpoch)) return;
    session = { ...result, ready: true }; render();
    if (session.authenticated) { await pullState(true); await poll(); }
  }).catch(cause => { if (epoch.isCurrent(bootEpoch)) { session.ready = true; loginMessage = cause.message; controlError = cause.message; error = cause.message; render(); } });
  setInterval(poll, 3000);
}
