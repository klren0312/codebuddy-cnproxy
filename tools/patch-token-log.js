/**
 * 给 CodeBuddy genie 扩展打补丁: 打印 Authorization token
 *
 * 原理: extension host 入口是
 *   resources/app/extensions/genie/out/extension/index.js (约22MB, 已压缩)
 * 其中 buildCustomHeaders() 会组装:
 *   Authorization: Bearer <accessToken>
 * 本脚本做两件事 (都只影响本地, 更新后会被覆盖):
 *   1. 备份原文件 -> index.js.bak (只备一次)
 *   2. 在文件头部注入 fetch/axios 头部钩子, 把带 Authorization 的请求打印到日志
 *
 * 用法:
 *   node "<repo>/patch-token-log.js"
 *   然后重启 CodeBuddy, 跟 AI 聊一句, 再看日志
 *
 * 还原:
 *   node "<repo>/patch-token-log.js" --restore
 */
const fs = require('fs');
const path = require('path');

const TARGET = process.env.CODEBUDDY_EXT_INDEX || 'D:/Apps/CodeBuddy CN/resources/app/extensions/genie/out/extension/index.js';
const BACKUP = TARGET + '.bak';
const DUMP_LOG = require('path').join(__dirname, '..', 'token-dump.log');

const HOOK = `
;/* ===== TOKEN-DUMP HOOK (本地调试用, 看完就删) ===== */
;(function(){
if (globalThis.__tokenDumpHook) return;
globalThis.__tokenDumpHook = true;
function dump(tag, url, headers){
  try{
    if(!headers) return;
    var auth = headers.Authorization || headers.authorization
      || headers['X-Refresh-Token'] || headers['x-refresh-token'];
    if(!auth) return;
    var msg = '[TOKEN-DUMP] ' + tag + ' url=' + url + ' Authorization=' + auth;
    try{ console.log(msg); }catch(e){}
    try{ console.error(msg); }catch(e){}
    try{
      var fs = require('fs');
      fs.appendFileSync('${DUMP_LOG}',
        new Date().toISOString() + ' ' + msg + '\\n');
    }catch(e){}
  }catch(e){}
}
try{
  // hook global fetch
  if (typeof globalThis.fetch === 'function' && !globalThis.fetch.__tokenDumpWrapped){
    var _fetch = globalThis.fetch;
    var wrapped = async function(u, o){
      try{
        var url = (typeof u === 'string') ? u : (u && u.url) || String(u);
        if (/copilot\\.tencent\\.com|staging-copilot|\\/v2\\//.test(url)) dump('fetch', url, (o && o.headers) || {});
      }catch(e){}
      return _fetch.apply(this, arguments);
    };
    wrapped.__tokenDumpWrapped = true;
    globalThis.fetch = wrapped;
  }
}catch(e){ try{console.log('[TOKEN-DUMP] fetch hook failed: '+e.message);}catch(_){} }
try{
  // hook axios-style restOperations: 拦截 require('axios') 实例的 request 方法比较难,
  // 这里退一步: 定时从 AuthenticationManager 内存里读 (如果能拿到容器则打印, 拿不到就跳过)
  // 真正的打印靠上面的 fetch hook + 下面对 buildCustomHeaders 的补丁
}catch(e){}
})();
;/* ===== END TOKEN-DUMP HOOK ===== */
`;

function patchBuildCustomHeaders(src) {
  // 把 "(null==ar?void 0:ar.accessToken)&&(nn.Authorization=`Bearer ${ar.accessToken}`"
  // 后面追加打印。注意文件是压缩的, 用字符串包含匹配, 只 patch 第一处 Pulse 的 buildCustomHeaders。
  const needle = 'nn.Authorization=`Bearer ${ar.accessToken}`';
  const idx = src.indexOf(needle);
  if (idx < 0) {
    console.log('WARN: 没找到 buildCustomHeaders 特征串, 只注入头部 fetch hook');
    return { src, patched: false };
  }
  const inject = needle + ',console.log("[TOKEN-DUMP] buildCustomHeaders accessToken="+ar.accessToken),console.error("[TOKEN-DUMP] buildCustomHeaders accessToken="+ar.accessToken),(()=>{try{require("fs").appendFileSync("'+DUMP_LOG+'",new Date().toISOString()+" [TOKEN-DUMP] buildCustomHeaders accessToken="+ar.accessToken+"\\n")}catch(e){}})()';
  const out = src.slice(0, idx) + inject + src.slice(idx + needle.length);
  return { src: out, patched: true };
}

async function main() {
  const restore = process.argv.includes('--restore');
  if (restore) {
    if (!fs.existsSync(BACKUP)) { console.log('没有备份文件, 无需还原'); return; }
    fs.copyFileSync(BACKUP, TARGET);
    console.log('已还原: ' + TARGET);
    return;
  }
  if (!fs.existsSync(TARGET)) { console.error('找不到目标文件: ' + TARGET); process.exit(1); }
  if (!fs.existsSync(BACKUP)) {
    fs.copyFileSync(TARGET, BACKUP);
    console.log('已备份: ' + BACKUP);
  } else {
    console.log('备份已存在, 跳过备份');
  }
  let src = fs.readFileSync(TARGET, 'utf8');
  if (src.includes('TOKEN-DUMP HOOK')) {
    console.log('检测到已打过补丁, 先还原再重打: 加 --restore 后重试');
    return;
  }
  const r = patchBuildCustomHeaders(src);
  src = r.src;
  console.log('buildCustomHeaders 补丁: ' + (r.patched ? '成功' : '跳过'));
  src = HOOK + src;
  fs.writeFileSync(TARGET, src);
  console.log('补丁写入完成。');
  console.log('下一步: 1) 完全退出 CodeBuddy 再重启 2) 跟 AI 聊一句 3) 查看 token-dump.log');
  console.log('日志位置: ' + DUMP_LOG);
  console.log('另外可在 Help > Toggle Developer Tools > Console 里搜 TOKEN-DUMP');
}

main().catch(e => { console.error(e); process.exit(1); });
