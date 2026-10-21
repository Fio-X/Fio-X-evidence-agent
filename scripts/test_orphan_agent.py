#!/usr/bin/env python3
"""A killed parent must not leave the Rust agent child asking the model for more.

Test tool only, standard library only, no network beyond 127.0.0.1, no key.

    NEWS_BIN=target/release/news python3 scripts/test_orphan_agent.py WORKDIR

Starts scripts/standin_relay.py and `news investigate` on the Rust agent path, waits for the child's first model request, kills `news` with SIGKILL
(its own pid only, so the agent child is orphaned) and then answers that request with a tool call. A child that noticed its parent was gone stops; one that
did not runs the tool and asks the model again (a second request). Exits 1 when a second request arrives.
"""
import json, os, signal, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import smoke_loopback_guard as guard  # noqa: E402


def orphans(work):
    listing = subprocess.run(['ps', '-axo', 'pid=,pgid=,command='], capture_output=True, text=True).stdout
    found = []
    for line in listing.splitlines():
        pid, pgid, command = line.split(None, 2)
        if str(work) in command and '__agent_rpc' in command: found.append((int(pid), int(pgid)))
    return found


def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    work = Path(sys.argv[1]).resolve()
    news = os.environ.get('NEWS_BIN')
    if not news or not Path(news).exists(): sys.exit('set NEWS_BIN to a built news binary')
    work.mkdir(parents=True, exist_ok=True)
    if any(work.iterdir()): sys.exit(f'{work} is not empty')
    relay_dir = work / 'relay'
    relay = subprocess.Popen([sys.executable, str(HERE / 'standin_relay.py'), '--workdir', str(relay_dir), '--port', '0'],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    parent = None
    try:
        url = relay.stdout.readline().split()[-1]
        guard.require_loopback(url, 'the relay address')
        env = {k: v for k, v in os.environ.items() if not (k.startswith('NEWSROOM_') or k.endswith(('_API_KEY', '_BASE_URL', '_TOKEN')))}
        env.update({'NEWSROOM_AGENT': 'rust', 'NEWSROOM_AGENT_LOCAL_URL': url, 'NEWSROOM_RPC_IDLE_MS': '120000',
                    'NEWSROOM_RPC_TOTAL_MS': '120000', 'NEWSROOM_RPC_FINISH_MS': '120000', 'HOME': str(work / 'home')})
        guard.check_env(env)
        (work / 'home').mkdir()
        parent = subprocess.Popen([news, 'investigate', '--out', str(work / 'out'), 'a small question'], cwd=work, env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        deadline = time.monotonic() + 60
        while not (relay_dir / 'req-1.json').exists():
            assert time.monotonic() < deadline and parent.poll() is None, 'the first model request never came'
            time.sleep(0.05)
        assert orphans(work), 'the agent child is not running'
        parent.kill(); parent.wait()
        reply = {'tool_calls': [{'name': 'artifact_inventory', 'arguments': {}}]}
        (relay_dir / 'reply-1.json.tmp').write_text(json.dumps(reply))
        (relay_dir / 'reply-1.json.tmp').rename(relay_dir / 'reply-1.json')
        time.sleep(4)
        second = (relay_dir / 'req-2.json').exists()
        print(('FAIL' if second else 'PASS') + ' after the parent was killed the child ' + ('asked the model again' if second else 'asked no more'))
        sys.exit(1 if second else 0)
    finally:
        for _pid, pgid in set(orphans(work)):
            try: os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError: pass
        if parent and parent.poll() is None: parent.kill()
        relay.terminate()


if __name__ == '__main__':
    main()
