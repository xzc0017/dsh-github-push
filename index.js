/**
 * Host half of dsh-github-push: one tool that stages, commits and pushes a
 * workspace directory to GitHub using the git binary and the credential that
 * already exist on this machine.
 *
 * Why a tool and not a service: the caller is the agent itself ("push this for
 * me"), and the tool registry is the model-facing entry point. The operation is
 * plain git, so the tool stays a thin, inspectable driver over `lib/git.js`.
 */
import { existsSync } from 'node:fs'
import {
  commit, currentBranch, findGit, hasStagedChanges, initRepo, isRepo, push,
  remoteUrl, setRemote, stageAll, webUrlFromRemote,
} from './lib/git.js'

export const inject = ['tools']

/** Model-facing parameters: a directory, a message, and optional remote overrides. */
const PARAMETERS = {
  type: 'object',
  properties: {
    dir: {
      type: 'string',
      description: 'Absolute path of the repository working tree to publish. A directory without .git is initialised on branch main.',
    },
    message: {
      type: 'string',
      description: 'Commit message. Used only when the staged tree differs from HEAD.',
    },
    remote: {
      type: 'string',
      description: 'Git remote name. Defaults to "origin".',
    },
    branch: {
      type: 'string',
      description: 'Branch to push. Defaults to the current branch (main for a fresh repository).',
    },
    repoUrl: {
      type: 'string',
      description: 'HTTPS remote URL to add or replace, for example https://github.com/owner/name.git. Omit when the remote already exists.',
    },
    tlsVerify: {
      type: 'boolean',
      description: 'Keep TLS verification on the first attempt only. Default false, which allows one retry without peer verification when a local proxy re-signs certificates.',
    },
  },
  required: ['dir', 'message'],
  additionalProperties: false,
}

/** Canonical result: what changed, what was pushed, and where to look at it. */
const OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'Whether the repository was pushed.' },
    commit: { type: 'string', description: 'Short id of the commit that was pushed, or empty when nothing was committed.' },
    branch: { type: 'string', description: 'Branch that was pushed.' },
    url: { type: 'string', description: 'Browser URL of the repository, when the remote is a GitHub URL.' },
    actions: { type: 'string', description: 'What the tool did, in order.' },
    note: { type: 'string', description: 'Caveats, such as an empty commit or a TLS fallback.' },
  },
  required: ['ok', 'commit', 'branch', 'url', 'actions', 'note'],
  additionalProperties: false,
}

/**
 * Publish one directory: initialise, stage, commit, ensure the remote, push.
 * @param {{ dir: string, message: string, remote?: string, branch?: string, repoUrl?: string, tlsVerify?: boolean }} args - tool arguments.
 * @returns {Promise<Record<string, unknown>>} canonical result matching OUTPUT.
 */
async function publish(args) {
  const dir = args.dir
  if (!existsSync(dir)) throw new Error(`directory not found: ${dir}`)
  const git = findGit()
  const actions = []
  const notes = []

  if (!(await isRepo(git, dir))) {
    await initRepo(git, dir)
    actions.push('init')
  }

  await stageAll(git, dir)
  let sha = ''
  if (await hasStagedChanges(git, dir)) {
    sha = await commit(git, dir, args.message)
    actions.push(`commit ${sha}`)
  } else {
    actions.push('commit skipped (tree clean)')
    notes.push('working tree had no staged changes')
  }

  const branch = args.branch !== undefined && args.branch.length > 0 ? args.branch : await currentBranch(git, dir)
  const remote = args.remote !== undefined && args.remote.length > 0 ? args.remote : 'origin'

  if (args.repoUrl !== undefined && args.repoUrl.length > 0) {
    const change = await setRemote(git, dir, remote, args.repoUrl)
    actions.push(`remote ${remote} ${change}`)
  }
  const url = await remoteUrl(git, dir, remote)
  if (url === undefined) {
    throw new Error(`no "${remote}" remote configured; pass repoUrl (for example https://github.com/owner/name.git)`)
  }

  const pushed = await push(git, dir, { remote, branch, tlsVerify: args.tlsVerify === true })
  actions.push(`push ${remote} ${branch}`)
  if (pushed.tlsFallback) {
    notes.push('local TLS interception: pushed with peer verification disabled (openssl backend)')
  }

  return {
    ok: true,
    commit: sha,
    branch,
    url: webUrlFromRemote(url),
    actions: actions.join(' → '),
    note: notes.join('; '),
  }
}

/**
 * Install the tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const definition = {
    name: 'github_push',
    description: [
      'Stage every change in a workspace directory, commit it, and push it to GitHub.',
      'Use it when the user asks to publish, back up, or update a repository.',
      'It initialises the repository on branch main when the directory is not one yet, and reuses the git credential already stored on this machine',
      '(Windows credential manager or ssh-agent), so no token is passed through the conversation.',
      'When a local proxy re-signs TLS certificates, it retries once with the openssl backend and peer verification disabled and says so in the result.',
    ].join(' '),
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT,
      render(_args, value) {
        const lines = [`github_push: ${String(value.actions)}`]
        if (value.url.length > 0) lines.push(`repo: ${value.url}`)
        if (value.note.length > 0) lines.push(`note: ${value.note}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 300_000,
    async execute(args) {
      return publish(args)
    },
  }
  ctx.effect(() => ctx.tools.register(definition))
}
