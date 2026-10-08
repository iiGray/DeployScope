# GPU Monitor

团队裸机 GPU 推理服务管理工具。每位用户在本地运行同一个精简网页，通过共享控制节点管理各机器上的 Agent；调用方使用一个统一 API 地址。

## 本地体验

需要 Node.js 20 或更高版本，无需安装 npm 依赖。

```sh
cd /Users/gray/Documents/Project/workspace/GPU_monitor
npm start
```

浏览器打开 http://127.0.0.1:5173，在右上角“连接设置”填写共享控制节点地址与管理密钥。只启动本地网页，不会自动连接演示中的机器。

界面演示：http://127.0.0.1:5173/?demo=1。演示状态仅存在浏览器中，与真实部署隔离。

开发联调（同机启动 Agent、控制节点、网页）：

```sh
npm run dev
```

首次生成 `.gpu-monitor/config.json` 私有配置，默认端口分别为 9000、8080、5173。默认所有服务只监听 `127.0.0.1`。当前 Mac 没有 NVIDIA GPU，会显示真实错误，不会显示虚假的显卡或启动结果。模型目录默认 `/models`，可在页面连接后修改为实际目录。

## 已接入功能

- 注册 / 连接 Agent；查询 `nvidia-smi` 的型号、利用率、显存、温度和进程占用，每 3 秒更新页面。
- 在页面切换各机器自己的模型目录，扫描含 `config.json` 的本地模型（最多两层子目录）。支持输入完整路径；部署路径必须在模型目录内。
- 多 GPU 独占分配，按 GPU UUID 启动；拒绝被其他部署或外部计算进程占用的 GPU。
- 配置 vLLM 的上下文、显存比例和精度，一键启动部署。
- 在服务列表中修改、停止或重新启动部署。
- 命令预览、实际子进程日志（最近 64 KiB）、API 地址复制。
- 全局服务别名唯一、部署配置持久化、管理 / 推理 / Agent 三种密钥分离。
- 统一 `/v1/models`、`/v1/chat/completions`、`/v1/completions`，支持 SSE 流式响应。

详细配置与裸机启动见 [部署说明](docs/deployment.md)。无需 SSH 连接：网页经控制节点调用各机 Agent。所有持有管理密钥的用户权限相同。

使用系统字体，无外部字体或前端依赖。

## 验证

```sh
npm test
npm run check
```

测试通过真实 HTTP 服务与独立测试子进程验证，GPU 遥测由测试夹具注入，不代表已在真实显卡上完成 vLLM 验证。生产路径没有模拟 GPU 回退。

入口：`server.mjs`（本地客户端）、`backend/cli.mjs`（Agent / 控制节点）；不需要 npm 安装，GPU 机器需要另行准备 NVIDIA 驱动与可用的 vLLM 环境。
