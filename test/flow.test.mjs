/**
 * End-to-end test for the `github_push` tool: `node test/flow.test.mjs`.
 * Uses a local bare repository as the remote, so no network or credential is
 * involved; it exercises init → commit → remote → push and the "tree clean"
 * path, plus URL normalisation.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { findGit, webUrlFromRemote } from '../lib/git.js'

const git = findGit()
try {
  execFileSync(git, ['--version'])
} catch (error) {
  // The DSH file sandbox denies piped child stdio (EPERM), so this test only
  // runs outside it. Inside a sandboxed shell it reports the skip and exits 0.
  console.log(`github_push flow test skipped: cannot spawn git here (${String(error.code ?? error)})`)
  process.exit(0)
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-github-push-'))
const work = path.join(root, 'work')
const bare = path.join(root, 'remote.git')
await fs.mkdir(work, { recursive: true })
execFileSync(git, ['init', '--bare', bare])

/** Capture the registered tool definition. */
let tool
const ctx = {
  tools: { register(definition) { tool = definition; return () => {} } },
  effect(fn) { fn() },
}
apply(ctx)

assert.equal(tool.name, 'github_push')
assert.equal(tool.parameters.type, 'object')
assert.deepEqual(tool.parameters.required, ['dir', 'message'])
assert.equal(tool.output.schema.additionalProperties, false)
assert.equal(typeof tool.execute, 'function')

await fs.writeFile(path.join(work, 'a.txt'), 'first\n')
const first = await tool.execute({ dir: work, message: 'first commit', repoUrl: bare })
assert.equal(first.ok, true)
assert.match(first.actions, /init/)
assert.match(first.actions, /commit [0-9a-f]{7,}/)
assert.match(first.actions, /push origin main/)
assert.equal(first.branch, 'main')
assert.ok(first.commit.length >= 7)

const remoteLog = execFileSync(git, ['--git-dir', bare, 'log', '--oneline', '-1']).toString()
assert.match(remoteLog, /first commit/)

// A clean tree must still succeed without inventing a commit.
const second = await tool.execute({ dir: work, message: 'no changes here', repoUrl: bare })
assert.equal(second.ok, true)
assert.equal(second.commit, '')
assert.match(second.note, /no staged changes/)

// A second commit lands on the same remote.
await fs.writeFile(path.join(work, 'a.txt'), 'second\n')
const third = await tool.execute({ dir: work, message: 'second commit', repoUrl: bare })
assert.equal(third.ok, true)
assert.notEqual(third.commit, first.commit)
const remoteCount = execFileSync(git, ['--git-dir', bare, 'rev-list', '--count', 'HEAD']).toString().trim()
assert.equal(remoteCount, '2')

assert.equal(webUrlFromRemote('https://github.com/o/r.git'), 'https://github.com/o/r')
assert.equal(webUrlFromRemote('git@github.com:o/r.git'), 'https://github.com/o/r')
assert.equal(webUrlFromRemote('git+https://github.com/o/r'), 'https://github.com/o/r')

// Unknown directory is a clear failure, not a silent no-op.
await assert.rejects(tool.execute({ dir: path.join(root, 'missing'), message: 'x' }), /directory not found/)

await fs.rm(root, { recursive: true, force: true })
console.log('github_push flow test passed')
