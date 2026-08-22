import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sshTarget = process.env.PANDASUB_SSH_TARGET || 'tx'
const deployPath = process.env.PANDASUB_DEPLOY_PATH
  || '/home/ubuntu/timedot_backend/app/site/novelsub'
const siteUrl = 'https://pandasub.zhudot.com'

function fail(message) {
  throw new Error(message)
}

function run(command, args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) fail(`${command} 执行失败：${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? String(result.stderr || result.stdout || '').trim() : ''
    fail(`${command} 执行失败${detail ? `：${detail}` : ''}`)
  }
  return capture ? String(result.stdout || '').trim() : ''
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
}

function writeJson(relativePath, value) {
  fs.writeFileSync(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`)
}

function updateVersionFiles(version, notes, date) {
  const packageJson = readJson('package.json')
  packageJson.version = version
  writeJson('package.json', packageJson)

  const packageLock = readJson('package-lock.json')
  packageLock.version = version
  if (packageLock.packages?.['']) packageLock.packages[''].version = version
  writeJson('package-lock.json', packageLock)

  const tauriConfig = readJson('src-tauri/tauri.conf.json')
  tauriConfig.version = version
  writeJson('src-tauri/tauri.conf.json', tauriConfig)

  const cargoPath = path.join(root, 'src-tauri/Cargo.toml')
  const cargo = fs.readFileSync(cargoPath, 'utf8')
  if (!/^version = ".*"$/m.test(cargo)) fail('无法更新 src-tauri/Cargo.toml 版本号')
  fs.writeFileSync(cargoPath, cargo.replace(/^version = ".*"$/m, `version = "${version}"`))

  const cargoLockPath = path.join(root, 'src-tauri/Cargo.lock')
  const cargoLock = fs.readFileSync(cargoLockPath, 'utf8')
  const nextCargoLock = cargoLock.replace(
    /(\[\[package\]\]\nname = "app"\nversion = ")[^"]+/, `$1${version}`,
  )
  if (nextCargoLock === cargoLock) fail('无法更新 src-tauri/Cargo.lock 版本号')
  fs.writeFileSync(cargoLockPath, nextCargoLock)

  const release = readJson('release-site/release.json')
  release.version = version
  release.date = date
  release.notes = notes
  release.downloads = {
    windows: {
      label: '64 位版',
      detail: 'Windows 10 / 11 · 64 位',
      url: `releases/pandasub-${version}-windows-x64-setup.exe`,
    },
    macos: {
      label: '通用版',
      detail: 'Apple 芯片 / Intel · macOS 11 及以上',
      url: `releases/pandasub-${version}-macos-universal.dmg`,
    },
  }
  writeJson('release-site/release.json', release)

  const appPath = path.join(root, 'release-site/app.js')
  const app = fs.readFileSync(appPath, 'utf8')
  const fallback = `const fallback = ${JSON.stringify({
    version, date, notes, downloads: {},
  }, null, 2)}`
  const nextApp = app.replace(/const fallback = \{[\s\S]*?\n\}/, fallback)
  if (nextApp === app) fail('无法更新下载页兜底版本信息')
  fs.writeFileSync(appPath, nextApp)
}

function allFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)
    return entry.isDirectory() ? allFiles(fullPath) : [fullPath]
  })
}

function onlyAsset(files, suffix, label) {
  const matches = files.filter((file) => file.toLowerCase().endsWith(suffix))
  if (matches.length !== 1) {
    fail(`未找到唯一的${label}，实际找到 ${matches.length} 个`)
  }
  return matches[0]
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function megabytes(file) {
  const size = fs.statSync(file).size / 1024 / 1024
  return `${size >= 10 ? Math.round(size) : size.toFixed(1)} MB`
}

function copyFile(source, directory, name) {
  const destination = path.join(directory, name)
  fs.copyFileSync(source, destination)
  return destination
}

function waitForReleaseBuild(tag, commit) {
  let runId = ''
  for (let attempt = 0; attempt < 30 && !runId; attempt += 1) {
    const output = run('gh', [
      'run', 'list', '--workflow', 'build.yml', '--limit', '20',
      '--json', 'databaseId,headBranch,headSha,event',
    ], { capture: true })
    const runs = JSON.parse(output || '[]')
    const matched = runs.find((item) => item.headBranch === tag || item.headSha === commit)
    if (matched) runId = String(matched.databaseId)
    else run('sleep', ['2'])
  }
  if (!runId) fail('没有找到本次 GitHub 安装包构建任务')
  console.log(`\n等待 GitHub 构建 macOS 和 Windows 安装包（任务 ${runId}）...`)
  run('gh', ['run', 'watch', runId, '--exit-status'])
  return runId
}

function prepareDeployment(version, notes, date, assetsDir) {
  const files = allFiles(assetsDir)
  const windowsSource = onlyAsset(files, '.exe', 'Windows 安装包')
  const macDmgSource = onlyAsset(files, '.dmg', 'macOS 安装包')
  const macUpdaterSource = onlyAsset(files, '.app.tar.gz', 'macOS 更新包')
  const windowsSignatureSource = onlyAsset(files, '.exe.sig', 'Windows 更新签名')
  const macSignatureSource = onlyAsset(files, '.app.tar.gz.sig', 'macOS 更新签名')

  const deployDir = fs.mkdtempSync(path.join(os.tmpdir(), `pandasub-${version}-`))
  const releasesDir = path.join(deployDir, 'releases')
  fs.mkdirSync(releasesDir, { recursive: true })
  fs.cpSync(path.join(root, 'release-site/assets'), path.join(deployDir, 'assets'), { recursive: true })
  for (const name of ['index.html', 'styles.css', 'app.js']) {
    fs.copyFileSync(path.join(root, 'release-site', name), path.join(deployDir, name))
  }

  const windowsName = `pandasub-${version}-windows-x64-setup.exe`
  const macDmgName = `pandasub-${version}-macos-universal.dmg`
  const macUpdaterName = `pandasub-${version}-darwin-universal.app.tar.gz`
  const windowsFile = copyFile(windowsSource, releasesDir, windowsName)
  const macDmgFile = copyFile(macDmgSource, releasesDir, macDmgName)
  copyFile(macUpdaterSource, releasesDir, macUpdaterName)
  copyFile(windowsSignatureSource, releasesDir, `${windowsName}.sig`)
  copyFile(macSignatureSource, releasesDir, `${macUpdaterName}.sig`)

  const release = {
    version,
    date,
    notes,
    downloads: {
      windows: {
        label: '64 位版',
        detail: `Windows 10 / 11 · 64 位 · ${megabytes(windowsFile)}`,
        url: `releases/${windowsName}`,
        sha256: sha256(windowsFile),
      },
      macos: {
        label: '通用版',
        detail: `Apple 芯片 / Intel · macOS 11 及以上 · ${megabytes(macDmgFile)}`,
        url: `releases/${macDmgName}`,
        sha256: sha256(macDmgFile),
      },
    },
  }
  const updaterUrl = `${siteUrl}/releases/${macUpdaterName}`
  const macPlatform = {
    signature: fs.readFileSync(macSignatureSource, 'utf8').trim(),
    url: updaterUrl,
  }
  const latest = {
    version,
    notes: notes.join('\n'),
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: fs.readFileSync(windowsSignatureSource, 'utf8').trim(),
        url: `${siteUrl}/releases/${windowsName}`,
      },
      'darwin-aarch64': macPlatform,
      'darwin-x86_64': macPlatform,
    },
  }
  fs.writeFileSync(path.join(deployDir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`)
  fs.writeFileSync(path.join(deployDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`)
  writeJson('release-site/release.json', release)
  writeJson('release-site/latest.json', latest)
  return deployDir
}

async function main() {
  const [version, ...noteParts] = process.argv.slice(2)
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail('用法：npm run release:publish -- 0.1.6 "更新说明一；更新说明二"')
  }
  const noteText = noteParts.join(' ').trim()
  if (!noteText) fail('请填写本次更新说明')
  const notes = noteText.split(/[；|]/).map((item) => item.trim()).filter(Boolean)
  const tag = `v${version}`
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())

  for (const command of ['git', 'gh', 'ssh', 'rsync']) {
    run('which', [command], { capture: true })
  }
  if (run('git', ['branch', '--show-current'], { capture: true }) !== 'main') {
    fail('请切换到 main 分支后发布')
  }
  run('gh', ['auth', 'status'], { capture: true })
  run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', sshTarget, 'true'])
  run('git', ['fetch', 'origin', '--tags'])
  const existingTag = run('git', ['tag', '--list', tag], { capture: true })
  let commit
  let runId
  if (existingTag) {
    const currentVersion = readJson('package.json').version
    if (currentVersion !== version) {
      fail(`版本标签 ${tag} 已存在，但当前项目版本是 ${currentVersion}`)
    }
    console.log(`\n继续上次未完成的 ${tag} 发布`)
    const pending = run('git', ['status', '--short'], { capture: true })
    if (pending) {
      console.log(`\n本次会提交这些发布修复：\n${pending}`)
      run('git', ['add', '-A'])
      run('git', ['commit', '-m', `fix: repair ${tag} release pipeline`])
    }
    run('git', ['push', 'origin', 'main'])
    commit = run('git', ['rev-parse', 'HEAD'], { capture: true })
    run('gh', ['workflow', 'run', 'build.yml', '--ref', 'main'])
    runId = waitForReleaseBuild('', commit)
  } else {
    console.log(`\n准备发布熊猫投稿 ${tag}`)
    const pending = run('git', ['status', '--short'], { capture: true })
    if (pending) console.log(`\n本次会一并发布这些修改：\n${pending}`)
    updateVersionFiles(version, notes, date)
    run('git', ['add', '-A'])
    run('git', ['commit', '-m', `release: prepare ${tag}`])
    run('git', ['tag', '-a', tag, '-m', `熊猫投稿 ${tag}`])
    run('git', ['push', 'origin', 'main', `refs/tags/${tag}`])
    commit = run('git', ['rev-parse', 'HEAD'], { capture: true })
    runId = waitForReleaseBuild(tag, commit)
  }

  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), `pandasub-assets-${version}-`))
  run('gh', ['run', 'download', runId, '--dir', downloadDir])
  const deployDir = prepareDeployment(version, notes, date, downloadDir)

  console.log('\n上传下载站和安装包...')
  run('ssh', [sshTarget, 'mkdir', '-p', `${deployPath}/releases`])
  run('rsync', ['-az', `${deployDir}/`, `${sshTarget}:${deployPath}/`])

  const response = await fetch(`${siteUrl}/latest.json?version=${encodeURIComponent(version)}`, {
    cache: 'no-store',
  })
  if (!response.ok) fail(`下载站校验失败：HTTP ${response.status}`)
  const deployed = await response.json()
  if (deployed.version !== version) fail(`下载站仍显示 ${deployed.version}，期望 ${version}`)

  const metadataChanges = run('git', [
    'status', '--porcelain', '--', 'release-site/release.json', 'release-site/latest.json',
  ], { capture: true })
  if (metadataChanges) {
    run('git', ['add', 'release-site/release.json', 'release-site/latest.json'])
    run('git', ['commit', '-m', `release: publish ${tag} [skip ci]`])
    run('git', ['push', 'origin', 'main'])
  }

  const releaseExists = run('gh', ['release', 'view', tag, '--json', 'tagName'], {
    capture: true, allowFailure: true,
  })
  if (!releaseExists) {
    run('gh', ['release', 'create', tag, '--draft', '--title', `熊猫投稿 ${tag}`,
      '--notes', notes.join('\n')])
  }
  const releaseFiles = allFiles(path.join(deployDir, 'releases'))
  run('gh', ['release', 'upload', tag, ...releaseFiles, '--clobber'])
  run('gh', ['release', 'edit', tag, '--title', `熊猫投稿 ${tag}`,
    '--notes', notes.join('\n'), '--draft=false', '--latest'])

  console.log(`\n发布完成：${siteUrl}/`)
  console.log(`GitHub Release：https://github.com/logyxiao/PandaSub/releases/tag/${tag}`)
}

main().catch((error) => {
  console.error(`\n发布失败：${error.message}`)
  process.exitCode = 1
})
