import assert from 'node:assert/strict';
import { runProcess } from '../runtime/pi/process.mjs';
const node = process.execPath;
const test = async (name, fn) => { await Promise.race([fn(), new Promise((_, reject) => { const t=setTimeout(()=>reject(new Error(`test watchdog: ${name}`)),4000); t.unref(); })]); console.log(`PASS ${name}`); };
await test('normal', async()=>assert.equal((await runProcess(node,['-e','console.log("ok")'])).stdout,'ok\n'));
await test('spawn failure', async()=>assert.rejects(runProcess('/nonexistent/perf',[]),/failed to start/));
await test('timeout', async()=>assert.rejects(runProcess(node,['-e','setInterval(()=>{},100)'],undefined,undefined,undefined,100,80),/timeout/));
await test('cancel before spawn', async()=>{const c=new AbortController();c.abort();await assert.rejects(runProcess(node,[],c.signal),/cancelled/);});
await test('cancel ignores SIGTERM', async()=>{const c=new AbortController();setTimeout(()=>c.abort(),100);await assert.rejects(runProcess(node,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},100)'],c.signal),/cancelled/);});
await test('single oversized chunk', async()=>assert.rejects(runProcess(node,['-e','process.stdout.write("x".repeat(100000))'],undefined,undefined,undefined,100),/stdout limit/));
await test('stderr cap', async()=>assert.rejects(runProcess(node,['-e','process.stderr.write("x".repeat(200000))']),/stderr limit/));
await test('nonzero payload suppressed', async()=>{try{await runProcess(node,['-e','console.error("private-provider-diagnostic");process.exit(2)']);assert.fail();}catch(e){assert.match(e.message,/code 2/);assert.ok(!e.message.includes('private-provider'));}});
await test('QA nonzero report semantics', async()=>assert.equal((await runProcess(node,['-e','process.exit(2)'],undefined,undefined,undefined,100,1000,true)).code,2));
await test('long normal tool', async()=>assert.equal((await runProcess(node,['-e','setTimeout(()=>console.log("ok"),250)'],undefined,undefined,undefined,100,1000)).stdout,'ok\n'));
await test('descendant cleanup', async()=>{
  const {mkdtempSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'news-child-'));const pidFile=join(dir,'pid');
  try {
    const code=`const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(p.pid));setInterval(()=>{},100)`;
    await assert.rejects(runProcess(node,['-e',code],undefined,undefined,undefined,100,300),/timeout/);
    const pid=Number(readFileSync(pidFile,'utf8'));
    const deadline=Date.now()+2500;
    while (true) {
      try {
        process.kill(pid,0);
        if (Date.now() >= deadline) assert.fail('descendant still alive after cleanup deadline');
        await new Promise(resolve=>setTimeout(resolve,50));
      } catch (error) {
        if (error?.code === 'ESRCH') break;
        throw error;
      }
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
