import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assetNames, hashFile, validateManifest, verifySignatures, deployAtomic } from './local-release.mjs'
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pandasub-release-test-'))
const version = '9.1.0', commit = 'fixture-source'
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' })
try {
  const files = assetNames(version)
  for (const file of files) fs.writeFileSync(path.join(temp, file), `fixture ${file}`)
  const manifest = { version, commit, files: Object.fromEntries(files.map(file => [file, hashFile(path.join(temp, file))])) }
  validateManifest(manifest, version, commit, temp)
  assert.throws(() => validateManifest(manifest, version, 'different-source', temp), /来源/)
  assert.throws(() => validateManifest({ ...manifest, files: {} }, version, commit, temp), /不完整/)
  fs.appendFileSync(path.join(temp, files[0]), 'tampered')
  assert.throws(() => validateManifest(manifest, version, commit, temp), /校验失败/)
  fs.writeFileSync(path.join(temp, files[0]), `fixture ${files[0]}`)
  // Ephemeral fixture keys never touch the app's real update key.
  run('minisign', ['-G', '-W', '-p', path.join(temp, 'fixture.pub'), '-s', path.join(temp, 'fixture.key')])
  fs.mkdirSync(path.join(temp, 'src-tauri'))
  fs.writeFileSync(path.join(temp, 'src-tauri/tauri.conf.json'), JSON.stringify({ plugins: { updater: { pubkey: fs.readFileSync(path.join(temp, 'fixture.pub')).toString('base64') } } }))
  for (const file of files.filter(file => !file.endsWith('.dmg'))) {
    run('minisign', ['-Sm', path.join(temp, file), '-s', path.join(temp, 'fixture.key'), '-x', path.join(temp, 'raw.sig')])
    fs.writeFileSync(path.join(temp, `${file}.sig`), fs.readFileSync(path.join(temp, 'raw.sig')).toString('base64'))
  }
  verifySignatures(temp, temp, version, run)
  fs.appendFileSync(path.join(temp, files[0]), 'tampered')
  assert.throws(() => verifySignatures(temp, temp, version, run))
  const staged = path.join(temp, 'upload'), deployed = path.join(temp, 'live')
  fs.mkdirSync(path.join(staged, 'releases'), { recursive: true })
  fs.mkdirSync(path.join(staged, 'assets'))
  fs.mkdirSync(deployed)
  fs.writeFileSync(path.join(staged, 'releases/package.exe'), 'complete')
  fs.writeFileSync(path.join(deployed, 'latest.json'), 'old')
  for (const file of ['styles.css', 'app.js', 'index.html', 'release.json', 'latest.json']) fs.writeFileSync(path.join(staged, file), 'new')
  let corrupt = true
  const fakeRemote = (cmd, args) => {
    if (cmd === 'rsync') {
      const target = args.at(-1).slice('fixture:'.length)
      fs.cpSync(staged, target, { recursive: true })
      if (corrupt) fs.writeFileSync(path.join(target, 'releases/package.exe'), 'truncated')
    } else if (args[1] === 'mkdir') fs.mkdirSync(args.at(-1), { recursive: true })
    else {
      const encoded = args[1].match(/b64decode\('([^']+)'\)/)[1]
      run('python3', ['-c', Buffer.from(encoded, 'base64').toString()])
    }
  }
  const options = { directory: staged, deployPath: deployed, sshTarget: 'fixture', version, run: fakeRemote }
  assert.throws(() => deployAtomic(options))
  assert.equal(fs.readFileSync(path.join(deployed, 'latest.json'), 'utf8'), 'old', 'incomplete transfers cannot announce an update')
  corrupt = false
  deployAtomic(options)
  assert.equal(fs.readFileSync(path.join(deployed, 'latest.json'), 'utf8'), 'new')
  fs.writeFileSync(path.join(deployed, 'latest.json'), 'preserved')
  fs.writeFileSync(path.join(staged, 'releases/package.exe'), 'replacement')
  assert.throws(() => deployAtomic(options))
  assert.equal(fs.readFileSync(path.join(deployed, 'latest.json'), 'utf8'), 'preserved', 'published assets are immutable')
  console.log('PASS release provenance, hash checks, signature/tamper checks, atomic publication and immutable assets')
} finally { fs.rmSync(temp, { recursive: true, force: true }) }
