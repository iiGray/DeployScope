import { escapeHtml as esc } from './app-state.mjs';

export const DEFAULT_MODEL_ROOT='/data/hf_models';

export function createDirectoryReader(client) {
  let generation=0;
  return {
    cancel() { generation++; },
    async read(nodeId,path) {
      const request=++generation;
      try {
        const result=await client(`/api/control/nodes/${encodeURIComponent(nodeId)}/directories`,{method:'POST',body:path===undefined ? {} : {path}});
        return generation===request ? result : null;
      } catch(cause) { if(generation!==request) return null; throw cause; }
    },
  };
}

export function renderModelOptions(children,selected,keepSelected=false) {
  const current=keepSelected && selected && !children.some(c=>c.path===selected);
  const options=children.map(child=>`<option value="${esc(child.path)}" ${child.path===selected ? 'selected' : ''}>${esc(child.name)}</option>`).join('');
  return (current ? `<option value="${esc(selected)}" selected>当前部署 · ${esc(selected.split('/').at(-1))}</option>` : '')
    + (!current && !children.length ? '<option value="">暂无一级子文件夹</option>' : options);
}

export function renderDirectoryDialog(listing,{name='',loading=false,error='',defaultPath=DEFAULT_MODEL_ROOT}={}) {
  const disabled=loading ? 'disabled' : '';
  const folders=listing.children.map(child=>`<button class="directory-entry" data-browse-path="${esc(child.path)}" ${disabled}><span aria-hidden="true">▱</span><span>${esc(child.name)}</span><span aria-hidden="true">›</span></button>`).join('');
  return `<section class="confirm-dialog directory-dialog" role="dialog" aria-modal="true" aria-labelledby="directory-title"><h2 id="directory-title">选择模型目录</h2><p class="directory-machine">${esc(name)} · 点击文件夹查看下一级</p><div class="directory-toolbar"><button class="tiny-button" data-browse-path="${esc(listing.root)}" ${disabled}>存储根目录</button><button class="tiny-button" data-browse-path="${esc(listing.parent || listing.root)}" ${!listing.parent || loading ? 'disabled' : ''}>上一级</button><button class="tiny-button" data-browse-path="${esc(defaultPath)}" ${disabled}>默认目录</button></div><code class="directory-location">${esc(listing.path)}</code><div class="directory-list">${loading ? '<span class="directory-empty">正在读取文件夹…</span>' : error ? `<span class="directory-empty model-error" role="alert">${esc(error)}</span>` : folders || '<span class="directory-empty">此目录没有子文件夹</span>'}</div><div class="directory-actions"><button class="button secondary" data-action="cancel-directory">取消</button><button class="button primary" data-action="choose-directory" ${loading || error ? 'disabled' : ''}>使用此目录</button></div></section>`;
}
