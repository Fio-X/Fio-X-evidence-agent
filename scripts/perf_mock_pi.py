#!/usr/bin/env python3
"""Deterministic RPC peer; never contacts a model/provider."""
import json, os, sys, time
mode = os.getenv('PERF_MOCK_MODE', 'normal')
def emit(**v):
    wire=json.dumps(v)
    if mode=='fragment':
        for piece in [wire[:5],wire[5:]]:
            sys.stdout.write(piece);sys.stdout.flush();time.sleep(.07)
        print('',flush=True)
    else: print(wire,flush=True)
for line in sys.stdin:
    cmd = json.loads(line)['type']
    if cmd == 'prompt':
        if mode == 'silent':
            time.sleep(60)
        if mode=='provider_error':
            emit(type='response', command='prompt', success=False,error=os.environ['PERF_TEST_SECRET'])
            continue
        if mode=='oversize':
            sys.stdout.write('x'*8_000_001);sys.stdout.flush();time.sleep(60)
        emit(type='response', command='prompt', success=True)
        if mode == 'idle': time.sleep(60)
        if mode == 'turn_idle':
            emit(type='turn_start')
            emit(type='turn_end')
            time.sleep(60)
        if mode=='active_stall':
            emit(type='agent_start');time.sleep(60)
        if mode=='descendant':
            import subprocess
            c=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])
            open(os.environ['PERF_CHILD_PID'],'w').write(str(c.pid))
            time.sleep(60)
        if mode in ('tool', 'thinking'):
            emit(type='tool_execution_start' if mode == 'tool' else 'message_update', toolName='mock', toolCallId='one', assistantMessageEvent={'type':'thinking_start'})
            time.sleep(float(os.getenv('PERF_MOCK_DELAY', '.4')))
            if mode == 'tool': emit(type='tool_execution_end', toolName='mock', toolCallId='one', isError=False)
        if mode == 'cancel': time.sleep(60)
        emit(type='message_update', assistantMessageEvent={'type':'text_delta','delta':'mock answer'})
        emit(type='agent_settled')
    elif cmd == 'get_last_assistant_text':
        emit(type='response', command=cmd, success=True, data={'text':'mock answer'})
    elif cmd == 'get_session_stats' and mode != 'missing_stats':
        emit(type='response', command=cmd, success=True, data={'tokens':{'input':0,'output':0}})
