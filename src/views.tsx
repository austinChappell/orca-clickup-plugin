// The list view (grouped by status, like the ClickUp list) and the board view (one column per status).
import { Badge, Box, Collapsible, Link, Row, Select, Stack, Table, Text } from 'orca'
import { taskKey } from './clickup'
import type { StatusGroup } from './grouping'
import { breakLongWords } from './text'
import type { TaskSummary } from './protocol'

/**
 * Orca refuses a render with more than 5000 nodes, and a card has about 10 nodes.
 * For this reason, the board draws at most MAX_BOARD_CARDS cards, shared by the columns.
 */
export const MAX_BOARD_CARDS = 300
export const MAX_CARDS_PER_COLUMN = 40

/** How many cards each column draws: at most 40, and at least 5. */
export function cardsPerColumn(columnCount: number): number {
  return Math.max(5, Math.min(MAX_CARDS_PER_COLUMN, Math.floor(MAX_BOARD_CARDS / Math.max(1, columnCount))))
}
const COLUMN_WIDTH = 230

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export function priorityTone(priority: string | null): Tone {
  switch (priority?.toLowerCase()) {
    case 'urgent':
      return 'danger'
    case 'high':
      return 'warning'
    case 'normal':
      return 'accent'
    default:
      return 'neutral'
  }
}

export function statusTone(type: string | null): Tone {
  if (type === 'closed' || type === 'done') return 'success'
  if (type === 'custom') return 'accent'
  return 'neutral'
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

function formatDue(dueDate: number | null): string {
  return dueDate ? new Date(dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
}

const LIST_COLUMNS = [
  { key: 'name', label: 'Name', width: 'auto' as const },
  { key: 'id', label: 'ID', width: 'xs' as const, hideBelow: 'md' as const },
  { key: 'assignee', label: 'Assignee', width: 'sm' as const, hideBelow: 'md' as const },
  { key: 'due', label: 'Due', width: 'xs' as const, hideBelow: 'sm' as const },
  { key: 'priority', label: 'Priority', width: 'xs' as const }
]

/** The ClickUp-style list: one section for each status, with a table of its tasks. */
export function GroupedList({ groups, onOpen }: { groups: StatusGroup[]; onOpen: (taskId: string) => void }) {
  return (
    <Stack gap="sm">
      {groups.map((group) => (
        <Collapsible title={group.status.toUpperCase()} description={`${group.tasks.length} tasks`} defaultOpen>
          <Table
            label={`Tasks with the status ${group.status}`}
            columns={LIST_COLUMNS}
            rows={group.tasks.map((task) => ({
              key: task.id,
              cells: {
                name: task.name,
                id: taskKey(task),
                assignee: task.assignees.join(', '),
                due: formatDue(task.dueDate),
                priority: task.priority ? capitalize(task.priority) : ''
              }
            }))}
            selectionMode="single"
            selected={[]}
            onSelectionChange={({ keys }) => {
              if (keys[0]) onOpen(keys[0])
            }}
            onRowAction={({ key }) => onOpen(key)}
          />
        </Collapsible>
      ))}
    </Stack>
  )
}

function BoardCard({
  task,
  statuses,
  onOpen,
  onMove
}: {
  task: TaskSummary
  statuses: string[]
  onOpen: (taskId: string) => void
  onMove: (task: TaskSummary, status: string) => void
}) {
  const due = formatDue(task.dueDate)
  return (
    <Box direction="column" gap="xs" padding="sm" border radius="md" background="card">
      <Link onPress={() => onOpen(task.id)}>{breakLongWords(task.name)}</Link>
      <Row gap="xs" wrap>
        <Text muted size="xs">
          {taskKey(task)}
        </Text>
        {task.priority ? <Badge tone={priorityTone(task.priority)}>{capitalize(task.priority)}</Badge> : null}
        {due ? (
          <Text muted size="xs">
            Due {due}
          </Text>
        ) : null}
      </Row>
      {task.tags.length > 0 ? (
        <Text muted size="xs" truncate>
          {task.tags.map((tag) => `#${tag}`).join(' ')}
        </Text>
      ) : null}
      <Select
        label={`Move ${taskKey(task)} to`}
        labelHidden
        value={task.status}
        options={statuses.map((status) => ({ value: status, label: status }))}
        onChange={(status) => onMove(task, status)}
      />
    </Box>
  )
}

/** The kanban board: one column for each status. The columns scroll sideways. */
export function Board({
  groups,
  onOpen,
  onMove
}: {
  groups: StatusGroup[]
  onOpen: (taskId: string) => void
  onMove: (task: TaskSummary, status: string) => void
}) {
  const statuses = groups.map((group) => group.status)
  const limit = cardsPerColumn(groups.length)
  return (
    <Box direction="row" gap="sm" scroll="x" align="start">
      {groups.map((group) => {
        const shown = group.tasks.slice(0, limit)
        const hidden = group.tasks.length - shown.length
        return (
          <Box direction="column" gap="sm" padding="sm" width={COLUMN_WIDTH} minWidth={COLUMN_WIDTH} radius="md" background="muted" shrink={false}>
            <Row justify="between">
              <Text weight="semibold" size="sm" truncate>
                {group.status.toUpperCase()}
              </Text>
              <Badge tone={statusTone(group.type)}>{String(group.tasks.length)}</Badge>
            </Row>
            {shown.length === 0 ? (
              <Text muted size="xs">
                No tasks
              </Text>
            ) : (
              shown.map((task) => (
                // A task status can be missing from the board columns. Keep it in the card's list.
                <BoardCard
                  task={task}
                  statuses={statuses.includes(task.status) ? statuses : [task.status, ...statuses]}
                  onOpen={onOpen}
                  onMove={onMove}
                />
              ))
            )}
            {hidden > 0 ? (
              <Text muted size="xs">
                {hidden} more tasks. Use a filter or the list view to see them.
              </Text>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}
