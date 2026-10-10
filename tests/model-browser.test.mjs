import test from 'node:test';
import assert from 'node:assert/strict';
const browser=await import('../src/model-browser.mjs').catch(cause=>{if(cause.code==='ERR_MODULE_NOT_FOUND') return {}; throw cause;});

test('model dropdown renders only the supplied immediate children and escapes names', () => {
  assert.equal(typeof browser.renderModelOptions,'function');
  const html=browser.renderModelOptions([{name:'Model <one>',path:'/data/hf_models/Model-one'},{name:'B',path:'/data/hf_models/B'}],'/data/hf_models/B');
  assert.match(html,/Model &lt;one&gt;/); assert.match(html,/value="\/data\/hf_models\/B" selected/);
  assert.doesNotMatch(html,/<input|datalist/);
  assert.match(browser.renderModelOptions([],''),/暂无一级子文件夹/);
});

test('folder picker exposes navigation, explicit selection and cancellation without a text input', () => {
  assert.equal(typeof browser.renderDirectoryDialog,'function');
  const html=browser.renderDirectoryDialog({root:'/data',path:'/data/hf_models',parent:'/data',children:[{name:'<img onerror=alert(1)>',path:'/data/hf_models/folder'}]},{name:'6kd_7'});
  assert.match(html,/role="dialog"/); assert.match(html,/data-browse-path="\/data"/);
  assert.match(html,/data-browse-path="\/data\/hf_models\/folder"/);
  assert.match(html,/&lt;img onerror=alert\(1\)&gt;/); assert.doesNotMatch(html,/<img|<input/);
  assert.match(html,/使用此目录/); assert.match(html,/取消/);
});

test('late directory results and errors cannot overwrite a newer machine or folder selection', async () => {
  assert.equal(typeof browser.createDirectoryReader,'function');
  let firstResolve, firstReject;
  const reader=browser.createDirectoryReader((path,{body})=>body.path==='slow' ? new Promise((resolve,reject)=>{firstResolve=resolve; firstReject=reject;}) : Promise.resolve({path:body.path}));
  const stale=reader.read('node-a','slow'); const fresh=await reader.read('node-b','fast'); firstResolve({path:'slow'});
  assert.deepEqual(fresh,{path:'fast'}); assert.equal(await stale,null);
  const staleError=reader.read('node-a','slow'); reader.cancel(); firstReject(new Error('old failure'));
  assert.equal(await staleError,null);
});
