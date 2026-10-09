"""Start one isolated Vite server and run mock-only UI regressions. No Tauri process or user DB."""
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
TESTS = ['test-accepted-mail-ui.py', 'test-mail-templates-ui.py', 'test-plan-mailboxes-ui.py', 'test-account-notes-selection-ui.py', 'test-inbox-read-all-ui.py', 'test-accepted-word-count-ui.py', 'test-plan-detail-editors-ui.py', 'test-editor-dialog-stability-ui.py', 'test-relative-schedule-ui.py', 'test-scheduled-send-ui.py', 'test-editor-reply-time-ui.py', 'test-inbox-batch-ui.py', 'test-paused-inbox-ui.py', 'test-editor-blocks-ui.py', 'test-workflow-ui.py', 'test-panda-ui.py', 'test-inbox-ui.py', 'test-inbox-preview-ui.py', 'test-accepted-ui.py',
         'test-plan-group-dedup-ui.py', 'test-optimization-ui.py', 'test-accepted-safety-ui.py', 'test-unread-ui.py', 'test-tray-inbox-ui.py', 'test-mail-sync-ui.py', 'test-mail-detail-ui.py', 'test-mail-performance-ui.py', 'test-mail-races-ui.py', 'test-plan-performance-ui.py', 'test-module-audit-ui.py', 'test-boundary-recovery-ui.py', 'test-mail-loading-and-dialog-ui.py', 'test-local-mail-and-confirm-ui.py']

def main():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    env = {**os.environ, 'NOVELSUB_TEST_URL': url, 'NOVELSUB_UI_URL': url}
    args = ['node', str(ROOT / 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', str(port), '--strictPort']
    with tempfile.TemporaryFile(mode='w+t') as log:
        server = subprocess.Popen(args, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, start_new_session=os.name != 'nt')
        try:
            deadline = time.monotonic() + 30
            while True:
                if server.poll() is not None:
                    raise RuntimeError('Vite server exited before startup')
                try:
                    with urlopen(url, timeout=1) as response:
                        if response.status == 200: break
                except OSError:
                    pass
                if time.monotonic() >= deadline: raise TimeoutError('Vite server startup timed out')
                time.sleep(0.1)
            for name in sys.argv[1:] or TESTS:
                if name not in TESTS: raise ValueError(f'Unknown UI test: {name}')
                print(f'Running {name}', flush=True)
                subprocess.run([sys.executable, str(ROOT / 'scripts' / name)], cwd=ROOT, env=env, check=True, timeout=240)
        except Exception:
            log.seek(0)
            print(log.read(), file=sys.stderr)
            raise
        finally:
            if server.poll() is None:
                if os.name == 'nt': server.terminate()
                else: os.killpg(server.pid, signal.SIGTERM)
                try: server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    if os.name == 'nt': server.kill()
                    else: os.killpg(server.pid, signal.SIGKILL)
                    server.wait()

if __name__ == '__main__':
    main()
