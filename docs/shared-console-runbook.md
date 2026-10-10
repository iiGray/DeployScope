# 共享管理与服务器本机推理

本手册描述共享模式；`npm run init` 的默认值仍是兼容的本地旧模式，需要明确配置后才启用新模式。管理服务是单控制节点、单 Agent/机器，不提供多控制节点高可用、用户角色或 GPU 等候队列。

## 拓扑与端口

浏览器 → 共享 Console → 私有 Controller → 各机 Agent。推理程序 → **所在服务器的** `127.0.0.1:18080/v1` → 该服务器就绪的 vLLM。管理链不负责跨机器推理。

| 角色 | 6kd_7 目标监听 | 6kd_6 目标监听 | 用途 |
| --- | --- | --- | --- |
| 团队网页 Console | 管理地址:15173 | 无 | 团队浏览器登录、管理 |
| Controller | 127.0.0.1:18081 | 无 | 固定私有管理连接；`/v1/*` 禁用 |
| Agent | 127.0.0.1:19000 | 10.100.11.6:19000 | 后者仅允许控制节点访问 |
| 本机推理网关 | 127.0.0.1:18080 | 127.0.0.1:18080 | 各机独立 Key，只列出本机就绪服务 |
| vLLM | 127.0.0.1:动态端口 | 127.0.0.1:动态端口 | Agent 自有子进程，不直接对外开放 |

这是迁移目标，不是部署成功证据；实际网络地址、验收结果在下方迁移记录更新。`127.0.0.1` 指运行推理代码的服务器，不是打开网页的电脑。两个服务可以使用同一台服务器的本机网关，通过请求 `model` 字段的服务别名区分；不同服务器虽然文字 URL 相同，实际是不同监听进程与 Key。

## 私有配置契约

代码需要 Node.js 20+，不需要 npm 安装。GPU 机器还需要可用的 NVIDIA 驱动、`nvidia-smi`、模型文件和 vLLM 环境。不要复制或提交其他机器的 `.gpu-monitor`。

在现有 `.gpu-monitor/config.json` 中保留原有 ID、token、注册记录、modelRoot、stateDir 和 vllmExecutable，仅增加/修改相关字段：

```json
{
  "agent": {
    "coordinatedWrites": true,
    "localInference": { "enabled": true, "port": 18080, "apiKeys": ["每台机器独立随机密钥，至少16字符"] }
  },
  "controller": {
    "host": "127.0.0.1", "port": 18081,
    "publicUrl": "http://127.0.0.1:18081",
    "multiUser": true, "inferenceEnabled": false
  },
  "console": {
    "mode": "shared", "host": "管理网络上的具体IP", "port": 15173,
    "publicOrigins": ["http://管理网络上的具体IP:15173"],
    "trustedNetwork": true,
    "controllerUrl": "http://127.0.0.1:18081",
    "adminToken": "保留控制节点原有管理密钥",
    "passwordHash": "scrypt$盐的32位十六进制$哈希的128位十六进制"
  }
}
```

以上是字段补丁示意，不是完整可直接覆盖的配置；只有 6kd_7 需要 Controller/Console。`coordinatedWrites` 必须与 Controller 的 `multiUser` 一同启用。旧 `console.json` 在 shared 模式下不决定连接，Console 只读服务器配置；迁移时仍更新旧文件，以免回退/旧客户端连到新的推理端口。

`publicOrigins` 必须是实际访问的 Origin，不能带路径、用户名、查询串或通配符，并且不能混合 HTTP/HTTPS。Host 和写请求 Origin 必须对应。网页绑定具体管理地址；Controller 继续回环监听。HTTP 只允许在已核实的 VPN/可信管理网络使用，`trustedNetwork:true` 是运维声明，**不会自动建立 VPN 或防火墙**。没有保护边界就不要对外开放；使用 HTTPS 反向代理时配置 HTTPS Origin，代理不缓存管理响应。

配置与状态目录应为 `0700`，私有配置文件 `0600`，只有服务运行账户可读写。浏览器不会得到管理密钥、Agent token 或推理 Key。密钥不放 URL、截图、Git、shell 历史或聊天记录。

### 生成口令哈希

运行模块导出的 `hashPassword`，不要自行换成弱摘要。口令为 16–256 UTF-8 字节。下面脚本直接更新配置，只输出配置路径，不输出口令/哈希；从一个 `0600` 私有文件读取新口令，用完后妥善保管或删除该交付文件。先备份现有配置。

```sh
node --input-type=module - .gpu-monitor/config.json /安全路径/web-password.txt <<'JS'
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { hashPassword } from './backend/sessions.mjs';
const [configPath, passwordPath] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const password = (await readFile(passwordPath, 'utf8')).trim();
config.console.passwordHash = await hashPassword(password);
await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
await chmod(configPath, 0o600);
console.log('已更新口令哈希：' + configPath);
JS
```

可用 `node backend/cli.mjs dev --config .gpu-monitor/config.json` 在 6kd_7 启动三角色；6kd_6 使用 `agent` 角色。systemd 使用现有专用 Node 绝对路径。修改生产配置前先确认托管服务均停止，因为 Agent 正常退出会停止其管理的模型。

## 团队使用

所有持有网页口令的用户是同等管理员。登录后各浏览器拥有独立 HttpOnly、SameSite=Strict 会话 Cookie；会话最长 12 小时，Console 重启会失效。一方退出不会退出其他会话。错误登录受来源 IP 速率限制，不能信任伪造的 Forwarded/X-Forwarded-For 来绕过。

每人独立选择机器、目录、GPU 和参数；轮询共享状态不会覆盖草稿。连接机器后默认定位 `/data/hf_models`，文件夹选择器逐级浏览，模型下拉只列出一级子目录；默认目录不存在会明确报错，可从存储根目录选择，不会下载模型。目录浏览只读，部署仍校验真实路径及 `config.json`。

提交到服务器后由 Controller 与 Agent 队列串行裁决。第一个完整有效的请求获得整组 GPU，`starting` 也占用；后续请求若冲突返回 409，不会抢走先提交者的卡，也不会占用部分卡。没有后台等卡队列，冲突后由用户重新确认并提交。外部进程仍可能带外占卡，本工具不能约束其他管理员运行的程序。

编辑、停止、删除携带打开操作时的 `expectedRevision`。旧版本请求返回 409，保留用户草稿，不能自动改用新版本继续执行。已停止且进程身份检查安全的记录才能删除；确认框打开期间被其他人启动，也会拒绝旧删除。删除只归档记录、释放别名，不删除模型或日志。

创建与修改类写操作有 `requestId`。网络错误/5xx 后点击“重试原提交”沿用冻结载荷和原 ID；不能换 ID 来绕过 pending，也不能把同一 ID 用于新参数。相同已确认请求回放结果，不再次启动模型或增加版本。已确认/拒绝收据保留最长 7 天、最多 10000 条，pending 不裁剪；因此很久以前的 ID 不是永久幂等保证。

Controller 使用稳定 Agent `operationId` 对账。结果不明确时保留记录、别名与资源预约，不把超时当成没有启动；服务可能显示未确认/残留进程。Agent `/api/operations/:operationId` 是 token 鉴权的运维接口，用于证明具体操作完成。崩溃发生在 spawn 附近且没有持久 PID/checkpoint 时保留 orphaned 预约，即使实际上没启动也需人工核对；不要直接清空状态文件或盲目杀进程。

## 本机推理调用

各机推理 Key 位于该机 `/data/bbj/DeployScope/.gpu-monitor/config.json` 的 `agent.localInference.apiKeys`，由该机授权管理人员在服务器上读取。不要把整个配置分发给推理调用方，尤其不要暴露其中管理密钥。共享网页可复制服务别名和本机 API，但不展示 Key。

在对应 GPU 服务器上执行：

```sh
curl http://127.0.0.1:18080/v1/chat/completions \
  -H "Authorization: Bearer $DEPLOYSCOPE_LOCAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"网页中的服务别名","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

`GET /health` 不需要 Key，仅返回非敏感健康信息；`GET /v1/models` 需要该机 Key，只列出本机就绪部署。支持聊天与文本补全、SSE、客户端取消，默认最长 30 分钟。未就绪、停止、远端模型不可推理；不提供 Embeddings、负载均衡或跨机 Tensor Parallel。旧 Controller `/v1/*` 和 Agent 管理端口推理路径在新模式均为 404。

## 验证、备份与回滚

```sh
npm test
npm run check
git diff --check
```

自动测试通过真实 HTTP 链路、CPU 假 GPU 遥测与独立测试子进程验证认证、并发、恢复、版本保护和网关隔离，不是生产硬件加载验收。`node tests/fixtures/browser-cluster.mjs --shared-preview` 提供双 Agent 隔离夹具，监听 localhost:5190，随机口令只写临时 0600 文件；退出清理自己的临时目录与子进程。`--slow-preview` 用于目录/日志迟到验收。

生产升级先核对各 Agent 活动状态、PID/进程组、pending 和实际占卡，不中断未获授权的模型。把源代码、配置、状态与 unit 备份到明确命名的私有目录；在 staging 用两机实际 Node 完整测试后再替换源。备份包含敏感信息，需要限制权限，不提交 Git。

升级只重启 `deployscope.service` / `deployscope-agent.service`，保留 6kd_6 Agent 防火墙和其他服务。验证各机 localhost 网关鉴权、远端模型不可达、旧跨机转发 404、Controller 私有端口，以及用户电脑能直接打开非回环网页并登录看到共同服务。

回滚原则：恢复本次源代码/配置/unit 后再启动，先核对当前进程；**不要把旧状态备份覆盖新用户提交后的状态**。丢失响应时按 operationId 对账。回退旧模式可能恢复跨机转发，不等于新隔离要求完成。移除旧电脑推理端口的 SSH 转发；仅保留可选网页兼容转发。

## 迁移记录

当前源码已实现上述能力，生产迁移尚待验收。6kd_6 当前没有已确认可用的 vLLM 可执行环境：Agent/GPU 状态和本机网关可以运行，但不能宣称已支持真实模型加载；本次迁移不安装 vLLM、不启动模型占用生产 GPU。
