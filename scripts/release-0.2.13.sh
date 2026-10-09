#!/usr/bin/env bash
set -euo pipefail

# Run from any directory; an optional argument overrides the release version.
release_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$release_root"
release_version="${1:-0.2.13}"
if [[ ! "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf '版本号格式不正确：%s\n' "$release_version" >&2
  exit 1
fi

# The existing publisher stages all changes. Keep personal import artifacts local.
python3 - <<'PY'
from pathlib import Path
import subprocess

patterns = [
    '/docs/editor-library-male-import-*.json',
    '/docs/editor-library-bl-roommate-import-*.json',
    '/docs/editor-group-female-reply-time-*.json',
    '/docs/*编辑组-*.json',
    '/docs/*编辑匹配明细-*.md',
    '/docs/*编辑组-回复时间筛选明细-*.md',
]
tracked = subprocess.check_output(
    ['git', 'ls-files', '-z', '--', *[p.lstrip('/') for p in patterns]],
).decode().strip('\0')
if tracked:
    raise SystemExit('个人编辑明细已被 Git 跟踪，请先取消跟踪再发布：\n' + tracked.replace('\0', '\n'))
exclude = Path(subprocess.check_output(['git', 'rev-parse', '--git-path', 'info/exclude'], text=True).strip())
exclude.parent.mkdir(parents=True, exist_ok=True)
content = exclude.read_text() if exclude.exists() else ''
missing = [p for p in patterns if p not in content.splitlines()]
if missing:
    with exclude.open('a') as out:
        out.write(('\n' if content and not content.endswith('\n') else '')
                  + '\n# Personal editor import artifacts\n' + '\n'.join(missing) + '\n')
print('本次私人编辑明细已排除出 Git 提交。')
PY

npm test
python3 scripts/run-ui-tests.py test-plan-group-dedup-ui.py test-editor-reply-time-ui.py
npm run build

# Builds both platforms, signs artifacts, and publishes GitHub / download-site updates.
npm run release:local -- "$release_version" \
  '编辑组成员显示平均回复时间及有效投递次数；选择编辑组投递时同平台只选一位，优先收藏编辑，临时名单支持同平台替换'
