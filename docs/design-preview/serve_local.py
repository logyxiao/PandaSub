#!/usr/bin/env python3
"""Serve a read-only, in-memory projection of NovelSub data on loopback only."""
import argparse
import datetime as dt
import json
import sqlite3
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
DB = Path.home() / 'Library/Application Support/com.novelsub.desktop/novelsub.sqlite'
FAILURES = "level='error' AND category IN ('send','network','limit','auth') AND trim(coalesce(recipient,'')) <> ''"


def snapshot(path):
    # Do not copy the database or select credentials, attachment blobs, or settings.
    conn = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA query_only=ON')
    conn.execute('BEGIN')
    def rows(sql):
        return [dict(row) for row in conn.execute(sql)]
    def number(sql):
        return conn.execute(sql).fetchone()[0]
    data = {
        'captured_at': dt.datetime.now().astimezone().isoformat(timespec='seconds'),
        'today': dt.date.today().isoformat(),
        'accounts': rows("SELECT id,email,sender_name,provider,enabled,check_replies,last_sent_at FROM accounts ORDER BY id"),
        'manuscripts': rows("SELECT id,title,body,subject,word_count,category,genres,recipients,account_ids,sender_name,send_interval_from_sec,send_interval_to_sec,mail_templates,file_name,created_at,updated_at FROM manuscripts ORDER BY updated_at DESC,id DESC"),
        'tasks': rows("SELECT id,name,manuscript_ids,account_ids,status,schedule_type,scheduled_at,retry_max,sent,total,created_at,started_at,finished_at FROM tasks ORDER BY id DESC"),
        'editors': rows("SELECT id,name,platform,email,work_type,rejected_types,notes,enabled,favorited FROM editors ORDER BY favorited DESC,id"),
        'groups': rows("SELECT id,name FROM editor_groups ORDER BY id"),
        'group_members': rows("SELECT group_id,editor_id FROM editor_group_members ORDER BY group_id,position"),
        'deliveries': rows("SELECT id,task_id,manuscript_id,account_id,recipient,subject,sent_at FROM deliveries ORDER BY sent_at DESC,id DESC"),
        'replies': rows("SELECT r.id,r.delivery_id,r.account_id,r.task_id,r.from_email,r.subject,r.snippet,r.body,r.kind,r.accepted,r.received_at,d.manuscript_id FROM replies r LEFT JOIN deliveries d ON d.id=r.delivery_id ORDER BY r.received_at DESC,r.id DESC"),
        'failures': rows(f"SELECT id,task_id,manuscript_id,account_id,recipient,category,created_at FROM task_logs WHERE {FAILURES} ORDER BY created_at DESC,id DESC"),
        'counts': {
            'plans': number('SELECT count(*) FROM manuscripts'),
            'editors': number('SELECT count(*) FROM editors'),
            'deliveries': number('SELECT count(*) FROM deliveries'),
            'replies': number('SELECT count(*) FROM replies'),
            'human': number("SELECT count(*) FROM replies WHERE kind='human'"),
            'auto': number("SELECT count(*) FROM replies WHERE kind='auto'"),
            'accepted': number('SELECT count(*) FROM replies WHERE accepted=1'),
            'running': number("SELECT count(*) FROM tasks WHERE status='running'"),
            'sent_today': number("SELECT count(*) FROM deliveries WHERE date(sent_at)=date('now','localtime')"),
            'failed_today': number(f"SELECT count(*) FROM task_logs WHERE {FAILURES} AND date(created_at)=date('now','localtime')"),
        },
    }
    conn.rollback()
    conn.close()
    for key, fields in [('manuscripts',['genres','recipients','account_ids','mail_templates']),('tasks',['manuscript_ids','account_ids']),('editors',['work_type','rejected_types'])]:
        for row in data[key]:
            for field in fields:
                try:
                    row[field] = json.loads(row[field] or '[]')
                except (ValueError, TypeError):
                    row[field] = []
    return data


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get('Host', '').split(':')[0] not in ('localhost', '127.0.0.1'):
            self.send_error(403)
            return
        route = urlsplit(self.path).path
        if route == '/docs/design-preview/local-data.js':
            # Snapshot only refreshes when the server is restarted, not on UI actions.
            body, mime = self.server.payload, 'text/javascript; charset=utf-8'
        else:
            files = {'/src/assets/logo.png': (ROOT.parent.parent / 'src/assets/logo.png', 'image/png')}
            for name, mime in [('index.html','text/html; charset=utf-8'),('style.css','text/css; charset=utf-8'),('app.js','text/javascript; charset=utf-8'),('local.js','text/javascript; charset=utf-8'),('design-v2.css','text/css; charset=utf-8'),('design-v2.js','text/javascript; charset=utf-8'),('editors-v3.css','text/css; charset=utf-8'),('editors-v3.js','text/javascript; charset=utf-8'),('panda.css','text/css; charset=utf-8')]:
                files['/docs/design-preview/' + name] = (ROOT / name, mime)
            files['/docs/design-preview/'] = files['/docs/design-preview/index.html']
            files['/'] = files['/docs/design-preview/index.html']
            if route not in files:
                self.send_error(404)
                return
            path, mime = files[route]
            body = path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', type=Path, default=DB)
    parser.add_argument('--port', type=int, default=4318)
    args = parser.parse_args()
    data = snapshot(args.db)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.payload = ('window.NOVELSUB_LOCAL_DATA = ' + json.dumps(data, ensure_ascii=False).replace('<','\\u003c') + ';').encode()
    print('Local read-only preview: http://127.0.0.1:%s/docs/design-preview/' % args.port, flush=True)
    print('Snapshot counts: ' + json.dumps(data['counts']), flush=True)
    server.serve_forever()

if __name__ == '__main__':
    main()
