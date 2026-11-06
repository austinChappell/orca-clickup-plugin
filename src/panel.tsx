// The ClickUp sidebar panel. Orca removes the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  Field,
  Heading,
  IconButton,
  Input,
  KeyValue,
  Link,
  List,
  ListItem,
  Markdown,
  plugin,
  RadioGroup,
  read,
  Row,
  Select,
  set,
  shell,
  Spinner,
  Stack,
  Switch,
  Text,
  update,
  type PanelContext
} from 'orca'
import { parseTaskRef, taskKey } from './clickup'
import { groupByStatus, replaceTask } from './grouping'
import { breakLongWords } from './text'
import { Board, GroupedList, statusTone } from './views'
import {
  NO_FILTERS,
  type AuthState,
  type FilterOptions,
  type LinkedWorktree,
  type OrderBy,
  type Priority,
  type Repo,
  type Scope,
  type TaskView as TaskViewMode,
  type TaskDetail,
  type TaskFilters,
  type TaskSummary,
  type Team
} from './protocol'

const AGENTS = [
  { value: 'none', label: 'No agent' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'opencode', label: 'OpenCode' }
]
/** Select options cannot have an empty value, so "any" has this value in the controls. */
const ANY = '__any'
const PRIORITIES: { value: Priority; label: string }[] = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
  { value: 'none', label: 'No priority' }
]
const ORDERS: { value: OrderBy; label: string }[] = [
  { value: 'updated', label: 'Last updated' },
  { value: 'created', label: 'Last created' },
  { value: 'due_date', label: 'Due date' },
  { value: 'priority_desc', label: 'Priority, high to low' },
  { value: 'priority_asc', label: 'Priority, low to high' }
]
const TOKEN_HELP_URL = 'https://app.clickup.com/settings/apps'
const START_TIMEOUT_MS = 120_000

// Persistent choices.
const teamId = atom('teamId', '', { persist: 'plugin' })
const scope = atom<Scope>('scope', 'mine', { persist: 'plugin' })
const repoId = atom('repoId', '', { persist: 'plugin' })
const agent = atom('agent', 'claude', { persist: 'plugin' })
const viewMode = atom<TaskViewMode>('viewMode', 'list', { persist: 'plugin' })
const filters = atom<TaskFilters>('filters', NO_FILTERS, { persist: 'plugin', version: 1 })

// State for this panel run.
const auth = atom<AuthState | null>(null)
const tokenDraft = atom('')
const teams = atom<Team[]>([])
const repos = atom<Repo[]>([])
const tasks = atom<TaskSummary[]>([])
const page = atom(0)
const hasMore = atom(false)
/** True when a priority sort stopped before the last page. */
const truncated = atom(false)
const loadingTasks = atom(false)
const filterOptions = atom<FilterOptions>({ spaces: [], statuses: [], tags: [] })
/** Counts task list requests, so that the answer to an old request does not replace a newer list. */
let taskRequest = 0
const filter = atom('')
const selected = atom<{ task: TaskDetail; worktrees: LinkedWorktree[] } | null>(null)
const loadingTask = atom(false)
const busy = atom(false)
const error = atom<string | null>(null)
const notice = atom<string | null>(null)

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Runs `work` and shows its error. It does not clear an earlier error: call `clearMessages` for that. */
async function attempt(work: () => Promise<void>): Promise<boolean> {
  try {
    await work()
    return true
  } catch (err) {
    set(error, messageOf(err))
    return false
  }
}

function clearMessages(): void {
  set(error, null)
  set(notice, null)
}

// ---------------------------------------------------------------------------
// Loaders

async function loadTasks(nextPage = 0): Promise<void> {
  const team = read(teamId)
  if (team === '') return
  const request = ++taskRequest
  set(loadingTasks, true)
  try {
    await attempt(async () => {
      const answer = await plugin.request('tasks.list', {
        teamId: team,
        scope: read(scope),
        page: nextPage,
        filters: { ...NO_FILTERS, ...read(filters) }
      })
      if (request !== taskRequest) return
      set(tasks, nextPage === 0 ? answer.tasks : [...read(tasks), ...answer.tasks])
      set(page, nextPage)
      set(hasMore, answer.hasMore)
      set(truncated, answer.truncated === true)
    })
  } finally {
    if (request === taskRequest) set(loadingTasks, false)
  }
}

/** Reads the spaces, statuses and tags for the filters. Removes a stored filter value that is not valid now. */
async function loadFilterOptions(): Promise<void> {
  const team = read(teamId)
  if (team === '') return
  await attempt(async () => {
    const current = read(filters)
    const options = await plugin.request('filters.options', { teamId: team, spaceId: current.spaceId })
    if (current.spaceId !== '' && !options.spaces.some((space) => space.id === current.spaceId)) {
      // The stored space is not in this ClickUp workspace. Read the options for all spaces.
      update(filters, (value) => ({ ...value, spaceId: '', status: '', tag: '' }))
      await loadFilterOptions()
      return
    }
    set(filterOptions, options)
    const statusValid = current.status === '' || options.statuses.some((status) => status.name === current.status)
    const tagValid = current.tag === '' || options.tags.includes(current.tag)
    if (!statusValid || !tagValid) {
      update(filters, (value) => ({ ...value, status: statusValid ? value.status : '', tag: tagValid ? value.tag : '' }))
    }
  })
}

/** Changes the filters and reads the task list again. A new space clears the status and the tag. */
async function changeFilters(patch: Partial<TaskFilters>): Promise<void> {
  clearMessages()
  const spaceChanged = patch.spaceId !== undefined && patch.spaceId !== read(filters).spaceId
  update(filters, (value) => ({ ...value, ...patch, ...(spaceChanged ? { status: '', tag: '' } : {}) }))
  if (spaceChanged) await loadFilterOptions()
  await loadTasks(0)
}

async function clearFilters(): Promise<void> {
  const spaceChanged = read(filters).spaceId !== ''
  set(filters, NO_FILTERS)
  if (spaceChanged) await loadFilterOptions()
  await loadTasks(0)
}

async function changeTeam(id: string): Promise<void> {
  clearMessages()
  set(teamId, id)
  update(filters, (value) => ({ ...value, spaceId: '', status: '', tag: '' }))
  await loadFilterOptions()
  await loadTasks(0)
}

async function loadTeams(): Promise<boolean> {
  return attempt(async () => {
    const answer = await plugin.request('teams.list')
    set(teams, answer.teams)
    if (!answer.teams.some((team) => team.id === read(teamId))) set(teamId, answer.teams[0]?.id ?? '')
  })
}

async function loadRepos(): Promise<void> {
  await attempt(async () => {
    const answer = await plugin.request('repos.list')
    set(repos, answer.repos)
    if (!answer.repos.some((repo) => repo.id === read(repoId))) set(repoId, '')
  })
}

async function loadAll(): Promise<void> {
  clearMessages()
  const teamsLoaded = await loadTeams()
  const loadTaskList = async () => {
    // The options can remove a stored filter value, so read the tasks after the options.
    await loadFilterOptions()
    await loadTasks(0)
  }
  await Promise.all([teamsLoaded ? loadTaskList() : Promise.resolve(), loadRepos()])
}

async function openTask(ref: string): Promise<void> {
  clearMessages()
  set(loadingTask, true)
  try {
    await attempt(async () => {
      set(selected, await plugin.request('task.get', { teamId: read(teamId), ref }))
    })
  } finally {
    set(loadingTask, false)
  }
}

// ---------------------------------------------------------------------------
// Actions

async function connect(): Promise<void> {
  clearMessages()
  set(busy, true)
  try {
    await attempt(async () => {
      set(auth, await plugin.request('auth.connect', { token: read(tokenDraft) }))
      set(tokenDraft, '')
      await loadAll()
    })
  } finally {
    set(busy, false)
  }
}

async function disconnect(): Promise<void> {
  clearMessages()
  await attempt(async () => {
    set(auth, await plugin.request('auth.disconnect'))
    set(tasks, [])
    set(selected, null)
  })
}

async function startWorktree(task: TaskDetail): Promise<void> {
  clearMessages()
  set(busy, true)
  try {
    await attempt(async () => {
      const result = await plugin.request(
        'worktree.start',
        { teamId: read(teamId), taskId: task.id, repoId: read(repoId), agent: read(agent) },
        { timeoutMs: START_TIMEOUT_MS }
      )
      const parts = [`Orca created the worktree "${result.worktreeName}".`]
      if (result.statusSet) parts.push(`The task status is now "${result.statusSet}".`)
      parts.push(...result.warnings)
      set(notice, parts.join(' '))
      // Read the task again to show the new status and the new worktree.
      set(selected, await plugin.request('task.get', { teamId: read(teamId), ref: task.id }))
    })
  } finally {
    set(busy, false)
  }
}

/** Sets a new status in ClickUp. The board shows the change at once and puts the task back if ClickUp refuses it. */
async function moveTask(task: TaskSummary, status: string): Promise<void> {
  if (status === task.status) return
  clearMessages()
  const statusFilter = read(filters).status
  set(tasks, replaceTask(read(tasks), { ...task, status }, ''))
  const ok = await attempt(async () => {
    const answer = await plugin.request('task.setStatus', { taskId: task.id, status })
    set(tasks, replaceTask(read(tasks), answer.task, statusFilter))
    const current = read(selected)
    if (current && current.task.id === task.id) set(selected, { ...current, task: { ...current.task, ...answer.task } })
  })
  if (!ok) set(tasks, replaceTask(read(tasks), task, ''))
}

function submitFilter(value: string): void {
  if (parseTaskRef(value)) void openTask(value)
}

/** Runs once before the first render. The subscriptions stop when the panel closes. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('auth.changed', (state) => {
      set(auth, state)
      if (state.connected) void loadAll()
    })
  )
  void attempt(async () => {
    const state = await plugin.request('auth.status')
    set(auth, state)
    if (state.connected) await loadAll()
  })
}

// ---------------------------------------------------------------------------
// Views

function Messages() {
  const err = read(error)
  const info = read(notice)
  return (
    <Stack gap="xs">
      {err ? (
        <Callout tone="danger" icon="error" title="Error">
          <Text>{err}</Text>
        </Callout>
      ) : null}
      {info ? (
        <Callout tone="success" icon="check">
          <Text>{info}</Text>
        </Callout>
      ) : null}
    </Stack>
  )
}

function ConnectView({ state }: { state: AuthState }) {
  return (
    <Stack gap="md">
      <Heading level={2}>Connect ClickUp</Heading>
      <Text muted size="sm">
        Paste your personal API token. Orca keeps it in the plugin's encrypted secrets.
      </Text>
      <Link onPress={() => void shell.openExternal(TOKEN_HELP_URL)}>Get a token in ClickUp settings</Link>
      {state.secretsAvailable ? null : (
        <Callout tone="warning" icon="warning" title="No key store">
          <Text>This computer has no OS key store. Orca cannot keep the token.</Text>
        </Callout>
      )}
      <Input
        label="Personal API token"
        type="password"
        placeholder="pk_..."
        value={read(tokenDraft)}
        onChange={(value) => set(tokenDraft, value)}
        onSubmit={() => void connect()}
      />
      <Button icon="link" disabled={read(busy) || read(tokenDraft).trim() === ''} onPress={connect}>
        Connect
      </Button>
      <Messages />
    </Stack>
  )
}

/** The statuses of the filter options, plus the current status when it is not one of them. */
function statusChoices(current: string): { value: string; label: string }[] {
  const names = read(filterOptions).statuses.map((status) => status.name)
  const all = names.some((name) => name.toLowerCase() === current.toLowerCase()) ? names : [current, ...names]
  return all.map((name) => ({ value: name, label: name }))
}

function TaskView({ task, worktrees }: { task: TaskDetail; worktrees: LinkedWorktree[] }) {
  const repoList = read(repos)
  const working = read(busy)
  const details = [
    { label: 'ID', value: taskKey(task) },
    { label: 'List', value: task.listName ?? '-' },
    { label: 'Assignees', value: task.assignees.length > 0 ? task.assignees.join(', ') : '-' },
    { label: 'Priority', value: task.priority ?? '-' },
    { label: 'Tags', value: task.tags.length > 0 ? task.tags.join(', ') : '-' },
    { label: 'Due', value: task.dueDate ? new Date(task.dueDate).toLocaleDateString() : '-' }
  ]
  return (
    <Stack gap="md">
      <Row justify="between">
        <IconButton icon="collapse" label="Back to the task list" variant="ghost" onPress={() => set(selected, null)} />
        <Badge tone={statusTone(task.statusType)}>{task.status}</Badge>
      </Row>
      <Heading level={3}>{breakLongWords(task.name)}</Heading>
      <Select
        label="Status"
        value={task.status}
        options={statusChoices(task.status)}
        onChange={(status) => void moveTask(task, status)}
      />
      <KeyValue items={details} />
      <Field label="Repository">
        <Select
          label="Repository"
          labelHidden
          placeholder="Select a repository"
          value={read(repoId)}
          options={repoList.map((repo) => ({ value: repo.id, label: repo.name }))}
          onChange={(value) => set(repoId, value)}
        />
      </Field>
      <Field label="Agent">
        <Select label="Agent" labelHidden value={read(agent)} options={AGENTS} onChange={(value) => set(agent, value)} />
      </Field>
      <Row gap="xs" wrap>
        <Button icon="branch" disabled={working || read(repoId) === ''} onPress={() => startWorktree(task)}>
          {working ? 'Creating worktree...' : 'Start worktree'}
        </Button>
        <Button icon="open-external" variant="ghost" onPress={() => void shell.openExternal(task.url)}>
          Open in ClickUp
        </Button>
      </Row>
      <Messages />
      {worktrees.length > 0 ? (
        <List label="Worktrees for this task">
          {worktrees.map((wt) => (
            <ListItem
              title={wt.name}
              description={wt.branch ?? undefined}
              icon="branch"
              onPress={() => void attempt(async () => void (await plugin.request('worktree.open', { workspaceId: wt.id })))}
            />
          ))}
        </List>
      ) : null}
      <Collapsible title="Description" defaultOpen>
        {task.description ? <Markdown content={task.description} /> : <Text muted>The task has no description.</Text>}
      </Collapsible>
    </Stack>
  )
}

const toControl = (value: string) => (value === '' ? ANY : value)
const fromControl = (value: string) => (value === ANY ? '' : value)

/** A short text of the active filters, for example "Space: Product · Priority: High". Null when no filter is active. */
function activeFilterText(value: TaskFilters, options: FilterOptions): string | null {
  const parts: string[] = []
  if (value.spaceId !== '') parts.push(`Space: ${options.spaces.find((space) => space.id === value.spaceId)?.name ?? value.spaceId}`)
  if (value.status !== '') parts.push(`Status: ${value.status}`)
  if (value.priority !== '') parts.push(`Priority: ${PRIORITIES.find((p) => p.value === value.priority)?.label ?? value.priority}`)
  if (value.tag !== '') parts.push(`Tag: ${value.tag}`)
  if (value.includeClosed) parts.push('Closed included')
  return parts.length > 0 ? parts.join(' · ') : null
}

function FilterControls() {
  const value = read(filters)
  const options = read(filterOptions)
  const active = activeFilterText(value, options)
  const sortLabel = ORDERS.find((order) => order.value === value.orderBy)?.label ?? ''
  return (
    <Collapsible title="Filters" description={active ?? `No filters · Sort: ${sortLabel}`}>
      <Stack gap="sm">
        <Select
          label="Space"
          value={toControl(value.spaceId)}
          options={[{ value: ANY, label: 'All spaces' }, ...options.spaces.map((space) => ({ value: space.id, label: space.name }))]}
          onChange={(next) => void changeFilters({ spaceId: fromControl(next) })}
        />
        <Select
          label="Status"
          value={toControl(value.status)}
          options={[
            { value: ANY, label: 'Any status' },
            ...options.statuses.map((status) => ({ value: status.name, label: status.name }))
          ]}
          onChange={(next) => void changeFilters({ status: fromControl(next) })}
        />
        <Select
          label="Priority"
          value={toControl(value.priority)}
          options={[{ value: ANY, label: 'Any priority' }, ...PRIORITIES]}
          onChange={(next) => void changeFilters({ priority: fromControl(next) as Priority | '' })}
        />
        <Select
          label="Tag"
          value={toControl(value.tag)}
          disabled={options.tags.length === 0 && value.tag === ''}
          options={[
            { value: ANY, label: options.tags.length === 0 ? 'No tags' : 'Any tag' },
            ...options.tags.map((tag) => ({ value: tag, label: tag }))
          ]}
          onChange={(next) => void changeFilters({ tag: fromControl(next) })}
        />
        <Select
          label="Sort by"
          value={value.orderBy}
          options={ORDERS}
          onChange={(next) => void changeFilters({ orderBy: next as OrderBy })}
        />
        <Switch
          label="Include closed tasks"
          checked={value.includeClosed || value.status !== ''}
          disabled={value.status !== ''}
          onChange={(checked) => void changeFilters({ includeClosed: checked })}
        />
        {value.priority !== '' ? (
          <Text muted size="xs">
            ClickUp cannot filter by priority. The plugin removes the other tasks from each page, so a page can show fewer tasks.
          </Text>
        ) : null}
        <Button variant="ghost" size="sm" icon="close" disabled={active === null && value.orderBy === 'updated'} onPress={clearFilters}>
          Clear filters
        </Button>
      </Stack>
    </Collapsible>
  )
}

function ListView() {
  const query = read(filter).trim().toLowerCase()
  const all = read(tasks)
  const shown =
    query === ''
      ? all
      : all.filter((task) => task.name.toLowerCase().includes(query) || taskKey(task).toLowerCase().includes(query))
  const teamList = read(teams)
  const loading = read(loadingTasks)
  const looksLikeRef = parseTaskRef(read(filter)) !== null
  const mode = read(viewMode)
  return (
    <Stack gap="sm">
      <Row gap="xs">
        <Button size="sm" icon="file-text" variant={mode === 'list' ? 'solid' : 'ghost'} onPress={() => set(viewMode, 'list')}>
          List
        </Button>
        <Button size="sm" icon="blocks" variant={mode === 'board' ? 'solid' : 'ghost'} onPress={() => set(viewMode, 'board')}>
          Board
        </Button>
      </Row>
      {teamList.length > 1 ? (
        <Select
          label="ClickUp workspace"
          value={read(teamId)}
          options={teamList.map((team) => ({ value: team.id, label: team.name }))}
          onChange={(value) => void changeTeam(value)}
        />
      ) : null}
      <RadioGroup
        label="Tasks to show"
        labelHidden
        orientation="horizontal"
        value={read(scope)}
        options={[
          { value: 'mine', label: 'Assigned to me' },
          { value: 'all', label: 'All open' }
        ]}
        onChange={(value) => {
          set(scope, value as Scope)
          void loadTasks(0)
        }}
      />
      <FilterControls />
      <Input
        label="Filter tasks, or type a task ID and press Enter"
        labelHidden
        type="search"
        placeholder="Filter, or ENG-123 + Enter"
        value={read(filter)}
        onChange={(value) => set(filter, value)}
        onSubmit={submitFilter}
      />
      {looksLikeRef ? (
        <Button size="sm" variant="outline" icon="search" onPress={() => openTask(read(filter))}>
          Open task {read(filter).trim()}
        </Button>
      ) : null}
      <Messages />
      {read(loadingTask) ? <Spinner label="Loading the task" /> : null}
      {loading && all.length === 0 ? (
        <Spinner label="Loading tasks" />
      ) : shown.length === 0 ? (
        <EmptyState
          icon="check"
          title={query !== '' || activeFilterText(read(filters), read(filterOptions)) !== null ? 'No tasks match the filters' : 'No open tasks'}
        />
      ) : mode === 'board' ? (
        <Board
          groups={groupByStatus(shown, read(filterOptions).statuses, read(filters), true)}
          onOpen={(id) => void openTask(id)}
          onMove={(task, status) => void moveTask(task, status)}
        />
      ) : (
        <GroupedList groups={groupByStatus(shown, read(filterOptions).statuses, read(filters), false)} onOpen={(id) => void openTask(id)} />
      )}
      {read(truncated) ? (
        <Text muted size="xs">
          The priority sort uses only the first 500 tasks. Add a filter to see the other tasks.
        </Text>
      ) : null}
      {read(hasMore) ? (
        <Button variant="ghost" size="sm" disabled={loading} onPress={() => loadTasks(read(page) + 1)}>
          {loading ? 'Loading...' : 'Load more'}
        </Button>
      ) : null}
    </Stack>
  )
}

export default function Panel() {
  const state = read(auth)
  if (state === null) {
    return (
      <Stack gap="sm">
        <Spinner label="Loading ClickUp" />
        <Messages />
      </Stack>
    )
  }
  if (!state.connected) return <ConnectView state={state} />
  const current = read(selected)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Text muted size="xs" truncate>
          {state.user ? `ClickUp: ${state.user.name}` : 'ClickUp'}
        </Text>
        <Row gap="none">
          <IconButton icon="refresh" label="Refresh" variant="ghost" size="sm" onPress={() => loadAll()} />
          <IconButton icon="close" label="Disconnect ClickUp" variant="ghost" size="sm" onPress={disconnect} />
        </Row>
      </Row>
      {current ? <TaskView task={current.task} worktrees={current.worktrees} /> : <ListView />}
    </Stack>
  )
}
