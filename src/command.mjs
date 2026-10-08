function shellArgument(value) {
  const text = String(value);
  return /^[a-zA-Z0-9_./:,=-]+$/.test(text) ? text : "'" + text.replaceAll("'", "'\"'\"'") + "'";
}

export function buildCommand(draft) {
  return [
    `CUDA_VISIBLE_DEVICES=${draft.gpuIds.join(',')} vllm serve ${shellArgument(draft.modelPath)} \\`,
    `  --served-model-name ${shellArgument(draft.alias)} \\`,
    `  --tensor-parallel-size ${draft.gpuIds.length} \\`,
    `  --max-model-len ${draft.maxModelLen} \\`,
    `  --gpu-memory-utilization ${draft.gpuMemoryUtilization} \\`,
    `  --dtype ${shellArgument(draft.dtype)}`,
  ].join('\n');
}
