import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

export class PythonWarmWorkerClient {
  constructor({python='python3',timeout=180000}={}){
    this.timeout=timeout; this.seq=0; this.pending=new Map(); this.stderr=''; this.closed=false;
    this.proc=spawn(python,['runtime/worker/python_worker.py'],{cwd:ROOT,stdio:['pipe','pipe','pipe']});
    this.proc.stderr.on('data',b=>{ this.stderr=(this.stderr+b.toString()).slice(-12000); });
    const rl=readline.createInterface({input:this.proc.stdout}); this.rl=rl;
    this.ready=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('python warm worker ready timeout')),Math.min(timeout,30000));
      this._readyResolve=(msg)=>{clearTimeout(timer);resolve(msg);}; this._readyReject=(err)=>{clearTimeout(timer);reject(err);};
    });
    rl.on('line',line=>this._onLine(line));
    this.proc.on('error',e=>this._failAll(e));
    this.proc.on('exit',(code,signal)=>{ if(!this.closed&&code!==0)this._failAll(new Error(`python warm worker exited code=${code} signal=${signal}: ${this.stderr}`)); });
  }
  _onLine(line){
    let msg; try{msg=JSON.parse(line);}catch{return;}
    if(msg.type==='ready'){ this._readyResolve?.(msg); return; }
    const p=this.pending.get(msg.id); if(!p)return; this.pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg);
  }
  _failAll(err){ this._readyReject?.(err); for(const [,p] of this.pending){clearTimeout(p.timer);p.reject(err);} this.pending.clear(); }
  async render(backend,requestPath){
    await this.ready; if(this.closed)throw new Error('python warm worker already closed');
    const id=`warm-${++this.seq}`;
    const result=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`python warm worker render timeout for ${requestPath}`));},this.timeout);
      this.pending.set(id,{resolve,reject,timer});
    });
    this.proc.stdin.write(JSON.stringify({id,op:'render',backend,request_path:requestPath})+'\n');
    return result;
  }
  async close(){
    if(this.closed)return; this.closed=true;
    try{ this.proc.stdin.write(JSON.stringify({id:`warm-${++this.seq}`,op:'shutdown'})+'\n'); }catch{}
    await new Promise(resolve=>{ const timer=setTimeout(()=>{try{this.proc.kill('SIGTERM');}catch{};resolve();},1000); this.proc.once('exit',()=>{clearTimeout(timer);resolve();}); });
    try{this.rl.close();}catch{}
  }
}
