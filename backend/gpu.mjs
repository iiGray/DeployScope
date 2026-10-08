import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import { ApiError } from './common.mjs';

const run = promisify(execFile);
const reading = (value, scale = 1) => { if (!value || /N\/A|Not Supported|Unknown/i.test(value)) return null; const number = Number(value); return Number.isFinite(number) ? Math.round(number / scale * 100) / 100 : null; };
const rows = (text) => text.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(',').map((value) => value.trim()));

export function parseGpuCsv(text) {
  return rows(text).map(([index, uuid, name, total, used, utilization, temperature, driver]) => {
    const id = Number(index); const memoryTotal = reading(total, 1024);
    if (!Number.isInteger(id) || !uuid?.startsWith('GPU-') || !memoryTotal || !name) throw new ApiError(503, '无法解析 NVIDIA 显卡数据');
    return { id, uuid, name, memoryTotal, memoryUsed: reading(used, 1024), utilization: reading(utilization), temperature: reading(temperature), driver, deploymentId: null };
  });
}
export function parseProcessCsv(text) {
  return rows(text).map(([pid, uuid, memory]) => {
    if (!Number.isInteger(Number(pid)) || !uuid?.startsWith('GPU-')) throw new ApiError(503, '无法解析 GPU 进程数据');
    return { pid: Number(pid), uuid, memoryUsed: reading(memory, 1024) };
  });
}
export async function readGpuStatus() {
  try {
    const gpu = await run('nvidia-smi', ['--query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu,temperature.gpu,driver_version', '--format=csv,noheader,nounits'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const processes = await run('nvidia-smi', ['--query-compute-apps=pid,gpu_uuid,used_gpu_memory', '--format=csv,noheader,nounits'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return { gpus: parseGpuCsv(gpu.stdout), processes: parseProcessCsv(processes.stdout) };
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new ApiError(503, cause.code === 'ENOENT' ? 'nvidia-smi 不可用：该机器未安装 NVIDIA 驱动或没有 NVIDIA GPU' : '读取 GPU 状态失败，请检查 NVIDIA 驱动与设备权限');
  }
}
export function validateDeployment(input) {
  const alias = typeof input.alias === 'string' ? input.alias.trim() : '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(alias)) throw new ApiError(400, '服务别名只允许字母、数字、点、下划线和短横线，最多 64 个字符');
  if (typeof input.modelPath !== 'string' || !isAbsolute(input.modelPath)) throw new ApiError(400, '模型路径必须是绝对路径');
  const gpuIds = input.gpuIds;
  if (!Array.isArray(gpuIds) || !gpuIds.length || gpuIds.length > 64 || gpuIds.some((id) => !Number.isInteger(id) || id < 0) || new Set(gpuIds).size !== gpuIds.length) throw new ApiError(400, '请选择有效且不重复的 GPU');
  const maxModelLen = Number(input.maxModelLen ?? 32768);
  const gpuMemoryUtilization = Number(input.gpuMemoryUtilization ?? 0.9);
  const dtype = input.dtype ?? 'auto';
  if (!Number.isInteger(maxModelLen) || maxModelLen < 1 || maxModelLen > 1048576) throw new ApiError(400, '上下文长度必须为 1–1048576');
  if (!Number.isFinite(gpuMemoryUtilization) || gpuMemoryUtilization < 0.5 || gpuMemoryUtilization > 0.98) throw new ApiError(400, '显存比例必须为 0.50–0.98');
  if (!['auto', 'bfloat16', 'float16'].includes(dtype)) throw new ApiError(400, '不支持此计算精度');
  return { alias, modelPath: input.modelPath, gpuIds: [...gpuIds], maxModelLen, gpuMemoryUtilization, dtype, tensorParallelSize: gpuIds.length };
}
export function vllmLaunch(draft, gpus, port, apiKey) {
  return {
    args: ['serve', draft.modelPath, '--served-model-name', draft.alias, '--tensor-parallel-size', String(draft.gpuIds.length), '--max-model-len', String(draft.maxModelLen), '--gpu-memory-utilization', String(draft.gpuMemoryUtilization), '--dtype', draft.dtype, '--host', '127.0.0.1', '--port', String(port), '--api-key', apiKey],
    env: { CUDA_VISIBLE_DEVICES: draft.gpuIds.map((id) => gpus.find((gpu) => gpu.id === id).uuid).join(',') },
  };
}
