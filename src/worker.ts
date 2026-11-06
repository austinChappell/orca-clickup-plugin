// The plugin worker. It keeps the ClickUp token, calls the ClickUp API and runs the Orca CLI.
// A save restarts the worker and removes its memory, so all state is in storage or secrets.
import type { OrcaWorkerApi } from 'orca/worker'
import {
  ClickUpClient,
  DEFAULT_PROMPT_TEMPLATE,
  PluginError,
  mentionsTask,
  parseTaskRef,
  renderPrompt,
  taskKey,
  worktreeName,
  type FetchLike
} from './clickup'
import { resolveOrcaCli, runOrca, type RunOrca } from './orca-cli'
import { NO_FILTERS, type AuthState, type ClickUpUser, type LinkedWorktree, type Repo, type StatusOption, type TaskDetail } from './protocol'

const TOKEN = 'token'
const USER = 'user'
/** The most spaces to read tags from when no space is selected. Each space costs one ClickUp request. */
const MAX_TAG_SPACES = 20
const STATUS_TYPE_ORDER = ['open', 'custom', 'done', 'closed']

/** Removes statuses with the same name (case is not important) and sorts them by type. */
export function mergeStatuses(statuses: StatusOption[]): StatusOption[] {
  const byName = new Map<string, StatusOption>()
  for (const status of statuses) {
    const key = status.name.toLowerCase()
    if (!byName.has(key)) byName.set(key, status)
  }
  const rank = (status: StatusOption) => {
    const index = STATUS_TYPE_ORDER.indexOf(status.type ?? '')
    return index === -1 ? 1 : index
  }
  return [...byName.values()].sort((a, b) => rank(a) - rank(b))
}

/** Replaceable dependencies. The tests replace them. */
export const deps: { fetch: FetchLike; runOrca: RunOrca } = {
  fetch: (url, init) => globalThis.fetch(url, init),
  runOrca
}

export default function activate(orca: OrcaWorkerApi): void {
  async function secretsAvailable(): Promise<boolean> {
    try {
      const { status } = await orca.host.call('secrets.protection')
      return status === 'os-keyring'
    } catch {
      return true
    }
  }

  async function authState(): Promise<AuthState> {
    const token = await orca.secrets.get(TOKEN)
    const user = (await orca.storage.get(USER)) as ClickUpUser | null
    return { connected: Boolean(token), user: token ? user : null, secretsAvailable: await secretsAvailable() }
  }

  async function client(): Promise<ClickUpClient> {
    const token = await orca.secrets.get(TOKEN)
    if (!token) throw new PluginError('not_connected', 'No ClickUp token is stored. Connect ClickUp in the panel.')
    return new ClickUpClient(token, deps.fetch)
  }

  async function currentUser(api: ClickUpClient): Promise<ClickUpUser> {
    const stored = (await orca.storage.get(USER)) as ClickUpUser | null
    if (stored) return stored
    const user = await api.user()
    await orca.storage.set(USER, user as never)
    return user
  }

  async function setting(key: string): Promise<unknown> {
    return orca.settings.get(key)
  }

  async function linkedWorktrees(task: TaskDetail): Promise<LinkedWorktree[]> {
    try {
      const { workspaces } = await orca.host.call('workspace.list')
      return workspaces
        .filter((ws) => ws.kind === 'worktree' && (mentionsTask(ws.branch, task) || mentionsTask(ws.name, task)))
        .map((ws) => ({ id: ws.id, name: ws.name, branch: ws.branch }))
    } catch (error) {
      orca.log(`workspace.list failed: ${(error as Error).message}`)
      return []
    }
  }

  orca.panels.handle('auth.status', () => authState())

  orca.panels.handle('auth.connect', async ({ token }) => {
    const value = token.trim()
    if (value === '') throw new PluginError('invalid_token', 'Type a ClickUp personal API token.')
    // Check the token before it is stored.
    const user = await new ClickUpClient(value, deps.fetch).user()
    await orca.secrets.set(TOKEN, value)
    await orca.storage.set(USER, user as never)
    const state = await authState()
    orca.panels.post('auth.changed', state)
    return state
  })

  orca.panels.handle('auth.disconnect', async () => {
    await orca.secrets.delete(TOKEN)
    await orca.storage.delete(USER)
    const state = await authState()
    orca.panels.post('auth.changed', state)
    return state
  })

  orca.panels.handle('teams.list', async () => ({ teams: await (await client()).teams() }))

  orca.panels.handle('filters.options', async ({ teamId, spaceId }) => {
    const api = await client()
    const spaces = await api.spaces(teamId)
    const chosen = spaceId === '' ? spaces : spaces.filter((space) => space.id === spaceId)
    const tagLists = await Promise.all(
      chosen.slice(0, MAX_TAG_SPACES).map((space) =>
        api.tags(space.id).catch((error: Error) => {
          orca.log(`Cannot read the tags of space ${space.id}: ${error.message}`)
          return [] as string[]
        })
      )
    )
    const tags = [...new Set(tagLists.flat())].sort((a, b) => a.localeCompare(b))
    return {
      spaces: spaces.map(({ id, name }) => ({ id, name })),
      statuses: mergeStatuses(chosen.flatMap((space) => space.statuses)),
      tags
    }
  })

  orca.panels.handle('tasks.list', async ({ teamId, scope, page, filters }) => {
    const api = await client()
    const assignee = scope === 'mine' ? (await currentUser(api)).id : null
    return api.tasks(teamId, page, assignee, { ...NO_FILTERS, ...filters })
  })

  orca.panels.handle('task.get', async ({ teamId, ref }) => {
    const parsed = parseTaskRef(ref)
    if (!parsed) throw new PluginError('invalid_task_ref', `"${ref}" is not a ClickUp task ID or task URL.`)
    const task = await (await client()).task(teamId, parsed)
    return { task, worktrees: await linkedWorktrees(task) }
  })

  orca.panels.handle('task.setStatus', async ({ taskId, status }) => {
    if (status.trim() === '') throw new PluginError('invalid_status', 'Select a status.')
    const { description: _description, ...task } = await (await client()).setStatus(taskId, status)
    return { task }
  })

  orca.panels.handle('repos.list', async () => {
    const result = (await deps.runOrca(resolveOrcaCli(await setting('orcaCliPath')), ['repo', 'list'])) as {
      repos?: { id: string; displayName?: string; path?: string; kind?: string }[]
    }
    const repos: Repo[] = (result.repos ?? [])
      .filter((repo) => repo.kind === undefined || repo.kind === 'git')
      .map((repo) => ({ id: repo.id, name: repo.displayName ?? repo.path ?? repo.id }))
    return { repos }
  })

  orca.panels.handle('worktree.start', async ({ teamId, taskId, repoId, agent }) => {
    if (repoId === '') throw new PluginError('no_repo', 'Select a repository first.')
    const api = await client()
    const task = await api.task(teamId, { id: taskId, custom: false })
    const name = worktreeName(task)
    const args = [
      'worktree',
      'create',
      '--repo',
      `id:${repoId}`,
      '--name',
      name,
      '--no-parent',
      '--comment',
      `ClickUp ${taskKey(task)}: ${task.name} (${task.url})`,
      '--activate'
    ]
    if (agent !== '' && agent !== 'none') {
      const template = await setting('promptTemplate')
      const prompt = renderPrompt(typeof template === 'string' && template.trim() !== '' ? template : DEFAULT_PROMPT_TEMPLATE, task)
      args.push('--agent', agent, '--prompt', prompt)
    }
    await deps.runOrca(resolveOrcaCli(await setting('orcaCliPath')), args)

    const warnings: string[] = []
    let statusSet: string | null = null
    const startStatus = await setting('startStatus')
    if (typeof startStatus === 'string' && startStatus.trim() !== '' && startStatus.trim().toLowerCase() !== task.status.toLowerCase()) {
      try {
        await api.setStatus(task.id, startStatus.trim())
        statusSet = startStatus.trim()
      } catch (error) {
        warnings.push(`The worktree is ready, but the task status did not change: ${(error as Error).message}`)
      }
    }
    return { worktreeName: name, statusSet, warnings }
  })

  orca.panels.handle('worktree.open', async ({ workspaceId }) => {
    await orca.host.call('workspace.open', { workspaceId })
    return { opened: true }
  })
}
