import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
export const assetNames = version => [
  `pandasub-${version}-windows-x64-setup.exe`,
  `pandasub-${version}-macos-universal.dmg`,
  `pandasub-${version}-darwin-universal.app.tar.gz`,
]
export function validateManifest(manifest, version, commit, directory) {
  if (manifest.version !== version || manifest.commit !== commit) throw new Error('构建来源与发布标签不一致')
  const names = assetNames(version)
  if (Object.keys(manifest.files ?? {}).sort().join('\n') !== names.sort().join('\n')) throw new Error('发布文件清单不完整')
  for (const name of names) {
    if (hashFile(path.join(directory, name)) !== manifest.files[name]) throw new Error(`安装包校验失败：${name}`)
  }
}
export function verifySignatures(root, directory, version, run) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json')))
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pandasub-verify-'))
  try {
    const publicKey = path.join(scratch, 'updater.pub')
    fs.writeFileSync(publicKey, Buffer.from(config.plugins.updater.pubkey, 'base64'))
    for (const name of assetNames(version).filter(name => !name.endsWith('.dmg'))) {
      const signature = path.join(scratch, `${name}.sig`)
      fs.writeFileSync(signature, Buffer.from(fs.readFileSync(path.join(directory, `${name}.sig`), 'utf8').trim(), 'base64'))
      run('minisign', ['-Vm', path.join(directory, name), '-p', publicKey, '-x', signature])
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}

export function localPreflight(run) {
  if (process.platform !== 'darwin') throw new Error('本地双平台发布需要 macOS')
  for (const command of ['cargo-xwin', 'makensis', 'minisign', 'hdiutil']) run('which', [command], { capture: true })
  const llvm = run('brew', ['--prefix', 'llvm'], { capture: true })
  const lld = run('brew', ['--prefix', 'lld'], { capture: true })
  process.env.PATH = `${llvm}/bin:${lld}/bin:${process.env.PATH}`
  process.env.XWIN_CACHE_DIR ||= path.join(os.homedir(), 'Library/Caches/NovelSub/xwin')
  for (const command of ['clang-cl', 'lld-link']) run('which', [command], { capture: true })
  const targets = run('rustup', ['target', 'list', '--installed'], { capture: true })
  for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc']) {
    if (!targets.split('\n').includes(target)) throw new Error(`请先安装 Rust target：${target}`)
  }
}

export function buildAndSignLocal({ root, version, commit, notes, run, runWithRetry }) {
  const tag = `v${version}`
  const directory = path.join(root, 'src-tauri/target/local-release', tag)
  const manifestPath = path.join(directory, 'local-build.json')
  fs.mkdirSync(directory, { recursive: true })
  const names = assetNames(version)
  if (fs.existsSync(manifestPath)) {
    validateManifest(JSON.parse(fs.readFileSync(manifestPath)), version, commit, directory)
    console.log('\n复用已校验的本机构建产物')
  } else {
    const started = Date.now()
    console.log('\n本机构建 Windows x64（复用 Rust / Windows SDK 缓存）...')
    run('npm', ['run', 'tauri', '--', 'build', '--runner', 'cargo-xwin', '--target', 'x86_64-pc-windows-msvc',
      '--config', JSON.stringify({ bundle: { targets: ['nsis'], createUpdaterArtifacts: false } }), '--ci'])
    console.log('\n本机构建 macOS 通用安装包...')
    run('npm', ['run', 'tauri', '--', 'build', '--target', 'universal-apple-darwin', '--bundles', 'app,dmg',
      '--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }), '--ci'])
    const bundle = path.join(root, 'src-tauri/target/universal-apple-darwin/release/bundle')
    fs.copyFileSync(path.join(root, `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/熊猫投稿_${version}_x64-setup.exe`), path.join(directory, names[0]))
    fs.copyFileSync(path.join(bundle, `dmg/熊猫投稿_${version}_universal.dmg`), path.join(directory, names[1]))
    run('tar', ['-czf', path.join(directory, names[2]), '-C', path.join(bundle, 'macos'), '熊猫投稿.app'], { env: { COPYFILE_DISABLE: '1' } })
    fs.writeFileSync(manifestPath, `${JSON.stringify({ version, commit, files: Object.fromEntries(names.map(name => [name, hashFile(path.join(directory, name))])) }, null, 2)}\n`)
    console.log(`\n本机双平台构建完成，用时 ${Math.round((Date.now() - started) / 1000)} 秒`)
  }
  const release = run('gh', ['release', 'view', tag, '--json', 'isDraft'], { capture: true, allowFailure: true })
  if (release && !JSON.parse(release).isDraft) throw new Error('该版本已正式发布，不能覆盖安装包；请使用新版本号')
  if (!release) run('gh', ['release', 'create', tag, '--verify-tag', '--draft', '--title', `熊猫投稿 ${tag}`, '--notes', notes.join('\n')])
  const signed = names.filter(name => !name.endsWith('.dmg'))
  if (signed.every(name => fs.existsSync(path.join(directory, `${name}.sig`)))) {
    verifySignatures(root, directory, version, run)
    return directory
  }
  runWithRetry('gh', ['release', 'upload', tag, ...names.map(name => path.join(directory, name)), manifestPath, '--clobber'])
  if (process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    for (const name of signed) run('npm', ['run', 'tauri', '--', 'signer', 'sign', path.join(directory, name)])
  } else {
    const existing = JSON.parse(run('gh', ['run', 'list', '--workflow', 'sign-local-release.yml', '--limit', '100', '--json', 'databaseId'], { capture: true }))
    const previous = new Set(existing.map(item => item.databaseId))
    runWithRetry('gh', ['workflow', 'run', 'sign-local-release.yml', '--ref', tag])
    let id
    for (let attempt = 0; attempt < 30 && !id; attempt++) {
      const runs = JSON.parse(run('gh', ['run', 'list', '--workflow', 'sign-local-release.yml', '--limit', '20', '--json', 'databaseId,headBranch,headSha'], { capture: true }))
      id = runs.find(item => !previous.has(item.databaseId) && item.headBranch === tag && item.headSha === commit)?.databaseId
      if (!id) run('sleep', ['2'])
    }
    if (!id) throw new Error('没有找到签名任务；可以使用同一发布命令续跑')
    console.log(`\nGitHub 仅签名，不进行编译（任务 ${id}）...`)
    run('gh', ['run', 'watch', String(id), '--exit-status'])
    for (const name of signed) runWithRetry('gh', ['release', 'download', tag, '--pattern', `${name}.sig`, '--dir', directory, '--clobber'])
  }
  validateManifest(JSON.parse(fs.readFileSync(manifestPath)), version, commit, directory)
  verifySignatures(root, directory, version, run)
  return directory
}

// Assets are immutable. Verify a private staging directory before moving any
// public metadata; a failed transfer leaves the previous updater manifest live.
export function deployAtomic({ directory, deployPath, sshTarget, version, run }) {
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(deployPath)) throw new Error('服务器部署路径含不支持的字符')
  const hashes = Object.fromEntries(fs.readdirSync(path.join(directory, 'releases')).map(name => [name, hashFile(path.join(directory, 'releases', name))]))
  const stage = `${deployPath}/.staging-${version}-${Date.now()}`
  run('ssh', [sshTarget, 'mkdir', '-p', stage])
  run('rsync', ['-az', `${directory}/`, `${sshTarget}:${stage}/`])
  const payload = Buffer.from(JSON.stringify({ stage, deployPath, hashes })).toString('base64')
  const script = `import base64,json,hashlib,pathlib,os,shutil\np=json.loads(base64.b64decode('${payload}'))\ns=pathlib.Path(p['stage']); d=pathlib.Path(p['deployPath'])\nfor name,digest in p['hashes'].items():\n f=s/'releases'/name\n assert hashlib.sha256(f.read_bytes()).hexdigest()==digest, name\n existing=d/'releases'/name\n assert not existing.exists() or hashlib.sha256(existing.read_bytes()).hexdigest()==digest, 'refusing to overwrite published asset: '+name\n(d/'releases').mkdir(exist_ok=True)\nfor name in p['hashes']: os.replace(s/'releases'/name,d/'releases'/name)\nshutil.copytree(s/'assets',d/'assets',dirs_exist_ok=True)\nfor name in ['styles.css','app.js','index.html','release.json','latest.json']: os.replace(s/name,d/name)\nshutil.rmtree(s)\nprint('Server SHA-256 checks passed; updater manifest published last')\n`
  const encoded = Buffer.from(script).toString('base64')
  run('ssh', [sshTarget, `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`])
}
