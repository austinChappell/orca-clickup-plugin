// Runs activate(orca) from src/worker.ts over a mock host, with fake ClickUp and Orca CLI calls.
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import type { FetchLike } from './clickup'
import { NO_FILTERS } from './protocol'
import * as main from './worker'

const realDeps = { ...main.deps }
afterEach(() => Object.assign(main.deps, realDeps))

const TASK = {
  id: 'abc123',
  custom_id: 'ENG-7',
  name: 'Fix login',
  url: 'https://app.clickup.com/t/abc123',
  status: { status: 'to do', type: 'open' },
  list: { name: 'Sprint 4' },
  assignees: [{ username: 'austin' }],
  markdown_description: 'Users see a 500.',
  priority: { priority: 'high' },
  tags: [{ name: 'bug' }]
}
const LOW_TASK = { ...TASK, id: 'def456', custom_id: 'ENG-8', name: 'Tidy logs', priority: { priority: 'low' }, tags: [] }

interface Sent {
  url: string
  method: string
  auth: string | undefined
  body: unknown
}

function fakeClickUp(sent: Sent[], token = 'pk_good'): FetchLike {
  return async (url, init) => {
    sent.push({
      url,
      method: init?.method ?? 'GET',
      auth: init?.headers?.Authorization,
      body: init?.body ? JSON.parse(init.body) : undefined
    })
    const reply = (status: number, body: unknown) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body)
    })
    if (init?.headers?.Authorization !== token) return reply(401, { err: 'Token invalid' })
    const path = url.replace('https://api.clickup.com/api/v2', '')
    if (path === '/user') return reply(200, { user: { id: 42, username: 'austin' } })
    if (path === '/team') return reply(200, { teams: [{ id: '900', name: 'Presto' }] })
    if (path.startsWith('/team/900/task')) return reply(200, { tasks: [TASK, LOW_TASK], last_page: true })
    if (path.startsWith('/team/900/space'))
      return reply(200, {
        spaces: [
          { id: 's1', name: 'Product', statuses: [{ status: 'complete', type: 'closed' }, { status: 'to do', type: 'open' }, { status: 'in review', type: 'custom' }] },
          { id: 's2', name: 'Ops', statuses: [{ status: 'To Do', type: 'open' }, { status: 'blocked', type: 'custom' }] }
        ]
      })
    if (path === '/space/s1/tag') return reply(200, { tags: [{ name: 'ui' }, { name: 'bug' }] })
    if (path === '/space/s2/tag') return reply(500, { err: 'boom' })
    if (path.startsWith('/task/')) return reply(200, TASK)
    return reply(404, { err: 'Not found' })
  }
}

const connectedHost = (settings: Record<string, string> = {}) =>
  mockHost({
    secrets: { token: 'pk_good' },
    storage: { user: { id: 42, name: 'austin' } },
    settings,
    results: {
      'secrets.protection': { status: 'os-keyring' },
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'worktree', name: 'eng-7-fix-login', path: '/tmp/w1', branch: 'austin/eng-7-fix-login', hostId: null },
          { id: 'w2', kind: 'worktree', name: 'eng-70', path: '/tmp/w2', branch: 'eng-70', hostId: null }
        ],
        truncated: false
      }
    }
  })

test('connect checks the token, stores it and tells the panels', async () => {
  const sent: Sent[] = []
  main.deps.fetch = fakeClickUp(sent)
  const host = mockHost({ results: { 'secrets.protection': { status: 'os-keyring' } } })
  const worker = await mountWorker(main, { host })

  await assert.rejects(worker.request('auth.connect', { token: 'pk_bad' }), /refused the token/)
  assert.equal(host.data().secrets.token, undefined)

  const state = await worker.request('auth.connect', { token: ' pk_good ' })
  assert.deepEqual(state, { connected: true, user: { id: 42, name: 'austin' }, secretsAvailable: true })
  assert.equal(host.data().secrets.token, 'pk_good')
  assert.deepEqual(worker.posts.at(-1), { event: 'auth.changed', payload: state })

  const after = await worker.request('auth.disconnect')
  assert.equal(after.connected, false)
  assert.equal(host.data().secrets.token, undefined)
  assert.deepEqual(worker.refusals, [])
})

test('lists my tasks with the assignee filter', async () => {
  const sent: Sent[] = []
  main.deps.fetch = fakeClickUp(sent)
  const worker = await mountWorker(main, { host: connectedHost() })
  const answer = await worker.request('tasks.list', { teamId: '900', scope: 'mine', page: 0, filters: NO_FILTERS })
  assert.equal(answer.hasMore, false)
  assert.equal(answer.tasks.length, 2)
  assert.equal(answer.tasks[0].customId, 'ENG-7')
  assert.equal(answer.tasks[0].listName, 'Sprint 4')
  assert.ok(sent[0].url.includes('assignees%5B%5D=42'))
  assert.equal(sent[0].auth, 'pk_good')
})

test('task.get reads a custom ID and finds the matching worktree only', async () => {
  const sent: Sent[] = []
  main.deps.fetch = fakeClickUp(sent)
  const worker = await mountWorker(main, { host: connectedHost() })
  const answer = await worker.request('task.get', { teamId: '900', ref: 'eng-7' })
  assert.ok(sent[0].url.includes('/task/ENG-7?'))
  assert.ok(sent[0].url.includes('custom_task_ids=true'))
  assert.ok(sent[0].url.includes('team_id=900'))
  assert.equal(answer.task.description, 'Users see a 500.')
  assert.deepEqual(answer.worktrees.map((wt) => wt.id), ['w1'])
  await assert.rejects(worker.request('task.get', { teamId: '900', ref: 'hello' }), /not a ClickUp task ID/)
})

test('worktree.start runs the Orca CLI and sets the start status', async () => {
  const sent: Sent[] = []
  const runs: { cli: string; args: string[] }[] = []
  main.deps.fetch = fakeClickUp(sent)
  main.deps.runOrca = async (cli, args) => {
    runs.push({ cli, args })
    return { worktree: { id: 'new' } }
  }
  const worker = await mountWorker(main, {
    host: connectedHost({ startStatus: 'in progress', orcaCliPath: '/opt/orca', promptTemplate: 'Do {id}: {description}' })
  })
  const result = await worker.request('worktree.start', { teamId: '900', taskId: 'abc123', repoId: 'r1', agent: 'claude' })
  assert.deepEqual(result, { worktreeName: 'eng-7-fix-login', statusSet: 'in progress', warnings: [] })

  assert.equal(runs[0].cli, '/opt/orca')
  const args = runs[0].args
  assert.deepEqual(args.slice(0, 6), ['worktree', 'create', '--repo', 'id:r1', '--name', 'eng-7-fix-login'])
  assert.equal(args[args.indexOf('--agent') + 1], 'claude')
  assert.equal(args[args.indexOf('--prompt') + 1], 'Do ENG-7: Users see a 500.')

  const put = sent.find((call) => call.method === 'PUT')
  assert.deepEqual(put?.body, { status: 'in progress' })
})

test('worktree.start without an agent and without a start status', async () => {
  const sent: Sent[] = []
  const runs: string[][] = []
  main.deps.fetch = fakeClickUp(sent)
  main.deps.runOrca = async (_cli, args) => {
    runs.push(args)
    return {}
  }
  const worker = await mountWorker(main, { host: connectedHost() })
  const result = await worker.request('worktree.start', { teamId: '900', taskId: 'abc123', repoId: 'r1', agent: 'none' })
  assert.equal(result.statusSet, null)
  assert.equal(runs[0].includes('--agent'), false)
  assert.equal(sent.some((call) => call.method === 'PUT'), false)
  await assert.rejects(worker.request('worktree.start', { teamId: '900', taskId: 'abc123', repoId: '', agent: 'none' }), /Select a repository/)
})

test('requests fail with a clear message when no token is stored', async () => {
  const worker = await mountWorker(main, { host: mockHost() })
  await assert.rejects(worker.request('teams.list'), /No ClickUp token is stored/)
})

test('tasks.list sends the filters and removes tasks with another priority', async () => {
  const sent: Sent[] = []
  main.deps.fetch = fakeClickUp(sent)
  const worker = await mountWorker(main, { host: connectedHost() })
  const answer = await worker.request('tasks.list', {
    teamId: '900',
    scope: 'all',
    page: 0,
    filters: { ...NO_FILTERS, spaceId: 's1', tag: 'bug', priority: 'high' }
  })
  assert.deepEqual(answer.tasks.map((task) => task.customId), ['ENG-7'])
  assert.ok(sent[0].url.includes('space_ids%5B%5D=s1'))
  assert.ok(sent[0].url.includes('tags%5B%5D=bug'))
  assert.equal(sent[0].url.includes('assignees'), false)
})

test('filters.options merges statuses and tags of all spaces', async () => {
  const sent: Sent[] = []
  main.deps.fetch = fakeClickUp(sent)
  const worker = await mountWorker(main, { host: connectedHost() })
  const all = await worker.request('filters.options', { teamId: '900', spaceId: '' })
  assert.deepEqual(all.spaces, [{ id: 's1', name: 'Product' }, { id: 's2', name: 'Ops' }])
  assert.deepEqual(all.statuses.map((status) => status.name), ['to do', 'in review', 'blocked', 'complete'])
  // The tags of space s2 fail. The other tags still show.
  assert.deepEqual(all.tags, ['bug', 'ui'])
  assert.ok(worker.logs.some((line) => line.includes('space s2')))

  const one = await worker.request('filters.options', { teamId: '900', spaceId: 's2' })
  assert.deepEqual(one.statuses.map((status) => status.name), ['To Do', 'blocked'])
  assert.deepEqual(one.tags, [])
})

test('task.setStatus sends the status and returns the task without the description', async () => {
  const sent: Sent[] = []
  main.deps.fetch = fakeClickUp(sent)
  const worker = await mountWorker(main, { host: connectedHost() })
  const answer = await worker.request('task.setStatus', { taskId: 'abc123', status: 'in review' })
  assert.deepEqual(sent.map((call) => [call.method, call.body]), [['PUT', { status: 'in review' }]])
  assert.equal(answer.task.id, 'abc123')
  assert.equal('description' in answer.task, false)
  await assert.rejects(worker.request('task.setStatus', { taskId: 'abc123', status: ' ' }), /Select a status/)
})
