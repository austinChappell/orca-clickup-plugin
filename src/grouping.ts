// Groups tasks by status for the list view and the board view. Pure functions without Orca imports.
import type { StatusOption, TaskFilters, TaskSummary } from './protocol'

export interface StatusGroup {
  /** The status name as ClickUp spells it. */
  status: string
  type: string | null
  tasks: TaskSummary[]
}

const CLOSED_TYPES = new Set(['closed', 'done'])

/**
 * Puts the tasks into one group for each status, in the order of `statuses`.
 * A task status that is not in `statuses` gets a group after the known statuses.
 * Status names are compared without case.
 *
 * - `keepEmpty`: keep groups without tasks (the board shows them as drop targets).
 * - Empty groups of a closed status are removed when the filters do not include closed tasks.
 * - When the filters name one status, only that group is kept.
 */
export function groupByStatus(
  tasks: TaskSummary[],
  statuses: StatusOption[],
  filters: Pick<TaskFilters, 'status' | 'includeClosed'>,
  keepEmpty: boolean
): StatusGroup[] {
  const groups = new Map<string, StatusGroup>()
  for (const status of statuses) {
    const key = status.name.toLowerCase()
    if (!groups.has(key)) groups.set(key, { status: status.name, type: status.type, tasks: [] })
  }
  for (const task of tasks) {
    const key = task.status.toLowerCase()
    let group = groups.get(key)
    if (!group) {
      group = { status: task.status, type: task.statusType, tasks: [] }
      groups.set(key, group)
    }
    group.tasks.push(task)
  }
  const showClosed = filters.includeClosed || filters.status !== ''
  return [...groups.values()].filter((group) => {
    if (filters.status !== '' && group.status.toLowerCase() !== filters.status.toLowerCase()) return false
    if (group.tasks.length > 0) return true
    if (!keepEmpty) return false
    return showClosed || !CLOSED_TYPES.has(group.type ?? '')
  })
}

/** Replaces a task in the list after a status change, or removes it when it no longer matches the status filter. */
export function replaceTask(tasks: TaskSummary[], next: TaskSummary, statusFilter: string): TaskSummary[] {
  const keep = statusFilter === '' || next.status.toLowerCase() === statusFilter.toLowerCase()
  return tasks.flatMap((task) => (task.id !== next.id ? [task] : keep ? [next] : []))
}
