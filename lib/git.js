/**
 * Small git driver for the `github_push` tool.
 *
 * Everything here is deliberately explicit: the tool must work on a machine
 * where git is a portable install outside PATH, where a local TLS proxy
 * re-signs certificates, and where the credential lives in the Windows
 * credential manager rather than in a URL.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Where a portable or system git commonly lives on this platform. */
const GIT_HINTS = [
  'PortableGit\\cmd\\git.exe',
  'scoop\\shims\\git.exe',
]

/**
 * Resolve the git executable: an explicit path wins, then a few well-known
 * installs, then plain `git` from PATH.
 * @param {string | undefined} configured - explicit executable from config or env.
 * @returns {string} executable to spawn.
 */
export function findGit(configured) {
  const candidates = []
  if (typeof configured === 'string' && configured.length > 0) candidates.push(configured)
  if (typeof process.env.DSH_GIT_PATH === 'string' && process.env.DSH_GIT_PATH.length > 0) {
    candidates.push(process.env.DSH_GIT_PATH)
  }
  const home = process.env.USERPROFILE ?? os.homedir()
  for (const hint of GIT_HINTS) candidates.push(path.join(home, hint))
  candidates.push('C:\\Program Files\\Git\\cmd\\git.exe')
  candidates.push('C:\\Program Files (x86)\\Git\\cmd\\git.exe')
  for (const candidate of candidates) {
    if (candidate === 'git') return candidate
    if (existsSync(candidate)) return candidate
  }
  return 'git'
}

/**
 * Run one git command.
 * @param {string} git - git executable.
 * @param {string} dir - working directory (`git -C`).
 * @param {readonly string[]} args - arguments after `-C <dir>`.
 * @param {{ timeoutMs?: number, allowFailure?: boolean }} [options] - timeout and failure policy.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>} settled process result.
 */
export function runGit(git, dir, args, options = {}) {
  const timeout = options.timeoutMs ?? 180_000
  return new Promise((resolve, reject) => {
    execFile(git, ['-C', dir, ...args], {
      timeout,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : (typeof error.code === 'number' ? error.code : 1)
      const result = { code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
      if (error !== null && options.allowFailure !== true) {
        const detail = (result.stderr || result.stdout || error.message).trim()
        const failure = new Error(`git ${args.join(' ')} failed (${String(code)}): ${detail}`)
        failure.git = result
        reject(failure)
        return
      }
      resolve(result)
    })
  })
}

/**
 * Whether a directory is already a git work tree.
 * @param {string} git - git executable.
 * @param {string} dir - candidate directory.
 * @returns {Promise<boolean>} true when `.git` is resolvable.
 */
export async function isRepo(git, dir) {
  const result = await runGit(git, dir, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true })
  return result.code === 0 && result.stdout.trim() === 'true'
}

/**
 * Initialise a repository on `main`.
 * @param {string} git - git executable.
 * @param {string} dir - directory to initialise.
 */
export async function initRepo(git, dir) {
  await runGit(git, dir, ['init', '-b', 'main'])
}

/**
 * Current branch name, or `main` for an unborn HEAD.
 * @param {string} git - git executable.
 * @param {string} dir - repository directory.
 * @returns {Promise<string>} branch name.
 */
export async function currentBranch(git, dir) {
  const result = await runGit(git, dir, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true })
  const name = result.stdout.trim()
  return name.length > 0 ? name : 'main'
}

/**
 * Read one configured remote URL.
 * @param {string} git - git executable.
 * @param {string} dir - repository directory.
 * @param {string} remote - remote name.
 * @returns {Promise<string | undefined>} the URL, when configured.
 */
export async function remoteUrl(git, dir, remote) {
  const result = await runGit(git, dir, ['remote', 'get-url', remote], { allowFailure: true })
  const url = result.stdout.trim()
  return result.code === 0 && url.length > 0 ? url : undefined
}

/**
 * Add or replace a remote URL.
 * @param {string} git - git executable.
 * @param {string} dir - repository directory.
 * @param {string} remote - remote name.
 * @param {string} url - https or ssh URL.
 * @returns {Promise<'added' | 'updated'>} what changed.
 */
export async function setRemote(git, dir, remote, url) {
  const existing = await remoteUrl(git, dir, remote)
  if (existing === undefined) {
    await runGit(git, dir, ['remote', 'add', remote, url])
    return 'added'
  }
  if (existing !== url) {
    await runGit(git, dir, ['remote', 'set-url', remote, url])
    return 'updated'
  }
  return 'added'
}

/**
 * Stage every change.
 * @param {string} git - git executable.
 * @param {string} dir - repository directory.
 */
export async function stageAll(git, dir) {
  await runGit(git, dir, ['add', '-A'])
}

/**
 * Whether the index holds staged changes.
 * @param {string} git - git executable.
 * @param {string} dir - repository directory.
 * @returns {Promise<boolean>} true when a commit would record something.
 */
export async function hasStagedChanges(git, dir) {
  const result = await runGit(git, dir, ['diff', '--cached', '--quiet'], { allowFailure: true })
  return result.code === 1
}

/**
 * Commit the index.
 * @param {string} git - git executable.
 * @param {string} dir - repository directory.
 * @param {string} message - commit message.
 * @returns {Promise<string>} the new commit id.
 */
export async function commit(git, dir, message) {
  await runGit(git, dir, ['commit', '-m', message])
  const head = await runGit(git, dir, ['rev-parse', '--short', 'HEAD'])
  return head.stdout.trim()
}

/**
 * Push the branch, falling back to a looser TLS setting when the machine
 * terminates TLS locally (a proxy that re-signs certificates): the first
 * attempt uses the normal configuration, the second one switches to the
 * openssl backend without peer verification.
 * @param {string} git - git executable.
 * @param {string} dir - repository directory.
 * @param {{ remote: string, branch: string, tlsVerify: boolean }} request - push target.
 * @returns {Promise<{ tlsFallback: boolean }>} whether the fallback was needed.
 */
export async function push(git, dir, { remote, branch, tlsVerify }) {
  const target = `${remote}`
  const first = await runGit(git, dir, ['push', '-u', target, branch], { allowFailure: true })
  if (first.code === 0) return { tlsFallback: false }
  const detail = `${first.stderr}\n${first.stdout}`
  const tlsFailure = /certificate|SSL|TLS|schannel|SEC_E_|unable to verify|server certificate/i.test(detail)
  if (!tlsFailure || tlsVerify === true) {
    const error = new Error(detail.trim() || 'git push failed')
    error.git = first
    error.tls = tlsFailure
    throw error
  }
  const second = await runGit(git, dir, [
    '-c', 'http.sslBackend=openssl',
    '-c', 'http.sslVerify=false',
    'push', '-u', target, branch,
  ], { allowFailure: true })
  if (second.code !== 0) {
    const error = new Error((second.stderr || second.stdout || 'git push failed').trim())
    error.git = second
    error.tls = true
    throw error
  }
  return { tlsFallback: true }
}

/**
 * Turn a git remote URL into the browser URL of the repository.
 * @param {string | undefined} url - remote URL.
 * @returns {string} https URL, or an empty string when unknown.
 */
export function webUrlFromRemote(url) {
  if (typeof url !== 'string' || url.length === 0) return ''
  let value = url.trim().replace(/\.git$/, '')
  const ssh = /^git@([^:]+):(.+)$/.exec(value)
  if (ssh !== null) return `https://${ssh[1]}/${ssh[2]}`
  const sshUrl = /^ssh:\/\/git@([^/]+)\/(.+)$/.exec(value)
  if (sshUrl !== null) return `https://${sshUrl[1]}/${sshUrl[2]}`
  value = value.replace(/^git\+/, '')
  return value
}
