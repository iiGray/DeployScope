# DeployScope Shared Console and Local Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持团队直接访问共享网页、独立填写部署草稿、按提交顺序独占 GPU，并让推理只在模型所在服务器本机发生。

**Architecture:** 6kd_7 提供认证后的共享 Console 和单一 Controller，两台服务器各自的 Agent 附带回环推理网关。Controller 串行处理部署写操作、持久化请求身份和版本；Agent 最终检查和保留 GPU，浏览器只维护自己的草稿。

**Tech Stack:** 现有 Node.js ESM、node:http、node:crypto、JSON 原子持久化、原生 HTML/CSS/JavaScript、node:test；不新增产品依赖。

**Spec:** `docs/superpowers/specs/2026-10-10-shared-console-local-inference-design.md`（用户已确认）。

## Global Constraints

- 生产网页端口 15173；6kd_7 Controller 为 `127.0.0.1:18081`；两台本机推理网关均为 `127.0.0.1:18080`；Agent 19000 保留现有网络限制。
- 候选团队入口 `http://174.1.59.7:15173`，只能在已确认可信管理网络/VPN 或有效 HTTPS 保护下启用；不能把候选地址当成上线证据。
- 会话最长 12 小时，HttpOnly、SameSite=Strict，HTTPS 下 Secure；网页口令与管理/推理密钥分开，原始口令不进 Git、URL、截图或日志。
- 先到先占按有效请求进入 Controller 写队列的顺序；多卡全有或全无；starting 状态即保留；冲突 409，不抢占、不自动等待空闲资源。
- 已确认请求记录保留 7 天、最多 10000 条；未确认记录独立保留；旧部署 revision 初始化为 1，健康轮询不增加版本。
- 原有仅本地模式保持兼容；生产新模式禁用 Controller 跨机推理及 Agent 管理端口推理，生产网关不能根据远程地址转发。
- 保留模型、部署 ID、别名、日志、归档、物理 GPU 身份和所有前序 UI 功能；不安装 vLLM、不运行生产 GPU 测试、不终止外部作业。
- 工作区已有前序未提交修改。执行时先按 using-git-worktrees 检查隔离条件并保存、核对基线，不 reset、不遗失这些功能；任务提交只包含可明确归属的改动，不使用 `git add .`。
- 每个任务按红—绿测试周期实施。首次修改前运行 `npm test`、`npm run check` 记录现有基线；提交前检查实际差量和 `git diff --check`。

## Review Focus

1. Controller 在接受请求后、收到 Agent 结果前退出：恢复后同 requestId 不能重复启动或停止后来的服务（Task 3）。
2. 伪造 Host、Origin、X-Forwarded-* 或 Cookie：不能访问共同状态、改变全局代理或绕过登录限速（Task 2）。
3. 删除确认框打开后其他人启动/修改服务：原确认版本不能删除新状态（Task 3、4）。
4. 主进程退出但进程组仍存活，或资源检查后启动失败：不能错误释放活进程的 GPU，不能遗留部分多卡保留（Task 3）。
5. 退出/会话失效或切换机器后，旧目录/日志请求才返回：不能恢复上一会话的数据或覆盖当前草稿（Task 4）。

## File Structure

- 新增 `backend/local-inference.mjs`：本机 OpenAI 兼容入口；修改 `backend/agent.mjs`、`backend/controller.mjs`、`backend/cli.mjs` 接入和隔离。
- 新增 `backend/sessions.mjs`：口令校验、浏览器会话及登录限速；修改 `backend/console.mjs` 接入共享访问，`backend/common.mjs` 提供有接收时限的 JSON 请求读取；`backend/config.mjs` 保留旧初始化默认值。
- 新增 `backend/mutations.mjs`：请求指纹、持久化收据和裁剪；修改 Controller/Agent 的既有写队列，不把整个管理器无关重构。
- 新增 `src/shared-session.mjs`、`src/mutation.mjs`：登录代际与冻结提交意图；修改 `src/api.mjs`、`src/app.mjs`、`src/app-state.mjs`、`src/styles.css`、`index.html`。
- 新增各组件的 node:test 文件及 `tests/fixtures/shared-cluster.mjs`，扩展现有 Agent/Controller/API/UI 测试和 CPU 浏览器夹具。
- 更新 `README.md`、`docs/deployment.md`；新增 `docs/shared-console-runbook.md`，写入精确迁移检查及回滚边界，不写实际密钥。

## Execution Preparation

- [ ] 读取 using-git-worktrees 并检查已有工作区附件。保存当前 HEAD 和源码差量，核对前序改动来源；只有能够证明是前序已完成任务的源码才可独立形成基线提交，不提交任何私有状态。不确定归属的修改保持原样并报告；新隔离工作区必须包含这些既有功能，不能从裸旧 HEAD 开始而丢掉功能。
- [ ] 在实际执行目录运行 `npm test`、`npm run check`、`git diff --check`，记录基线。提交审核清楚的基线后，再在选定执行方式下逐任务实施；基线已失败则先报告和诊断，不能把无关修复混进本计划。

---

### Task 1: 每个 Agent 的独立本机推理网关

**Files:** Create `backend/local-inference.mjs`, `tests/local-inference.test.mjs`, `tests/cli.test.mjs`; modify `backend/agent.mjs:77-85,236-269`, `backend/controller.mjs:178-194`, `backend/cli.mjs:15-34`.

**Interfaces:**
- `createLocalInference(manager, { port = 18080, apiKeys, inferenceTimeoutMs }) -> { server, close }`；创建而不自动监听。CLI 强制 `127.0.0.1`，close 幂等。
- `AgentManager.localModels() -> Promise<Array<{id,object,created,owned_by}>>`；`AgentManager.localTarget(alias) -> Promise<{url,apiKey,alias}>`，只允许本管理器内的就绪记录。
- `agent.localInference = { enabled:true, port:18080, apiKeys:[独立密钥] }`；`createAgent()` 增加可选 `localInference` 返回值，Agent close 同时关闭网关。公开快照只新增 `inference: { scope:'server-local', apiBase }`，不返回 key/实例端口。
- `controller.inferenceEnabled:false` 禁用旧 `/v1/*`，共同状态返回 `inferenceMode:'per-node', apiBase:null`；旧模式保持原 apiBase。启用 Agent 本机网关时管理端口的 `/api/deployments/:id/inference/*` 返回 404；未启用的新旧模式不混用。

- [ ] **Step 1: Write failing tests.** 复用 `fixtureDirectory`, `fixtureExecutable`, `telemetry`, `draft`, `listen`, `waitFor` 创建两个真实 HTTP Agent/网关；Node 假进程代替 vLLM。
  ```js
  // Test: local gateway cannot discover or invoke another agent's alias
  assert.deepEqual((await clientA.models()).data.map(m => m.id), ['model-a']);
  assert.equal((await clientA.chat('model-b')).status, 404);
  assert.equal((await clientA.chat('model-a', keyB)).status, 401);
  assert.equal((await agentA.managementInference('model-a')).status, 404);
  // Test: disabled controller inference never reaches an agent
  assert.equal((await disabledController('/v1/models')).status, 404);
  ```
  测试文件内部定义 `clientA.models/chat` 和 managementInference HTTP 帮助函数。另测 starting/stopped 排除、SSE 首块先到、并发推理不串行、断开取消、关闭释放监听/锁、无效密钥初始化失败后可重新创建 Agent。
- [ ] **Step 2: Verify red.** Run `node --test tests/local-inference.test.mjs tests/cli.test.mjs`; expected missing export/新模式断言失败，不以测试夹具异常充当红灯。
- [ ] **Step 3: Implement the interfaces.** 使用 Agent 的既有身份检查、私有实例密钥和 `relay()`，取目标时只短暂使用管理器队列，不把响应流放进队列。CLI 同步处理 companion 启动失败与关闭；本机网关身份和端口出现在健康检查，不返回密钥。
- [ ] **Step 4: Verify green and compatibility.** Run `node --test tests/local-inference.test.mjs tests/cli.test.mjs tests/agent.test.mjs tests/controller.test.mjs tests/relay.test.mjs`; expected all pass。CLI 子进程测试用临时配置、模型目录和空闲端口，确认 gateway 不监听外部地址；不操作生产配置。
- [ ] **Step 5: Commit this task's reviewed delta.** Message `feat: add agent-local inference gateways`；只暂存本任务已核对文件/差量。

### Task 2: 认证后的共享网页与固定服务端连接

**Files:** Create `backend/sessions.mjs`, `tests/sessions.test.mjs`, `tests/shared-console.test.mjs`, `tests/fixtures/shared-cluster.mjs`; modify `backend/console.mjs`, `backend/common.mjs`, `backend/cli.mjs`, `backend/config.mjs`.

**Interfaces:**
- `hashPassword(password) -> Promise<string>`：scrypt，随机 16-byte salt、64-byte 输出，格式 `scrypt$<saltHex>$<hashHex>`；无效格式在初始化拒绝。`createSessions({passwordHash, secureCookies=false}, {now=Date.now}) -> {login, require, logout, close}`。
- `login(request,response,password) -> Promise<{authenticated:true}>`；`require(request) -> session` 或抛 401；`logout(request,response)` 清 Cookie。Cookie 名 `deployscope_session`、Path=/、Max-Age=43200。
- `console.mode:'shared'`, `host`, `publicOrigins:string[]`, `trustedNetwork:true`（仅网络核实后设置）, `passwordHash`, `controllerUrl`, `adminToken`；共享模式忽略旧 settingsFile 中的连接覆盖，PUT `/api/local/settings` 返回 405。非回环 HTTP 且没有可信网络声明时拒绝启动。
- GET `/api/session` 返回 `{mode:'local'|'shared',authenticated:boolean,configured:boolean}`；POST `/api/session/login` body `{password}`；POST `/api/session/logout`。认证后的 GET `/api/local/settings` 返回只读 `{mode,controllerUrl,configured}`；共享模式不允许 PUT。
- `bodyJson(request,maxBytes=1048576,{timeoutMs}={}) -> Promise<object>`：新增可选接收时限，不改变旧调用；读完 body 清理计时器，不能把远端管理操作或 SSE 的总时长错误限制为 15 秒。
- `sharedCluster(t,{guardedMutations=false}) -> {baseUrl,origin,controller,agents,models,clients:[a,b],cleanupWith}`；`client.request(path,{method='GET',body,headers={}})`、`client.login(password)`、只读 `client.cookie`。测试 helper 使用真实会话 Cookie；Node HTTP 测试通过固定 Host `console.test:15173` 与同源 Origin 请求随机端口，不借此放宽生产 Host。

- [ ] **Step 1: Write failing tests.** 验证两次登录产生不同 Cookie、口令不出现在持久化配置或状态、固定代理不能被另一会话改写、未登录不能读任何 `/api/control/*`。
  ```js
  // Test: shared sessions are independent, expire at 12 hours, and logout revokes only one
  assert.equal((await a.request('/api/control/state')).status, 401);
  await a.login(password); await b.login(password);
  assert.notEqual(a.cookie, b.cookie);
  await a.request('/api/session/logout', {method:'POST',body:{}});
  assert.equal((await a.request('/api/control/state')).status, 401);
  assert.equal((await b.request('/api/control/state')).status, 200);
  ```
  sessions 单测注入时钟，43200000ms 后失效。另测 Cookie 篡改、错误/缺失 Origin、非许可 Host、伪造 X-Forwarded-*、口令长度及非法 hash。相同 socket 来源每 10 分钟最多 10 次失败登录，第 11 次 429；不能用转发头换来源，限速表及时裁剪。
- [ ] **Step 2: Verify red.** Run `node --test tests/sessions.test.mjs tests/shared-console.test.mjs`; expected缺失功能及鉴权断言失败。
- [ ] **Step 3: Implement the interfaces.** scrypt 使用异步 crypto API，常量时间比较；仅从 socket 取来源，限制并发口令校验。会话内存保存，服务重启要求重新登录。共享模式校验配置 Origin 的 authority 而非信任请求 Host；请求体上限登录 4KiB、管理 1MiB，接收超时 15 秒。拒绝超限请求但不中断其他会话。
- [ ] **Step 4: Verify green.** Run `node --test tests/sessions.test.mjs tests/shared-console.test.mjs tests/console.test.mjs tests/cli.test.mjs`; expected all pass，包含旧本地模式 Host/Origin、固定资产允许名单和 0600 私有文件保护。
- [ ] **Step 5: Commit reviewed delta.** Message `feat: support authenticated shared console access`；不提交运行配置、原始口令或测试截图。

### Task 3: 持久化提交身份、版本与 GPU 先到先占

**Files:** Create `backend/mutations.mjs`, `tests/mutations.test.mjs`, `tests/shared-mutations.test.mjs`; modify `backend/controller.mjs`, `backend/agent.mjs`, `tests/controller.test.mjs`, `tests/agent.test.mjs`, `tests/fixtures/shared-cluster.mjs`.

**Interfaces:**
- `fingerprintMutation({kind,serviceId=null,payload}) -> string`：固定键序列、规范化业务参数与 expectedRevision，不包含 requestId；`getReceipt(data,requestId,fingerprint) -> receipt|null`，载荷不一致抛 409；`pruneReceipts(receipts,now) -> receipts`。
- 两种管理器状态增加 `mutationReceipts`，收据 `{requestId,fingerprint,kind,serviceId,status:'pending'|'confirmed'|'rejected',acceptedAt,completedAt?,submissionSeq?,result?,error?}`。requestId/operationId 为 1–80 位 ASCII 字母、数字、下划线或短横线，kind 为 create/update/start/stop/delete。Controller 的 `lastSubmissionSeq` 旧数据初始化 0，每次新有效提交加 1，重放不增加。写入收据与其状态更改共用现有原子 persist，不单独创建不可一致的第二个文件。
- `controller.multiUser:true` 开启约束；POST create body 必须含 requestId；PATCH、POST start/stop、DELETE body 必须含 requestId 和 expectedRevision。旧模式仍接受旧 body。
- `ControllerManager.action(id,action,input={})`、`remove(id,input={})`；create/update 仍用现有签名。服务公开字段增加 revision、submissionSeq；Controller 保有版本，Agent 快照不能覆盖或漏掉它。
- `agent.coordinatedWrites:true` 要求由 Controller 下发稳定 operationId；`AgentManager.start(id,input={})`、`stop(id,input={})`、`remove(id,input={})` 对已执行 operationId 只回放，不重新执行。create ID 固定，update 保留 appliedOperationId 的现有对账规则；后台刷新识别结果，不误认其他操作为本次确认。

- [ ] **Step 1: Write failing tests.** HTTP 队列测试先发送 A 并等待测试端受控栅栏证明其已进入 Agent 资源检查，再发送 B；不是只用 Promise.all 后猜测谁先到。
  ```js
  // Test: first admitted valid submission owns all requested GPUs
  assert.deepEqual([first.status, later.status], [201, 409]);
  assert.deepEqual(ownedGpuIds, [0, 1]);
  assert.equal(secondAliasExists, false);
  // Test: same request replay does not start another child or consume another revision
  assert.equal(replayed.id, firstBody.id);
  assert.equal(replayed.revision, firstBody.revision);
  assert.equal(agentOwnedProcessCount, 1);
  ```
  另测不同机器 GPU0 不冲突、多卡含一张忙卡不部分占用、starting 保留、外部进程不被终止、failed 且无进程才释放、主进程退出但进程组活着仍占用。收据单测验证 7 天/10000 已确认裁剪、pending 永不裁剪、同 ID 不同载荷 409。
- [ ] **Step 2: Verify red.** Run `node --test tests/mutations.test.mjs tests/shared-mutations.test.mjs`; expected缺失收据/版本规则失败。
- [ ] **Step 3: Implement queue-atomic mutation admission.** 请求基本格式校验之后、入队之前不再 await 远程状态；队列内持久化单调提交序号、稳定部署/操作 ID 和 pending 收据，再调用 Agent。校验 expectedRevision 在副作用之前；已接受/未知结果占新版本，确定无副作用的 4xx 保持版本。Agent 在同一队列内完整资源检查、持久化整组 starting 保留后启动；确认收据与状态一起持久化。Controller 重试 pending 使用原 Agent operationId，不生成新 ID、不抢先校验旧版本；不同意图不得绕过 pending。
- [ ] **Step 4: Add and verify recovery/conflict tests.** 向 Agent 送达请求后丢弃响应，重启 Controller，然后重放相同请求；断言 child 计数与 revision 不变。另测 Agent 完成 start/stop 后 Controller 退出、后续新状态不能被旧 operationId 重放破坏；两份 expectedRevision=1 修改仅一份成功；先打开 stopped 删除快照再启动，旧 DELETE 409 且进程仍活。轮询不涨版本。Run `node --test tests/shared-mutations.test.mjs tests/controller.test.mjs tests/agent.test.mjs tests/mutations.test.mjs`; expected all pass。
- [ ] **Step 5: Commit reviewed delta.** Message `feat: serialize shared mutations with revisions and replay protection`；提交前全文检查 unknown/orphaned/deletePending、目录 realpath 和归档保护的差量。

### Task 4: 浏览器会话、独立草稿与每服务本机 API

**Files:** Create `src/shared-session.mjs`, `src/mutation.mjs`, `tests/shared-session.test.mjs`, `tests/client-mutation.test.mjs`; modify `src/api.mjs`, `src/app.mjs`, `src/app-state.mjs`, `src/styles.css`, `index.html`, `backend/console.mjs`（新增资产白名单）, `tests/api.test.mjs`, `tests/app-state.test.mjs`.

**Interfaces:**
- `createSessionEpoch() -> {current,advance,isCurrent}`：登录、退出或 401 时 advance；所有异步界面结果提交前检查捕获代际。`renderLogin(message='') -> HTML`，禁止把口令写入渲染字符串或存储。
- `createMutationIntent({kind,id=null,payload={},revision=null,shared=false},requestId=crypto.randomUUID()) -> frozenIntent`；`mutationBody(intent) -> body`；意图包含原始业务白名单、requestId 和共享非 create 的 expectedRevision，不从新快照自动更新 revision。
- `ApiRequestError(message,status)` 在 API 客户端保留状态码；不自动重试写请求。网络失败后保留冻结意图，显式重试沿用相同 requestId；用户修改业务参数后创建新意图，pending 限制仍由服务端裁决。
- `renderLocalApi(service,node) -> HTML` 校验并显示 node.inference 的回环 URL 和调用机器，按 service ID 复制；复制模型别名功能保留。共享状态增加 `inferenceMode:'per-node'`；旧 apiBase 仅兼容旧模式。

- [ ] **Step 1: Write failing tests.** 对纯函数和 API 边界验证冻结意图及代际，测试断言不是源代码字符串搜索。
  ```js
  // Test: network replay preserves intent and does not silently advance revision
  assert.equal(retryBody.requestId, initialBody.requestId);
  assert.equal(retryBody.expectedRevision, 1);
  assert.equal(freshChangedBody.requestId === initialBody.requestId, false);
  // Test: expired session cannot apply an earlier async result
  const captured = epoch.current(); epoch.advance();
  assert.equal(epoch.isCurrent(captured), false);
  ```
  另测本机 API 标签含正确机器、复制 URL 而非全局网关、HTML 注入转义、401 与 409 不丢状态码、两个独立 session helper 的代际互不影响、旧模式不强制登录。实际草稿独立性由 Task 5 的双浏览器 UI 操作验证，不以纯函数测试替代。
- [ ] **Step 2: Verify red.** Run `node --test tests/shared-session.test.mjs tests/client-mutation.test.mjs tests/api.test.mjs tests/app-state.test.mjs`; expected新接口/行为测试失败。
- [ ] **Step 3: Integrate the interfaces.** 启动先 GET session；共享未登录只显示登录界面，登录后读取共同状态。登录/退出/401 取消目录读取、停止旧轮询结果落地、清理敏感状态和弹窗。编辑时捕获 revision，停止/删除确认框捕获自己的 revision，409 提示刷新但保留用户草稿，不替用户接受新版本。共享设置只读连接和退出，保留机器管理；注册完成清空 token 输入，轮询不能清空本地目录/参数草稿。
- [ ] **Step 4: Verify UI and compatibility.** Run `node --test tests/shared-session.test.mjs tests/client-mutation.test.mjs tests/api.test.mjs tests/app-state.test.mjs tests/model-browser.test.mjs tests/console.test.mjs`; expected all pass。机器/GPU 单元首行机器名与 GPU、次行本机 API 与复制按钮；别名单元仍两行。页脚改团队共享管理，保持字体与两条服务可见；index 资源版本更新为 `shared-console-v1`。
- [ ] **Step 5: Commit reviewed delta.** Message `feat: add shared login and conflict-aware deployment controls`；不混入浏览器登录口令、截图或 localStorage 数据。

### Task 5: 双会话端到端与运行手册

**Files:** Modify `tests/fixtures/browser-cluster.mjs`, `tests/fixtures/shared-cluster.mjs`, `tests/shared-console.test.mjs`, `tests/shared-mutations.test.mjs`, `README.md`, `docs/deployment.md`; create `docs/shared-console-runbook.md`.

**Interfaces:** Browser fixture 增加 `--shared-preview`，两台 CPU 假 Agent、本机网关、真实 Controller/Console；监听本机空闲 5190，公开 Origin 固定到此夹具，随机测试口令只写临时目录 0600 文件、不输出明文，退出关闭所有子进程并清理临时目录。手册以 Task 1–4 的配置/API 字段为唯一实现契约。

- [ ] **Step 1: Write failing end-to-end assertions.** Node 双会话 HTTP 集成测试断言认证、共同机器/服务、同卡抢占顺序、多卡原子性、两机独立模型列表和禁用旧转发都串通真实组件；测试不能 mock 掉被验证的管理链。
  ```js
  assert.deepEqual(stateA.services.map(s => s.id), stateB.services.map(s => s.id));
  assert.deepEqual([winner.status, conflict.status], [201, 409]);
  assert.equal((await remoteAgentInference()).status, 404);
  assert.equal((await loggedOutState()).status, 401);
  ```
- [ ] **Step 2: Verify red/green.** Run `node --test tests/shared-console.test.mjs tests/shared-mutations.test.mjs tests/local-inference.test.mjs`; 新断言需先证明缺少所测连通行为时失败，再在整合后全部通过。
- [ ] **Step 3: Browser verify with two isolated cookie stores.** 使用支持独立会话的浏览器控制工具，不把同一浏览器的两个 tab 当成独立用户。分别登录、连接不同机器、选择不同目录/参数，同时看到同一服务；模拟另一会话抢卡、修改 revision、在删除确认期间启动以及目录/日志慢返回。退出一方不影响另一方。实际 DOM 检查 1366×768 下整体 document 不滚动，两条服务同时可见；800×600 保留现有分区切换，不强行挤压字段。不能通过隐藏 app 状态或浏览器 evaluate 写状态代替 UI。
- [ ] **Step 4: Write and verify the runbook.** 记录私有配置字段、哈希口令生成、团队登录/退出、Server-local API 取 Key 的服务器文件路径、requestId/revision 重试语义、网络保护与端口矩阵、备份及回滚边界。不得把 6kd_6 缺 vLLM 环境写成已经支持真实模型。
- [ ] **Step 5: Whole-tree verification and commit.** Run `npm test`, `npm run check`, `git diff --check`; expected全部通过。结束夹具并确认监听/假进程已退出。Message `test: verify shared deployment workflow and document migration`。
- [ ] **Step 6: Review before production.** 按选定执行方法对整个基线后的分支做独立只读审查，覆盖 Review Focus 和设计验收；修复重要问题后重新运行全部测试/语法检查，审查未闭环不得进入 Task 6。

### Task 6: 安全迁移 6kd_7 / 6kd_6 并交付真实 URL

**Files:** Only reviewed source artifacts and private `/data/bbj/DeployScope/.gpu-monitor/` configuration/backups on the two target servers; `docs/shared-console-runbook.md` 记录非敏感结果。不提交私有运行数据。

**Interfaces:** 使用同一份已验证源代码；两机现有独立 Node 运行时和服务单元继续使用，6kd_7 `deployscope.service`、6kd_6 `deployscope-agent.service`。交付必须有用户电脑访问非回环网页的证据，而非 SSH 内部 curl 结果。

- [ ] **Step 1: Preflight and backup.** 用 SSH 只读核对两机状态、PID/进程组、pending、单元、端口、网络接口与现有规则；核实 174.1.59.7 的管理网络/VPN 边界。若有活动托管服务先报告并请求中断许可；不能证明网络保护则保留回环管理，报告阻碍，不无认证放行。建立明确时间戳的源代码/配置/状态/单元备份，目录 0700、私有文件 0600；不覆盖已经出现的新状态。
- [ ] **Step 2: Stage and verify remote artifacts.** 先复制到本项目私有 staging 目录（排除 .git、私有状态、测试截图），在两机专用 Node 运行完整测试和语法检查；失败不替换生产源。备份、staging 使用 mktemp 明确创建，不能把未解析变量/宽泛路径作为删除目标。
- [ ] **Step 3: Apply configuration while services are confirmed inactive.** 6kd_7 设置 Controller 18081、multiUser=true、inferenceEnabled=false；固定 shared Console host/publicOrigins/controllerUrl/passwordHash；两 Agent coordinatedWrites=true、本机网关 18080 各自独立随机 key。同步迁移旧 Console 配置避免连到网关；口令通过 0600 用户交付文件提供，只展示文件路径。保留 modelRoot、根目录选择、Agent token、注册记录和 6kd_6 防火墙。绑定具体管理地址，不修改无关 9000 服务。若状态从 preflight 后变化，停止迁移并报告。
- [ ] **Step 4: Restart and prove server isolation.** 只重启这两个本项目单元；检查 active、`ss -ltn` 端口矩阵、本机网关 health 与认证 `/v1/models`、Controller 状态、管理端口旧 inference 404，密钥不出现在输出。6kd_6 对 6kd_7 管理地址/两机非回环推理端口的检查不能替代正确的各机 localhost 检查。没有模型运行时列表为空是正确结果，不启动模型凑验收。
- [ ] **Step 5: Verify direct team access, update owned tunnel and hand off.** 在用户电脑访问候选非回环 URL，完成未登录阻断、登录、读取两个节点和已有服务检查；再核对 Mac 上确切由我们创建的 tunnel PID/参数，替换为仅 `-L 127.0.0.1:15173:174.1.59.7:15173`，删除其 18080 转发，不触碰其他 SSH。跨会话验证与服务器检查通过后交付实际 URL、口令文件、端口和 6kd_6 vLLM 限制。若失败，依据备份只回退本任务源/配置/单元，不盲目恢复部署状态；恢复旧模式意味着还未完成新调用隔离，须明确报告。

## Execution Handoff

自检覆盖：设计 §1–3 对应 Global Constraints、Task 1/6；§4 对应 Task 2；§5 对应 Task 4/5；§6–7 对应 Task 3/4；§8 对应 Task 1/4；§9 对应 Task 6；§10 对应 Task 5/6。Review Focus 的五类情况均落实到相应任务的测试和验收，不依赖部署健康检查代替功能验证。

计划待用户审阅及选择执行方式；此文件不是已实施或已部署的证据。

建议 **Native**：在当前会话逐任务实施，并在结束时做一次独立全分支审查。组件共享管理器、收据与界面契约，按序直接实施可减少交接开销。

也可选择 **Subagent-driven**：每任务由新子代理实施并分别审查，再做整体审查；独立检查更多，但每任务/审查都有新的上下文与时间成本。只有用户选择后才按相应技能执行。
