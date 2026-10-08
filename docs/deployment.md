# 裸机部署

部署拓扑：本地网页 → 共享控制节点 → 各 GPU 机器的 Agent → 本机回环地址的 vLLM。

第一版使用单个控制节点和 JSON 状态文件，不支持多控制节点高可用。每台机器运行一个 Agent，所有用户持有同一个管理密钥；推理调用只需推理密钥。

## 1. GPU 机器

把代码复制到各 GPU 机器，**不要复制 `.gpu-monitor` 私有目录**。需要 Node.js 20+、Linux、正常工作的 `nvidia-smi`，以及独立准备好的 vLLM Python 环境。按官方文档安装适合本机 CUDA / GPU 的 vLLM：[安装](https://docs.vllm.ai/en/latest/getting_started/installation/)、[serve 参数](https://docs.vllm.ai/en/latest/cli/serve/)。本工具不会替用户安装驱动、下载模型或修改系统环境。

在代码目录运行：

```sh
npm run init
```

编辑生成的 `.gpu-monitor/config.json` 中的 `agent` 部分：

```json
{
  "agent": {
    "id": "gpu-01",
    "name": "训练机 01",
    "host": "0.0.0.0",
    "port": 9000,
    "token": "使用 init 已生成的随机密钥",
    "modelRoot": "/data/models",
    "stateDir": "/opt/gpu-monitor/.gpu-monitor/agent",
    "vllmExecutable": "/opt/vllm-venv/bin/vllm"
  }
}
```

以上只展示需要配置的字段，保留其他生成内容即可。每台机器的 `id` 必须唯一并保持不变，只允许字母、数字、下划线、短横线。`stateDir` 是该 Agent 的持久化目录，不要给同一机器的第二个 Agent 使用不同目录来绕过锁。

```sh
npm run agent
# 或使用专用配置文件（至少包含 agent 对象）
node backend/cli.mjs agent --config /etc/gpu-monitor/agent.json
```

Agent 用自己的运行用户访问模型和 GPU，不需要 root；确保模型可读、状态目录可写、vLLM 可执行。把服务绑定到具体内网 IP 或 `0.0.0.0` 后，防火墙仅放行控制节点访问 9000。默认生成配置仍是回环监听，不会自行对外开放。

## 2. 共享控制节点

任选一台内网机器，可以与某个 Agent 同机。在本机运行 `npm run init`，编辑 `controller`：

```json
{
  "controller": {
    "host": "0.0.0.0",
    "port": 8080,
    "publicUrl": "http://控制节点内网IP:8080",
    "stateDir": "/opt/gpu-monitor/.gpu-monitor/controller",
    "adminToken": "保留 init 生成的管理密钥",
    "apiKeys": ["保留 init 生成的推理密钥"],
    "nodes": []
  }
}
```

`publicUrl` 应是团队能访问的地址（不带 `/v1`）。示例中的中文占位地址必须替换。`nodes` 仅在第一次建立状态目录时读取，之后由网页“添加 / 更新机器”管理；修改配置的 `nodes` 不会覆盖已有注册。

```sh
npm run controller
```

默认生成文件权限为 `0600`。不要提交、分享完整配置或把其中的管理密钥给仅需推理权限的调用方。控制节点可以配置多个推理 Key，没有用户角色或逐用户配额。

## 3. 每位用户的本地客户端

每人只运行：

```sh
npm start
```

打开 `http://127.0.0.1:5173` → 右上角连接设置 → 输入共享控制节点地址、管理密钥 → 保存并连接。密钥存储在本地服务的 `.gpu-monitor/console.json`，不会存入浏览器 localStorage 或作为状态接口字段返回。

同一个设置窗口展开“添加 / 更新机器”，输入机器名称、Agent 地址、该机器的 Agent token。注册之后所有客户端都能看到这台机器。选择并连接机器，然后保存真实模型目录、选择模型与 GPU、启动部署。保存新目录不会移动模型文件或停止现有部署；旧路径若不在新目录内，后续重启会被拒绝，需要先修改部署路径或恢复目录。

更换本地端口：`GPU_MONITOR_PORT=5174 npm start`。

## 4. 推理调用

```sh
curl http://控制节点IP:8080/v1/chat/completions \
  -H "Authorization: Bearer $GPU_MONITOR_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen-32b","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

调用方用 `model` 填页面上的服务别名，而非磁盘路径。启动中、已停止或离线模型不会作为就绪模型返回。只实现模型列表、聊天与文本补全；不实现文件、Batch、Embeddings、模型下载、负载均衡或跨机 Tensor Parallel。

## 5. 进程、故障与安全

- vLLM 只监听机器回环地址，通过 Agent 鉴权转发；参数经 argv 传递，不执行网页输入的 shell。
- Agent 查询计算进程，发现外部占用时拒绝部署。GPU 锁只能协调本工具内的任务，不能阻止拥有系统管理权限的用户在外部抢占 GPU；不支持 MIG / MPS 分区管理。
- 停止只对身份可确认的自有进程组发送信号，身份不明的残留任务显示“残留进程”并保持 GPU 占用，需在机器上人工检查。Agent 正常退出会停止它管理的模型；异常退出后在 Linux 上根据 PID 出生时间恢复检查，不会盲目杀外部进程。
- 控制节点请求结果不明确时保留部署 ID / 别名，显示“未确认”，防止超时后重复部署。先恢复连接、查看日志，再重试。不要直接清空状态目录。
- 所有部署修改都应经同一个控制节点，不要绕过它直接编辑 Agent 或让另一个控制节点管理同一机器；第一版不协调这种带外修改造成的别名冲突。
- 修改部署会停止并重启，同机换卡可用；跨机器迁移请停止旧部署并在目标机器创建另一个别名。
- 所有部署配置（包括停止 / 失败）保留别名。第一版暂不提供删除部署 / 删除机器按钮。
- 日志每次启动最多捕获 20 MiB，重启追加；长期运行需运维定期轮转文件。页面“清空显示”不删除机器日志。
- HTTP 明文只适合可信内网。跨网络使用 VPN / SSH 隧道或 HTTPS 反向代理；不要直接暴露到公网。反向代理需关闭 SSE 缓冲、允许长请求。不要把 Agent 地址指向不可信服务。
- 推理请求默认最长 30 分钟，控制节点与 Agent 都可通过 `inferenceTimeoutMs` 配置毫秒数。超时会返回错误或终止已经开始的流，而非继续悬挂。
- 状态与配置需要磁盘持久化及备份；恢复备份前核实机器上的实际进程，不要同时运行旧实例与恢复实例。

## 6. systemd（可选）

`deploy/gpu-monitor-agent.service` 和 `deploy/gpu-monitor-controller.service` 是模板，尚未安装到系统。调整 `User`、代码目录、Node 绝对路径、配置路径。Agent 配置使用 vLLM 的绝对路径，并按运行环境补充 PATH / CUDA / 模型缓存变量。每个角色最好只提供该角色的专用配置。

确认目录权限和防火墙后由管理员安装、启用即可。服务停止时会清理模型进程，因此维护 Agent 会使该机推理短暂不可用。

## 验证范围

`npm test` 使用真实 HTTP 链路和测试推理子进程验证鉴权、唯一别名、GPU 抢占、进程停止、持久化与 SSE 转发。浏览器测试夹具 `node tests/fixtures/browser-cluster.mjs` 仅用于开发验证（5190 端口，模拟 GPU），生产入口不引用它。真实硬件上的模型加载、显存大小、GPU 通信和生成质量仍需在实际 NVIDIA 机器上验证。
