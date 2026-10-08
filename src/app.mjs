import { createInitialState, createDeployment, updateDeployment, startDeployment, stopDeployment, validateDraft, escapeHtml as esc } from './app-state.mjs';
import { buildCommand } from './command.mjs';
import { api, emptyState, sharedState, readRuntime } from './api.mjs';

const STORE = 'gpu-monitor-preview-v1';
const demo = new URLSearchParams(location.search).get('demo') === '1';
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
let draft = newDraft();
let rootDraft = state.nodes[0]?.modelRoot || '';
let logs = [{ time: 'READY', message: '选择机器并连接，查看 GPU 状态。', type: 'muted' }];

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
  return { alias: '', nodeId: machineId, modelPath: machine?.models[0]?.path || '', gpuIds: [], maxModelLen: 32768, gpuMemoryUtilization: 0.9, dtype: 'auto' };
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
    return `<tr class="${selectedId === item.id ? 'selected-row' : ''}"><td><button class="service-name" data-select="${item.id}" title="选中服务查看日志">${esc(item.alias)}</button><small>${esc(item.modelPath.split('/').at(-1))}</small></td><td title="${esc(item.error || '')}">${status(item.status)}</td><td><span>${esc(machine?.name || '未知机器')}</span><small>GPU ${item.gpuIds.join(', ')} · TP ${item.tensorParallelSize}</small></td><td class="service-actions"><button class="tiny-button" data-edit="${item.id}" ${busy ? 'disabled' : ''}>${icon('edit')}修改</button><button class="tiny-button ${restartable ? '' : 'stop-text'}" data-${restartable ? 'start' : 'stop'}="${item.id}" ${busy ? 'disabled' : ''}>${icon(restartable ? 'play' : 'stop')}${restartable ? '启动' : '停止'}</button></td></tr>`;
  }).join('');
}

function render() {
  const machine = node();
  const selected = deployment(selectedId);
  document.querySelector('#app').innerHTML = `<main class="console">
    <header class="app-header"><div class="app-brand">${icon('gpu')}<h1>GPU Monitor</h1><span class="header-divider"></span><span class="header-label">推理部署</span></div><div class="header-tools"><a class="text-button" href="${demo ? '/' : '/?demo=1'}">${demo ? '真实模式' : '演示'}</a><span class="preview-label"><i></i>${demo ? '前端演示' : '共享控制节点'}</span>${demo ? '' : `<button class="icon-button" data-action="settings" aria-label="连接设置" title="连接设置">${icon('settings')}</button>`}</div></header>
    <div class="console-grid">
      <div class="config-column">
        <section class="panel connection-panel"><div class="panel-title">${icon('server')}<h2>机器连接</h2><span class="connection-state ${connected() ? 'online' : ''}"><i></i>${connecting ? '连接中…' : connected() ? demo ? '已连接 · 模拟' : '已连接' : '未连接'}</span></div><div class="connection-fields"><label class="grow">机器<select id="machine" aria-label="机器" ${connecting || busy || editingId ? 'disabled' : ''}>${!state.nodes.length ? '<option>请先在连接设置中添加机器</option>' : state.nodes.map((item) => `<option value="${esc(item.id)}" ${machineId === item.id ? 'selected' : ''}>${esc(item.name)} · ${esc(item.host)}</option>`).join('')}</select></label><button class="button ${connected() ? 'secondary' : 'primary'} connect-button" data-action="connect" ${connecting || busy || !machineId ? 'disabled' : ''}>${icon(connected() ? 'refresh' : 'link')}${connecting ? '连接中' : connected() ? '重新连接' : '连接机器'}</button></div></section>
        <section class="panel model-panel"><div class="panel-title">${icon('folder')}<h2>模型</h2>${editingId ? '<span class="editing-tag">修改部署</span><button class="text-button" data-action="clear-form">取消修改</button>' : ''}</div><label>模型目录<div class="directory-field"><input id="model-root" value="${esc(rootDraft)}" placeholder="/data/models" aria-label="模型目录"/><button class="icon-button" data-action="apply-directory" aria-label="保存模型目录" title="保存模型目录">${icon('check')}</button></div></label><div class="model-fields"><label class="model-path-field">模型路径<input id="model-path" list="available-models" value="${esc(draft.modelPath)}" placeholder="选择或输入远端模型路径" aria-label="模型路径"/><datalist id="available-models">${machine.models.map((model) => `<option value="${esc(model.path)}">${esc(model.alias)}</option>`).join('')}</datalist></label><label class="alias-field">服务别名<input id="service-alias" value="${esc(draft.alias)}" placeholder="例如 qwen-32b" aria-label="服务别名"/></label></div><p class="field-note">通过统一 API 的 <code>model</code> 字段调用此别名。</p></section>
        <section class="panel gpu-select-panel"><div class="panel-title">${icon('gpu')}<h2>GPU 选择</h2><span class="section-meta">独占分配</span>${connected() ? `<button class="text-button" data-action="toggle-gpus">${draft.gpuIds.length ? '取消全选' : '选择空闲'}</button>` : ''}</div>${gpuChoices()}<div class="selection-footer"><span>已选 <strong>${draft.gpuIds.length}</strong> 张 GPU</span><span>Tensor Parallel <strong>${draft.gpuIds.length || '—'}</strong></span></div></section>
        <details class="panel params-panel" open><summary>${icon('settings')}<h2>vLLM 参数</h2><span class="section-meta">引擎 vLLM</span>${icon('down')}</summary><div class="parameter-fields"><label>最大上下文<select id="max-model-len" aria-label="最大上下文">${[8192, 16384, 32768, 65536, 131072].map((value) => `<option value="${value}" ${Number(draft.maxModelLen) === value ? 'selected' : ''}>${value.toLocaleString()}</option>`).join('')}</select></label><label>显存比例<input id="gpu-memory" type="number" min="0.5" max="0.98" step="0.01" value="${draft.gpuMemoryUtilization}" aria-label="显存比例"/></label><label>精度<select id="model-dtype" aria-label="精度">${['auto', 'bfloat16', 'float16'].map((value) => `<option ${draft.dtype === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label></div></details>
      </div>
      <div class="runtime-column">
        <section class="action-panel"><button class="button primary deploy-button" data-action="deploy" ${connected() && !connecting && !busy && !machine.gpuError && machine.gpus.length ? '' : 'disabled'}>${icon(editingId ? 'refresh' : 'play')}${busy ? '处理中…' : editingId ? '保存并重启部署' : '启动部署'}</button><div class="action-row"><button class="button stop-button" data-action="stop-selected" ${selected && selected.status !== 'stopped' && !busy ? '' : 'disabled'}>${icon('stop')}停止${selected ? '选中服务' : ''}</button><button class="button secondary" data-action="clear-form" ${busy ? 'disabled' : ''}>${icon('clear')}清空</button><button class="button secondary" data-action="copy-command">${icon('copy')}复制命令</button></div><div id="error-box" class="form-error" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</div></section>
        <details class="panel command-panel" ${commandOpen ? 'open' : ''}><summary>${icon('terminal')}<h2>启动命令</h2>${icon('down')}</summary><pre id="command-text">${esc(buildCommand(draft))}</pre></details>
        <section class="log-panel"><div class="panel-title">${icon('terminal')}<h2>部署日志</h2><button class="text-button" data-action="clear-log">清空显示</button></div><div class="terminal" role="log" aria-label="部署日志" aria-live="polite">${terminalContent()}</div></section>
        <section class="panel gpu-status-panel"><div class="panel-title">${icon('gpu')}<h2>显卡状态</h2>${connected() ? `<span class="section-meta">${machine.gpus.length} 张</span><button class="icon-button" data-action="refresh-gpus" aria-label="刷新显卡状态" title="刷新状态">${icon('refresh')}</button>` : ''}</div>${gpuStatus()}</section>
      </div>
    </div>
    <section class="panel services-panel"><div class="panel-title">${icon('server')}<h2>已部署服务</h2><span class="section-meta">${state.deployments.length} 个</span><div class="api-inline"><span>统一 API</span><code>${esc(state.gateway.baseUrl)}</code><button class="icon-button" data-action="copy-api" aria-label="复制统一 API 地址" title="复制 API 地址">${icon('copy')}</button></div></div><div class="services-table-wrap"><table class="services-table"><thead><tr><th>服务别名 / 模型</th><th>状态</th><th>机器 / GPU</th><th class="align-right">操作</th></tr></thead><tbody>${serviceRows()}</tbody></table></div></section>
    <footer><span id="control-status"><i class="demo-dot"></i>${demo ? '机器连接、显卡指标与部署日志均为模拟数据。' : esc(controlError || '本地客户端 · 部署状态由共享控制节点同步')}</span><span>vLLM · GPU 独占</span></footer>
  </main>`;
  document.title = 'GPU Monitor · 推理部署';
  document.querySelector('.command-panel')?.addEventListener('toggle', (event) => { commandOpen = event.target.open; });
  const terminal = document.querySelector('.terminal');
  terminal.scrollTop = terminal.scrollHeight;
}

function terminalContent() {
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
  document.querySelector('.api-inline code').textContent = state.gateway.baseUrl;
  document.querySelector('#control-status').textContent = controlError || '本地客户端 · 部署状态由共享控制节点同步';
  const connection = document.querySelector('.connection-state');
  connection.classList.toggle('online', connected()); connection.innerHTML = `<i></i>${connected() ? '已连接' : '未连接'}`;
  document.querySelector('[data-action="deploy"]').disabled = !connected() || busy || !!node().gpuError || !node().gpus.length;
  const terminal = document.querySelector('.terminal');
  const nearBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 40;
  const content = terminalContent(); if (terminal.innerHTML !== content) { terminal.innerHTML = content; if (nearBottom) terminal.scrollTop = terminal.scrollHeight; }
  document.querySelector('#available-models').innerHTML = node().models.map((m) => `<option value="${esc(m.path)}">${esc(m.alias)}</option>`).join('');
}
async function pullState(full = false, snapshot = null) {
  const previousIds = state.nodes.map((n) => n.id).join(',');
  state = sharedState(snapshot || await api('/api/control/state')); controlError = '';
  if (!state.nodes.some((n) => n.id === machineId)) {
    machineId = state.nodes[0]?.id || ''; connectedId = null; rootDraft = node().modelRoot; draft = newDraft(); full = true;
  }
  if (previousIds !== state.nodes.map((n) => n.id).join(',')) full = true;
  if (full) render(); else updateRuntime();
}
async function poll() {
  if (demo || busy || polling || document.hidden) return;
  polling = true;
  try {
    const id = selectedId;
    const result = await readRuntime(api, id);
    await pullState(false, result.snapshot);
    if (selectedId === id) {
      if (result.logs !== null && result.logs !== lastRawLog) { rawLog = result.logs; lastRawLog = result.logs; }
      if (result.logError && !logs.some((l) => l.message === `日志读取失败：${result.logError}`)) log(`日志读取失败：${result.logError}`, 'muted');
      updateRuntime();
    }
  } catch (cause) {
    controlError = cause.message;
    for (const n of state.nodes) { n.status = 'offline'; n.gpus = []; }
    for (const s of state.deployments) s.status = 'unknown';
    updateRuntime();
  } finally { polling = false; }
}
async function perform(work) {
  if (busy) return false;
  busy = true; error = ''; render();
  try { await work(); await pullState(); return true; }
  catch (cause) { error = cause.message; log(cause.message, 'muted'); await pullState().catch(() => {}); return false; }
  finally { busy = false; render(); }
}
async function showSettings() {
  let settings;
  try { settings = await api('/api/local/settings'); } catch (cause) { notify(cause.message); return; }
  document.querySelector('#modal-root').innerHTML = `<div class="dialog-backdrop"><section class="confirm-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><h2 id="settings-title">连接设置</h2><p>每位用户连接同一个控制节点，共享机器和部署。</p><label>控制节点地址<input id="controller-url" value="${esc(settings.controllerUrl)}" placeholder="http://控制节点IP:8080" aria-label="控制节点地址"/></label><label>管理密钥<input id="admin-token" type="password" autocomplete="off" placeholder="${settings.configured ? '已保存，留空保持不变' : '控制节点 adminToken'}" aria-label="管理密钥"/></label><div class="settings-actions"><button class="button primary" data-action="save-settings">保存并连接</button></div><details><summary>添加 / 更新机器</summary><label>机器名称<input id="agent-name" placeholder="例如 gpu-01" aria-label="机器名称"/></label><label>Agent 地址<input id="agent-url" placeholder="http://机器IP:9000" aria-label="Agent 地址"/></label><label>Agent 密钥<input id="agent-token" type="password" autocomplete="off" aria-label="Agent 密钥"/></label><div class="settings-actions"><button class="button secondary" data-action="register-node">添加机器</button></div></details><p class="settings-error" role="alert"></p><div class="settings-actions"><button class="button secondary" data-action="close-settings">关闭</button></div></section></div>`;
  document.querySelector('#controller-url').focus();
}
async function saveSettings(register = false) {
  const button = document.querySelector(`[data-action="${register ? 'register-node' : 'save-settings'}"]`);
  if (button.disabled) return;
  button.disabled = true; const dialogError = document.querySelector('.settings-error'); dialogError.textContent = '';
  try {
    if (register) await api('/api/control/nodes', { method: 'POST', body: { name: document.querySelector('#agent-name').value, url: document.querySelector('#agent-url').value, token: document.querySelector('#agent-token').value } });
    else await api('/api/local/settings', { method: 'PUT', body: { controllerUrl: document.querySelector('#controller-url').value, adminToken: document.querySelector('#admin-token').value } });
    await pullState(true); rootDraft = node().modelRoot; draft = newDraft(); render();
    document.querySelector(register ? '#agent-token' : '#admin-token').value = '';
    notify(register ? '机器已添加，选择后连接' : '已连接共享控制节点');
  } catch (cause) { if (dialogError.isConnected) dialogError.textContent = cause.message; }
  finally { if (button.isConnected) button.disabled = false; }
}

function clearForm() {
  editingId = null; selectedId = null; rawLog = ''; lastRawLog = ''; draft = newDraft(); error = ''; render();
}

async function applyDirectory() {
  const root = rootDraft.trim().replace(/\/+$/, '') || '/';
  if (!root.startsWith('/')) { notify('模型目录需要使用绝对路径'); return; }
  if (!demo) {
    if (!connected()) { notify('请先连接机器'); return; }
    await perform(async () => { const result = await api(`/api/control/nodes/${machineId}/model-root`, { method: 'PUT', body: { modelRoot: root } }); rootDraft = result.modelRoot; log(`模型目录已切换到 ${result.modelRoot}`); });
    return;
  }
  const oldRoot = node().modelRoot;
  node().modelRoot = root;
  rootDraft = root;
  node().models = node().models.map((model) => ({ ...model, path: `${root === '/' ? '' : root}/${model.alias}` }));
  if (draft.modelPath.startsWith(oldRoot + '/')) draft.modelPath = (root === '/' ? '' : root) + draft.modelPath.slice(oldRoot.length);
  save(); render(); notify('模型目录已保存（本地演示）');
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
  connecting = true; error = ''; connectedId = null;
  const target = machineId;
  log(`连接 ${node().name} (${node().host})…`, 'muted');
  render();
  if (!demo) {
    try {
      const result = await api(`/api/control/nodes/${target}/connect`, { method: 'POST', body: {} });
      state.nodes = state.nodes.map((n) => n.id === target ? result : n);
      if (machineId === target) { connectedId = target; rootDraft = result.modelRoot; if (!draft.modelPath) draft.modelPath = result.models[0]?.path || ''; }
      log(`已连接 ${result.name} · ${result.gpus.length} 张 GPU`, 'success');
      if (result.gpuError) log(result.gpuError, 'muted');
      if (result.modelError) log(result.modelError, 'muted');
    } catch (cause) { error = cause.message; log(cause.message, 'muted'); }
    finally { connecting = false; render(); }
    return;
  }
  setTimeout(() => {
    connecting = false;
    if (machineId !== target) { render(); return; }
    connectedId = target;
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
    await perform(async () => {
      const item = await api(existingId ? `/api/control/deployments/${existingId}` : '/api/control/deployments', { method: existingId ? 'PATCH' : 'POST', body: submitted });
      selectedId = item.id; rawLog = ''; lastRawLog = '';
      log(`${item.alias} · ${labels[item.status] || item.status} · GPU ${item.gpuIds.join(', ')}`);
      if (item.error) log(item.error, 'muted');
      editingId = null; draft = newDraft();
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
  rootDraft = node().modelRoot;
  draft = structuredClone(item);
  editingId = id; selectedId = id; rawLog = ''; lastRawLog = ''; error = '';
  log(`载入 ${item.alias} 的部署配置。${connected() ? '修改后保存并重启。' : '请先连接对应机器。'}`, 'muted');
  render();
  document.querySelector('.connection-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function requestStop(id) {
  const item = deployment(id);
  if (!item || item.status === 'stopped') return;
  document.querySelector('#modal-root').innerHTML = `<div class="dialog-backdrop"><section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="stop-title"><h2 id="stop-title">停止 ${esc(item.alias)}？</h2><p>停止后释放 GPU ${item.gpuIds.join(', ')}，部署配置会保留。</p><div><button class="button secondary" data-action="cancel-stop">取消</button><button class="button stop-button" data-confirm-stop="${id}">停止服务</button></div></section></div>`;
  document.querySelector('[data-action="cancel-stop"]').focus();
}
function closeDialog() { document.querySelector('#modal-root').innerHTML = ''; }
async function copy(text) {
  try { await navigator.clipboard.writeText(text); notify('已复制'); } catch { notify('复制不可用，请手动选择文本'); }
}

document.addEventListener('input', (event) => {
  if (event.target.id === 'model-root') rootDraft = event.target.value;
  const fields = { 'model-path': 'modelPath', 'service-alias': 'alias', 'gpu-memory': 'gpuMemoryUtilization' };
  if (fields[event.target.id]) { draft[fields[event.target.id]] = event.target.value; updatePreview(); }
});
document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.id === 'machine') {
    machineId = target.value; connectedId = null; editingId = null; selectedId = null; rawLog = ''; lastRawLog = '';
    rootDraft = node().modelRoot;
    draft = newDraft(); error = '';
    logs = [{ time: 'READY', message: `已切换到 ${node().name}，等待连接。`, type: 'muted' }];
    render();
  }
  if (target.id === 'max-model-len') { draft.maxModelLen = Number(target.value); updatePreview(); }
  if (target.id === 'model-dtype') { draft.dtype = target.value; updatePreview(); }
});
document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  if (target.dataset.gpu !== undefined) {
    const id = Number(target.dataset.gpu);
    draft.gpuIds = draft.gpuIds.includes(id) ? draft.gpuIds.filter((value) => value !== id) : [...draft.gpuIds, id].sort((a, b) => a - b);
    error = ''; render(); document.querySelector(`[data-gpu="${id}"]`)?.focus(); return;
  }
  if (target.dataset.select) { selectedId = target.dataset.select; rawLog = ''; lastRawLog = ''; render(); if (!demo) poll(); return; }
  if (target.dataset.edit) { editService(target.dataset.edit); return; }
  if (target.dataset.stop) { requestStop(target.dataset.stop); return; }
  if (target.dataset.confirmStop) {
    const item = deployment(target.dataset.confirmStop);
    if (!demo) {
      closeDialog();
      await perform(async () => { const result = await api(`/api/control/deployments/${item.id}/stop`, { method: 'POST', body: {} }); selectedId = item.id; log(`${item.alias} · ${labels[result.status] || result.status}`); });
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
      await perform(async () => { const result = await api(`/api/control/deployments/${item.id}/start`, { method: 'POST', body: {} }); selectedId = item.id; log(`${item.alias} · ${labels[result.status] || result.status}`); });
      return;
    }
    try {
      state = startDeployment(state, item.id); selectedId = item.id;
      refreshMockTelemetry(); save(); log(`重新启动 ${item.alias}…`); render(); completeDeployment(item.id);
    } catch (cause) { notify(cause.message); }
    return;
  }
  switch (target.dataset.action) {
    case 'settings': await showSettings(); break;
    case 'save-settings': await saveSettings(); break;
    case 'register-node': await saveSettings(true); break;
    case 'close-settings': closeDialog(); break;
    case 'apply-directory': applyDirectory(); break;
    case 'connect': connectMachine(); break;
    case 'deploy': deploy(); break;
    case 'clear-form': clearForm(); break;
    case 'toggle-gpus': draft.gpuIds = draft.gpuIds.length ? [] : node().gpus.filter(available).map((gpu) => gpu.id); render(); break;
    case 'refresh-gpus': if (!demo) { await poll(); } else { log('显卡状态已刷新（模拟数据）。', 'muted'); render(); } break;
    case 'copy-command': if (!draft.alias.trim() || !draft.gpuIds.length) { notify('请填写服务别名并选择 GPU'); break; } await copy(buildCommand(draft)); break;
    case 'copy-api': await copy(state.gateway.baseUrl); break;
    case 'clear-log': logs = []; rawLog = ''; render(); break;
    case 'stop-selected': requestStop(selectedId); break;
    case 'cancel-stop': closeDialog(); break;
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.id === 'model-root') { event.preventDefault(); applyDirectory(); return; }
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
  pullState(true).catch((cause) => { controlError = cause.message; error = cause.message; render(); });
  setInterval(poll, 3000);
}
