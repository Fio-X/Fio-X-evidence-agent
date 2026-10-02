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
def chart_files(key):
    # The rendered SVG files the runtime leaves in the artifact folder before a result names them.
    root = os.environ['NEWSROOM_ARTIFACT_DIR']
    os.makedirs(os.path.join(root, 'visualizations'), exist_ok=True)
    for name in (key + '.svg', key + '.compact.svg'):
        with open(os.path.join(root, 'visualizations', name), 'w') as f: f.write('<svg/>')
def chain_chart(call_id, key, critic_passed=True, status='COMPLETE', desktop=None):
    # One chart chain as the runtime reports it: the four steps' typed details.
    chart_files(key)
    manifest = 'visualizations/' + key + '.json'
    plan = 'visualizations/plans/' + key + '.json'
    steps = [
        {'tool': 'newsroom_viz_plan', 'params': {}, 'details': {'planRef': plan, 'publishable': True}},
        {'tool': 'newsroom_viz_lint', 'params': {'plan_ref': plan}, 'details': {'passed': True}},
        {'tool': 'newsroom_viz_render', 'params': {'plan_ref': plan},
         'details': {'manifestRef': manifest, 'desktopSvgRef': desktop or 'visualizations/' + key + '.svg',
                     'compactSvgRef': 'visualizations/' + key + '.compact.svg', 'renderQaPassed': True}},
        {'tool': 'newsroom_viz_critic', 'params': {'manifest_ref': manifest}, 'details': {'passed': critic_passed}},
    ]
    details = {'chain': 'newsroom_viz_chain', 'chainStatus': status, 'steps': steps, 'manifestRef': manifest}
    if status != 'COMPLETE': details.update(failedAt='newsroom_viz_critic', stopCode='REVISE')
    emit(type='tool_execution_start', toolName='newsroom_viz_chain', toolCallId=call_id, args={})
    emit(type='tool_execution_end', toolName='newsroom_viz_chain', toolCallId=call_id, isError=False, result={'details': details})
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
        if mode == 'chain_chart':
            # PERF_MOCK_CHAIN_CASE: ok (default), two charts, a critic revision then a retry that passes,
            # a revision only, a chain whose desktop ref leaves visualizations/, or separate render and critic calls.
            case = os.getenv('PERF_MOCK_CHAIN_CASE', 'ok')
            if case in ('revise', 'revise_only'): chain_chart('v1', 'a', critic_passed=False, status='STOPPED')
            if case in ('ok', 'two', 'revise'): chain_chart('v2', 'b')
            if case == 'two': chain_chart('v3', 'c')
            if case == 'unsafe_ref': chain_chart('v4', 'd', desktop='/tmp/outside.svg')
            if case == 'separate':
                # The classic route: a render call, then a critic call for its manifest.
                chart_files('e')
                emit(type='tool_execution_start', toolName='newsroom_viz_render', toolCallId='r1', args={})
                emit(type='tool_execution_end', toolName='newsroom_viz_render', toolCallId='r1', isError=False,
                     result={'details': {'manifestRef': 'visualizations/e.json', 'desktopSvgRef': 'visualizations/e.svg', 'compactSvgRef': 'visualizations/e.compact.svg'}})
                emit(type='tool_execution_start', toolName='newsroom_viz_critic', toolCallId='c1', args={'manifest_ref': 'visualizations/e.json'})
                emit(type='tool_execution_end', toolName='newsroom_viz_critic', toolCallId='c1', isError=False, result={'details': {'passed': True}})
            # The model goes on working after the chart; the notice must not wait for this.
            time.sleep(float(os.getenv('PERF_MOCK_AFTER_CHART', '0')))
        emit(type='message_update', assistantMessageEvent={'type':'text_delta','delta':'mock answer'})
        emit(type='agent_settled')
    elif cmd == 'get_last_assistant_text':
        emit(type='response', command=cmd, success=True, data={'text':'mock answer'})
    elif cmd == 'get_session_stats' and mode != 'missing_stats':
        emit(type='response', command=cmd, success=True, data={'tokens':{'input':0,'output':0}})
