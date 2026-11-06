# ClickUp for Orca

An Orca plugin that shows your ClickUp tasks in the right sidebar. From a task, you can create an Orca worktree and start an agent in it.

## Features

- Shows the open tasks that are assigned to you, or all open tasks in a ClickUp workspace.
- Shows the tasks in one of two views. The panel keeps your choice.
  - **List**: like the ClickUp list view. The tasks are in one section for each status. Each section is a table with name, ID, assignee, due date and priority. Orca hides some columns when the sidebar is narrow. Click a row to open the task.
  - **Board**: a kanban board with one column for each status. The columns scroll sideways. Use the list on a card to move the task to a different status in ClickUp. If ClickUp refuses the status, the card goes back. The board shows at most 300 cards, so a column with many tasks shows only its first cards.
- Changes the status of a task from the task view.
- Filters the tasks by space, status, priority and tag, and sorts them by last update, creation, due date or priority (high to low, or low to high). The ClickUp API cannot sort by priority. For this reason, a priority sort reads at most 500 tasks and sorts them in the plugin. A switch adds closed tasks. The panel keeps your filters for the next time. The ClickUp API cannot filter by priority, so the plugin removes the other tasks from each page of 100. Thus, with a priority filter, a page can show fewer tasks.
- Filters the loaded list by name or ID. Type a task ID (`ENG-123`), a task ID such as `86b0x1y2z` or a task URL, then press Enter to open that task.
- Shows the task details and the description.
- **Start worktree** creates an Orca worktree for the task in the repository you select. The worktree name is the task ID plus the task name, for example `eng-123-fix-login-redirect`. Orca adds your usual branch prefix.
- Optionally starts an agent (Claude Code, Codex, Gemini or OpenCode) in the new worktree. The first prompt contains the task ID, name, URL and description.
- Optionally sets the task status, for example to "in progress", after it creates the worktree.
- Shows the worktrees that already exist for a task. Click one to open it.

## Setup

1. Load the plugin (see [Develop](#develop)) and approve the access that Orca shows.
2. Open the **ClickUp** panel in the right sidebar.
3. Get a personal API token in ClickUp: **Settings → Apps → API Token**. The token starts with `pk_`.
4. Paste the token in the panel and click **Connect**. Orca keeps the token in the plugin's encrypted secrets.

## Settings

Find them in Orca **Settings → Plugins → ClickUp**.

| Setting | Default | What it does |
|---|---|---|
| Status after worktree start | empty | The status to set on the task after the worktree is ready. Empty means no change. |
| Agent prompt | empty | The first prompt for the agent. Placeholders: `{id}`, `{name}`, `{url}`, `{status}`, `{list}`, `{description}`. Empty means the default prompt in `src/clickup.ts`. |
| Orca CLI path | empty | The path of the `orca` command. Empty means the app bundle on macOS, or `orca` on `PATH`. |
| CA certificates file | empty | The path of a PEM file with extra CA certificates to trust. Use it on a network that inspects TLS traffic. Orca does not give `NODE_EXTRA_CA_CERTS` to plugins, so set the same file here. Empty means only the default certificates. |

## How it works

| File | Job |
|---|---|
| `src/panel.tsx` | The sidebar panel (Orca components, no build step). |
| `src/views.tsx` | The list view and the board view. |
| `src/grouping.ts` | Groups the tasks by status. |
| `src/worker.ts` | The Node worker. It keeps the token, calls ClickUp and creates worktrees. |
| `src/clickup.ts` | The ClickUp REST API v2 client and pure helpers. |
| `src/orca-cli.ts` | Runs the `orca` CLI. |
| `src/ca.ts` | Adds the certificates from the CA certificates file to the trusted certificates. |
| `src/protocol.ts` | The request types that the panel and the worker share. |

The plugin host API cannot create a worktree. For this reason, the worker runs `orca worktree create --json`. Orca accepts only PR, MR and issue URLs from known providers as worktree references. For this reason, the plugin writes the ClickUp link into the worktree comment and the agent prompt.

### Access

The plugin runs as a `trusted-worker`. This means that its worker runs with your user account's access. It asks for these capabilities:

- `secrets:own`: keeps the ClickUp token.
- `storage:own`: keeps your ClickUp user ID.
- `settings:own`: reads the settings above.
- `workspace:read`: finds the worktrees that match a task.
- `workspace:write`: opens a worktree in Orca.

## Develop

```sh
orca plugin validate .
orca plugin test .          # unit tests for the client, the worker and the panel
orca plugin check .         # renders the panel with the worker
orca plugin dev watch .     # loads this folder into Orca, prints logs and reloads. Ctrl-C unloads it.
```

To call the worker without the panel:

```sh
orca plugin dev request . auth.status
orca plugin dev request . repos.list
```
