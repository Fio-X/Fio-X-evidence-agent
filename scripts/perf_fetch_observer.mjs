// Only route/HTTP timing metadata is recorded; never URLs with queries, headers or bodies.
import { appendFileSync } from 'node:fs';
function wrap(original) { return async function(input, init) {
  const url=new URL(typeof input==='string'||input instanceof URL ? input : input.url);
  const start=performance.now();
  const record={type:'http',hostname:url.hostname,path:url.pathname,started_at:new Date().toISOString()};
  try {const response=await original.call(this,input,init);record.status=response.status;return response;}
  catch(e){record.failed=true;throw e;}
  finally {record.headers_ms=performance.now()-start;if(process.env.PERF_NETWORK_LOG)appendFileSync(process.env.PERF_NETWORK_LOG,JSON.stringify(record)+'\n');}
}; }
let observed=wrap(globalThis.fetch);
Object.defineProperty(globalThis,"fetch",{configurable:true,get:()=>observed,set:value=>{observed=wrap(value);}});
