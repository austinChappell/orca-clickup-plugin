import { assert, test } from 'orca/testing'
import { ClickUpClient, MAX_PRIORITY_SORT_PAGES, matchesPriority, sortByPriority, mentionsTask, parseTaskRef, renderPrompt, taskQuery, toTaskDetail, toTaskSummary, worktreeName } from './clickup'
import { groupByStatus, replaceTask } from './grouping'
import { cardsPerColumn } from './views'
import { NO_FILTERS } from './protocol'

test('parseTaskRef reads custom IDs, task IDs and URLs', () => {
  assert.deepEqual(parseTaskRef('ENG-11684'), { id: 'ENG-11684', custom: true })
  assert.deepEqual(parseTaskRef(' eng-12 '), { id: 'ENG-12', custom: true })
  assert.deepEqual(parseTaskRef('#86b0x1y2z'), { id: '86b0x1y2z', custom: false })
  assert.deepEqual(parseTaskRef('https://app.clickup.com/t/86b0x1y2z'), { id: '86b0x1y2z', custom: false })
  assert.deepEqual(parseTaskRef('https://app.clickup.com/t/9011223344/ENG-5'), { id: 'ENG-5', custom: true })
  assert.equal(parseTaskRef('login'), null)
  assert.equal(parseTaskRef('fix the bug'), null)
  assert.equal(parseTaskRef(''), null)
})

test('worktreeName uses the task key and a short slug', () => {
  assert.equal(worktreeName({ id: 'abc123', customId: 'ENG-7', name: 'Fix the Login redirect!' }), 'eng-7-fix-the-login-redirect')
  assert.equal(worktreeName({ id: '86b0x1y2z', customId: null, name: 'Café' }), '86b0x1y2z-cafe')
  assert.ok(worktreeName({ id: 'a1b2c3', customId: null, name: 'x'.repeat(200) }).length <= 50)
})

test('mentionsTask matches the key as a separate token only', () => {
  const task = { id: 'abc123', customId: 'ENG-7' }
  assert.equal(mentionsTask('austin/eng-7-fix-login', task), true)
  assert.equal(mentionsTask('ENG-7', task), true)
  assert.equal(mentionsTask('eng-70-other', task), false)
  assert.equal(mentionsTask(null, task), false)
})

test('renderPrompt fills placeholders and keeps $ signs', () => {
  const task = toTaskDetail({
    id: 'abc123',
    custom_id: 'ENG-7',
    name: 'Cost is $5',
    url: 'https://app.clickup.com/t/abc123',
    status: { status: 'to do', type: 'open' },
    markdown_description: 'Steps: $& and {name}'
  })
  assert.equal(renderPrompt('{id} {name} {url} {description}', task), 'ENG-7 Cost is $5 https://app.clickup.com/t/abc123 Steps: $& and {name}')
})

test('taskQuery sends the filters that ClickUp supports', () => {
  const plain = taskQuery(2, 42, NO_FILTERS)
  assert.equal(plain.get('page'), '2')
  assert.equal(plain.get('order_by'), 'updated')
  assert.equal(plain.get('include_closed'), 'false')
  assert.deepEqual(plain.getAll('assignees[]'), ['42'])
  assert.equal(plain.has('space_ids[]'), false)
  assert.equal(plain.has('reverse'), false)

  const filtered = taskQuery(0, null, { spaceId: 's1', status: 'in review', priority: 'high', tag: 'bug', includeClosed: false, orderBy: 'due_date' })
  assert.deepEqual(filtered.getAll('space_ids[]'), ['s1'])
  assert.deepEqual(filtered.getAll('statuses[]'), ['in review'])
  assert.deepEqual(filtered.getAll('tags[]'), ['bug'])
  assert.equal(filtered.has('assignees[]'), false)
  assert.equal(filtered.has('priority'), false)
  // A status filter can name a closed status.
  assert.equal(filtered.get('include_closed'), 'true')
  assert.equal(filtered.get('reverse'), 'true')
})

test('matchesPriority and tag mapping', () => {
  const urgent = toTaskSummary({ id: 'a1', priority: { priority: 'urgent' }, tags: [{ name: 'bug' }, { name: 'ui' }] })
  const none = toTaskSummary({ id: 'a2', priority: null })
  assert.deepEqual(urgent.tags, ['bug', 'ui'])
  assert.equal(matchesPriority(urgent, ''), true)
  assert.equal(matchesPriority(urgent, 'urgent'), true)
  assert.equal(matchesPriority(urgent, 'high'), false)
  assert.equal(matchesPriority(none, 'none'), true)
  assert.equal(matchesPriority(urgent, 'none'), false)
})

test('sortByPriority puts tasks without a priority last in both directions', () => {
  const tasks = ['low', null, 'urgent', 'normal', 'high', null, 'HIGH'].map((priority, index) => ({ id: String(index), priority }))
  assert.deepEqual(sortByPriority(tasks, 'desc').map((t) => t.id), ['2', '4', '6', '3', '0', '1', '5'])
  assert.deepEqual(sortByPriority(tasks, 'asc').map((t) => t.id), ['0', '3', '4', '6', '2', '1', '5'])
})

test('a priority sort reads the pages, sorts them and stops at the page limit', async () => {
  const pagesRead: string[] = []
  const pageOf = (page: number) =>
    Array.from({ length: 100 }, (_, i) => ({ id: `p${page}t${i}`, priority: i === 0 && page === 2 ? { priority: 'urgent' } : null }))
  const fetchPages = (lastPage: number) => async (url: string) => {
    const page = Number(new URL(url).searchParams.get('page'))
    pagesRead.push(new URL(url).searchParams.get('order_by') ?? '')
    const body = { tasks: page <= lastPage ? pageOf(page) : [], last_page: page >= lastPage }
    return { ok: true, status: 200, json: async () => body, text: async () => '' }
  }
  const filters = { ...NO_FILTERS, orderBy: 'priority_desc' as const }

  const short = await new ClickUpClient('pk', fetchPages(2)).tasks('900', 0, null, filters)
  assert.equal(pagesRead.length, 3)
  assert.ok(pagesRead.every((order) => order === 'updated'))
  assert.equal(short.tasks.length, 300)
  assert.equal(short.tasks[0].id, 'p2t0')
  assert.deepEqual([short.hasMore, short.truncated], [false, false])

  pagesRead.length = 0
  const long = await new ClickUpClient('pk', fetchPages(50)).tasks('900', 0, null, filters)
  assert.equal(pagesRead.length, MAX_PRIORITY_SORT_PAGES)
  assert.equal(long.truncated, true)
  assert.deepEqual(await new ClickUpClient('pk', fetchPages(50)).tasks('900', 1, null, filters), { tasks: [], hasMore: false })
})

test('groupByStatus keeps the status order and adds unknown statuses', () => {
  const task = (id: string, status: string) => toTaskSummary({ id, status: { status, type: 'custom' } })
  const statuses = [
    { name: 'to do', type: 'open' },
    { name: 'in progress', type: 'custom' },
    { name: 'complete', type: 'closed' }
  ]
  const tasks = [task('a', 'In Progress'), task('b', 'blocked'), task('c', 'to do')]
  const open = { status: '', includeClosed: false }
  assert.deepEqual(groupByStatus(tasks, statuses, open, true).map((g) => [g.status, g.tasks.map((t) => t.id)]), [
    ['to do', ['c']],
    ['in progress', ['a']],
    ['blocked', ['b']]
  ])
  assert.deepEqual(groupByStatus([tasks[0]], statuses, open, false).map((g) => g.status), ['in progress'])
  assert.deepEqual(groupByStatus([], statuses, { status: '', includeClosed: true }, true).length, 3)
  assert.deepEqual(groupByStatus(tasks, statuses, { status: 'to do', includeClosed: false }, true).map((g) => g.status), ['to do'])

  const moved = { ...tasks[2], status: 'complete' }
  assert.deepEqual(replaceTask(tasks, moved, '').map((t) => t.status), ['In Progress', 'blocked', 'complete'])
  assert.deepEqual(replaceTask(tasks, moved, 'to do').map((t) => t.id), ['a', 'b'])
})

test('cardsPerColumn keeps the board under the node limit', () => {
  assert.equal(cardsPerColumn(3), 40)
  assert.equal(cardsPerColumn(10), 30)
  assert.equal(cardsPerColumn(100), 5)
})
