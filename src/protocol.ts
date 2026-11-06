// The panel <-> worker contract. The panel (src/panel.tsx) and the worker (src/worker.ts) both read it.
export {}

export type Scope = 'mine' | 'all'

/** How the panel shows the tasks: grouped rows or a kanban board. */
export type TaskView = 'list' | 'board'

/** ClickUp priorities. `none` means a task without a priority. */
export type Priority = 'urgent' | 'high' | 'normal' | 'low' | 'none'

/** `priority_desc` is urgent first. `priority_asc` is low first. Tasks without a priority are last in both. */
export type OrderBy = 'updated' | 'created' | 'due_date' | 'priority_desc' | 'priority_asc'

/** Task list filters. An empty string means "any". */
export interface TaskFilters {
  spaceId: string
  status: string
  priority: Priority | ''
  tag: string
  includeClosed: boolean
  orderBy: OrderBy
}

export const NO_FILTERS: TaskFilters = {
  spaceId: '',
  status: '',
  priority: '',
  tag: '',
  includeClosed: false,
  orderBy: 'updated'
}

export interface Space {
  id: string
  name: string
}

export interface StatusOption {
  name: string
  /** The ClickUp status type: open, custom, done or closed. */
  type: string | null
}

export interface FilterOptions {
  spaces: Space[]
  /** The statuses of the selected space, or of all spaces when no space is selected. */
  statuses: StatusOption[]
  /** The tags of the selected space, or of all spaces when no space is selected. */
  tags: string[]
}

export interface ClickUpUser {
  id: number
  name: string
}

export interface AuthState {
  connected: boolean
  user: ClickUpUser | null
  /** False when the OS key store is not available. Then the token cannot be stored. */
  secretsAvailable: boolean
}

export interface Team {
  id: string
  name: string
}

export interface TaskSummary {
  id: string
  customId: string | null
  name: string
  status: string
  statusType: string | null
  url: string
  listName: string | null
  priority: string | null
  dueDate: number | null
  updatedAt: number | null
  assignees: string[]
  tags: string[]
}

export interface TaskDetail extends TaskSummary {
  description: string
}

export interface Repo {
  id: string
  name: string
}

export interface LinkedWorktree {
  id: string
  name: string
  branch: string | null
}

export interface StartResult {
  worktreeName: string
  /** The status that the worker set on the task. Null when it did not change the status. */
  statusSet: string | null
  warnings: string[]
}

declare module 'orca' {
  interface PluginRequests {
    /** Tells if a ClickUp token is stored and which user it belongs to. */
    'auth.status': { output: AuthState }
    /** Checks the token with ClickUp, then stores it as a secret. */
    'auth.connect': { input: { token: string }; output: AuthState }
    /** Removes the stored token. */
    'auth.disconnect': { output: AuthState }
    /** The ClickUp workspaces ("teams" in the API) of the user. */
    'teams.list': { output: { teams: Team[] } }
    /** The spaces, statuses and tags that the filter controls offer. */
    'filters.options': { input: { teamId: string; spaceId: string }; output: FilterOptions }
    /**
     * One page of tasks in a ClickUp workspace. ClickUp sends at most 100 tasks on a page.
     * The worker applies the priority filter after ClickUp sends the page, so a page can have fewer tasks.
     */
    'tasks.list': {
      input: { teamId: string; scope: Scope; page: number; filters: TaskFilters }
      /** `truncated` is true when a priority sort stopped before the last page. */
      output: { tasks: TaskSummary[]; hasMore: boolean; truncated?: boolean }
    }
    /** One task by task ID, custom task ID (ENG-123) or task URL, and the worktrees that match it. */
    'task.get': {
      input: { teamId: string; ref: string }
      output: { task: TaskDetail; worktrees: LinkedWorktree[] }
    }
    /** Sets the status of a task. ClickUp refuses a status that the task's list does not have. */
    'task.setStatus': { input: { taskId: string; status: string }; output: { task: TaskSummary } }
    /** The Git repositories that Orca knows. */
    'repos.list': { output: { repos: Repo[] } }
    /** Creates an Orca worktree for a task, and optionally starts an agent in it. */
    'worktree.start': {
      input: { teamId: string; taskId: string; repoId: string; agent: string }
      output: StartResult
    }
    /** Shows a worktree in Orca. */
    'worktree.open': { input: { workspaceId: string }; output: { opened: boolean } }
  }
  interface PluginPanelEvents {
    /** Sent to all open panels after the token changes. */
    'auth.changed': AuthState
  }
}
