// `orca plugin test .` runs this in Node with the same runtime and checks that Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { AuthState, TaskDetail, TaskFilters } from './protocol'

const CONNECTED: AuthState = { connected: true, user: { id: 42, name: 'austin' }, secretsAvailable: true }
const TASK: TaskDetail = {
  id: 'abc123',
  customId: 'ENG-7',
  name: 'Fix login',
  status: 'to do',
  statusType: 'open',
  url: 'https://app.clickup.com/t/abc123',
  listName: 'Sprint 4',
  priority: 'high',
  dueDate: null,
  updatedAt: null,
  assignees: ['austin'],
  tags: ['bug'],
  description: 'Users see a 500.'
}
const OTHER = { ...TASK, id: 'def456', customId: 'ENG-8', name: 'Add dark mode' }

/** Finds a task by task ID or custom ID, as the worker does. */
function findTask(list: TaskDetail[], ref: string): TaskDetail {
  return list.find((task) => task.id === ref || task.customId === ref) ?? TASK
}

/** The task IDs in the list view group of a status. Empty when the group is not drawn. */
function rowsIn(view: Awaited<ReturnType<typeof mount>>, status: string): string[] {
  const target = { label: `Tasks with the status ${status}` }
  return view.find(target) ? view.rowsOf(target) : []
}

const OPTIONS = {
  spaces: [
    { id: 's1', name: 'Product' },
    { id: 's2', name: 'Ops' }
  ],
  statuses: [
    { name: 'to do', type: 'open' },
    { name: 'in review', type: 'custom' }
  ],
  tags: ['bug', 'ui']
}

function connectedHost(started: unknown[] = [], listed: TaskFilters[] = [], optionCalls: string[] = [], list: TaskDetail[] = [TASK, OTHER]) {
  return mockHost({
    requests: {
      'auth.status': () => CONNECTED,
      'teams.list': () => ({ teams: [{ id: '900', name: 'Presto' }] }),
      'filters.options': ({ spaceId }) => {
        optionCalls.push(spaceId)
        return spaceId === 's2' ? { ...OPTIONS, statuses: [{ name: 'blocked', type: 'custom' }], tags: [] } : OPTIONS
      },
      'tasks.list': ({ filters }) => {
        listed.push(filters)
        // As ClickUp does: send only the tasks with the filter status.
        const shown = (filters.priority === 'high' ? list.slice(0, 1) : list).map((task) =>
          filters.status === '' ? task : { ...task, status: filters.status }
        )
        return { tasks: shown, hasMore: false }
      },
      'repos.list': () => ({ repos: [{ id: 'r1', name: 'API' }] }),
      'task.get': ({ ref }) => ({ task: findTask(list, ref), worktrees: [] }),
      'worktree.start': (input) => {
        started.push(input)
        return { worktreeName: 'eng-7-fix-login', statusSet: 'in progress', warnings: [] }
      }
    }
  })
}

test('asks for a token when ClickUp is not connected', async () => {
  let token = ''
  const host = mockHost({
    requests: {
      'auth.status': () => ({ connected: false, user: null, secretsAvailable: true }),
      'auth.connect': (input) => {
        token = input.token
        return CONNECTED
      },
      'teams.list': () => ({ teams: [] }),
      'filters.options': () => ({ spaces: [], statuses: [], tags: [] }),
      'tasks.list': () => ({ tasks: [], hasMore: false }),
      'repos.list': () => ({ repos: [] })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Connect ClickUp' }))
  await view.type({ label: 'Personal API token' }, 'pk_123')
  await view.press({ text: 'Connect' })
  assert.equal(token, 'pk_123')
  assert.ok(view.find({ text: 'No open tasks' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('lists tasks, filters them and starts a worktree', async () => {
  const started: unknown[] = []
  const view = await mount(panel, { host: connectedHost(started) })
  assert.deepEqual(rowsIn(view, 'to do'), ['abc123', 'def456'])

  await view.type({ label: 'Filter tasks, or type a task ID and press Enter' }, 'dark')
  assert.deepEqual(rowsIn(view, 'to do'), ['def456'])

  await view.type({ label: 'Filter tasks, or type a task ID and press Enter' }, 'ENG-8', { replace: true, submit: true })
  assert.ok(view.find({ text: 'Start worktree' }))

  await view.select({ label: 'Repository' }, 'r1')
  await view.press({ text: 'Start worktree' })
  assert.deepEqual(started, [{ teamId: '900', taskId: 'def456', repoId: 'r1', agent: 'claude' }])
  assert.ok(view.find({ text: /created the worktree/ }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('shows a worker error in the panel', async () => {
  const host = mockHost({
    requests: {
      'auth.status': () => CONNECTED,
      'teams.list': () => {
        throw new Error('ClickUp limits the request rate. Try again in one minute.')
      },
      'filters.options': () => ({ spaces: [], statuses: [], tags: [] }),
      'tasks.list': () => ({ tasks: [], hasMore: false }),
      'repos.list': () => ({ repos: [] })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: /limits the request rate/ }))
  await view.unmount()
})

test('filters send the values to the worker and a new space clears the status and the tag', async () => {
  const listed: TaskFilters[] = []
  const optionCalls: string[] = []
  const view = await mount(panel, { host: connectedHost([], listed, optionCalls) })
  assert.deepEqual(optionCalls, [''])
  assert.equal(listed.at(-1)?.spaceId, '')
  assert.equal(view.find({ label: 'Status' }), null)

  await view.toggle({ label: 'Filters' })
  await view.select({ label: 'Status' }, 'in review')
  await view.select({ label: 'Tag' }, 'bug')
  await view.select({ label: 'Priority' }, 'high')
  assert.deepEqual(listed.at(-1), { spaceId: '', status: 'in review', priority: 'high', tag: 'bug', includeClosed: false, orderBy: 'updated' })
  assert.deepEqual(rowsIn(view, 'in review'), ['abc123'])
  assert.deepEqual(rowsIn(view, 'to do'), [])

  await view.select({ label: 'Space' }, 's2')
  assert.deepEqual(optionCalls, ['', 's2'])
  assert.deepEqual(listed.at(-1), { spaceId: 's2', status: '', priority: 'high', tag: '', includeClosed: false, orderBy: 'updated' })

  await view.select({ label: 'Sort by' }, 'due_date')
  await view.toggle({ label: 'Include closed tasks' })
  assert.equal(listed.at(-1)?.orderBy, 'due_date')
  assert.equal(listed.at(-1)?.includeClosed, true)
  assert.deepEqual(view.persisted.plugin.filters, listed.at(-1))

  await view.press({ text: 'Clear filters' })
  assert.deepEqual(listed.at(-1), { spaceId: '', status: '', priority: '', tag: '', includeClosed: false, orderBy: 'updated' })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('a stored filter value that is not valid now is removed', async () => {
  const listed: TaskFilters[] = []
  const view = await mount(panel, {
    host: connectedHost([], listed),
    persisted: { plugin: { filters: { spaceId: 'gone', status: 'old', priority: 'low', tag: 'x', includeClosed: false, orderBy: 'created' } } }
  })
  assert.deepEqual(listed, [{ spaceId: '', status: '', priority: 'low', tag: '', includeClosed: false, orderBy: 'created' }])
  await view.unmount()
})

test('the sort select offers priority in both directions', async () => {
  const listed: TaskFilters[] = []
  const view = await mount(panel, { host: connectedHost([], listed) })
  await view.toggle({ label: 'Filters' })
  await view.select({ label: 'Sort by' }, 'priority_desc')
  assert.equal(listed.at(-1)?.orderBy, 'priority_desc')
  await view.select({ label: 'Sort by' }, 'priority_asc')
  assert.equal(listed.at(-1)?.orderBy, 'priority_asc')
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('the list view groups tasks by status and a row opens the task', async () => {
  const review = { ...OTHER, status: 'in review', statusType: 'custom' }
  const view = await mount(panel, { host: connectedHost([], [], [], [TASK, review]) })
  assert.deepEqual(rowsIn(view, 'to do'), ['abc123'])
  assert.deepEqual(rowsIn(view, 'in review'), ['def456'])
  await view.selectRows({ label: 'Tasks with the status in review' }, ['def456'])
  assert.ok(view.find({ text: 'Start worktree' }))
  assert.ok(view.find({ text: 'Add dark mode' }))
  await view.unmount()
})

test('the board shows a column for each status and moves a card', async () => {
  const moves: unknown[] = []
  let fail = false
  const host = mockHost({
    requests: {
      'auth.status': () => CONNECTED,
      'teams.list': () => ({ teams: [{ id: '900', name: 'Presto' }] }),
      'filters.options': () => ({ ...OPTIONS, statuses: [...OPTIONS.statuses, { name: 'complete', type: 'closed' }] }),
      'tasks.list': () => ({ tasks: [TASK, OTHER], hasMore: false }),
      'repos.list': () => ({ repos: [] }),
      'task.get': ({ ref }) => ({ task: findTask([TASK, OTHER], ref), worktrees: [] }),
      'task.setStatus': (input) => {
        moves.push(input)
        if (fail) throw new Error('ClickUp returned an error: Status not found')
        return { task: { ...TASK, status: input.status, statusType: 'custom' } }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Board' })
  assert.equal(view.persisted.plugin.viewMode, 'board')
  // The empty "in review" column shows. The empty closed column does not show.
  assert.ok(view.find({ text: 'IN REVIEW' }))
  assert.equal(view.find({ text: 'COMPLETE' }), null)

  await view.select({ label: 'Move ENG-7 to' }, 'in review')
  assert.deepEqual(moves, [{ taskId: 'abc123', status: 'in review' }])
  assert.equal(view.valueOf({ label: 'Move ENG-7 to' }), 'in review')

  fail = true
  await view.select({ label: 'Move ENG-8 to' }, 'in review')
  assert.ok(view.find({ text: /Status not found/ }))
  // ClickUp refused the change, so the card goes back to its status.
  assert.equal(view.valueOf({ label: 'Move ENG-8 to' }), 'to do')

  await view.press({ text: 'Add dark mode' })
  assert.ok(view.find({ text: 'Start worktree' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('a large board stays under the render limit', async () => {
  const statuses = Array.from({ length: 15 }, (_, i) => ({ name: `step ${i}`, type: 'custom' }))
  const many = Array.from({ length: 600 }, (_, i) => ({
    ...TASK,
    id: `t${i}`,
    customId: `ENG-${i}`,
    name: `Task ${i}`,
    status: `step ${i % 15}`,
    tags: ['bug', 'ui']
  }))
  const host = mockHost({
    requests: {
      'auth.status': () => CONNECTED,
      'teams.list': () => ({ teams: [{ id: '900', name: 'Presto' }] }),
      'filters.options': () => ({ spaces: [], statuses, tags: [] }),
      'tasks.list': () => ({ tasks: many, hasMore: false }),
      'repos.list': () => ({ repos: [] })
    },
  })
  const view = await mount(panel, { host, persisted: { plugin: { viewMode: 'board' } } })
  assert.deepEqual(view.errors, [])
  assert.ok(view.find({ text: 'STEP 14' }))
  assert.ok(view.find({ text: /20 more tasks/ }))
  await view.unmount()
})
