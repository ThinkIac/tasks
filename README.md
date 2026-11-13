# Tasks

Event-driven task management for ThinkIac. It is a Lógos package with a Workflow menu view, HTTP API, MCP tools, persisted data, and `tasks:*` domain events.

## Instalação responsável

Antes de adicionar este pacote ao seu workspace, peça ao seu assistente de IA para revisar o código e as permissões necessárias no seu ambiente. Quando a análise estiver concluída, solicite a instalação no workspace que estiver ativo.

## How it works

The package stores boards, columns, tasks, and comments through the Lógos `getProxy('tasks')` data proxy. The same handlers serve the UI, HTTP routes, and MCP tools, so each entry point has identical validation and side effects.

Creating, updating, moving, completing, cancelling, deleting, or commenting on a task emits a domain event. A five-minute scan also emits due events once per due date. Other ThinkIac packages can subscribe without depending on the Tasks UI or API.

At boot, Tasks creates the default **Meu Board** and its Kanban columns when no board exists, and starts the due-date scan.

## HTTP endpoints

The package route prefix is `/tasks`. Responses contain the runtime-unwrapped route result.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/tasks/boards` | List boards and their columns. |
| `POST` | `/tasks/boards` | Create a board. |
| `PATCH` | `/tasks/boards/:id` | Update a board. |
| `DELETE` | `/tasks/boards/:id` | Delete a board and its contents. |
| `GET` | `/tasks/columns?boardId=:id` | List board columns. |
| `POST` | `/tasks/columns` | Create a column. |
| `PATCH` | `/tasks/columns/:id` | Update a column. |
| `DELETE` | `/tasks/columns/:id` | Delete a column. |
| `GET` | `/tasks/tasks` | List tasks, optionally filtered by board, column, priority, tag, or search. |
| `POST` | `/tasks/tasks` | Create a task. |
| `GET` | `/tasks/tasks/:id` | Get a task. |
| `PATCH` | `/tasks/tasks/:id` | Update a task. |
| `DELETE` | `/tasks/tasks/:id` | Delete a task. |
| `POST` | `/tasks/tasks/:id/move` | Move a task to a column or board. |
| `POST` | `/tasks/create-from-text` | Create a task from natural language. |
| `GET` | `/tasks/events` | Open the live Server-Sent Events stream. |

Example:

```http
POST /tasks/tasks
Content-Type: application/json

{
  "boardId": "board-id",
  "columnId": "column-id",
  "title": "Review the deployment plan",
  "priority": "high",
  "tags": ["release", "review"]
}
```

`boardId`, `columnId`, and `title` are required. Dates must be ISO-8601 when `dueDate` is supplied.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `tasks_listBoards` | List boards and their columns. |
| `tasks_createTask` | Create a task from structured data. |
| `tasks_createTaskFromText` | Classify and create a task from natural language. |
| `tasks_listTasks` | List, filter, search, or count tasks. |
| `tasks_getTask` | Get one task by ID. |
| `tasks_updateTask` | Update task fields. |
| `tasks_moveTask` | Move a task by board or column name or ID. |
| `tasks_addTaskComment` | Add a comment to a task. |
| `tasks_getTaskContext` | Get task comments. |
| `tasks_deleteTask` | Delete a task. |

Tool arguments accept the documented object shape, including flattened MCP fields such as `data.title` and `filters.search`.

Example tool input:

```json
{
  "data": {
    "boardId": "board-id",
    "columnId": "column-id",
    "title": "Prepare product demo",
    "priority": "medium"
  }
}
```

## Domain events

Task payloads include stable task data such as `id`, `title`, `boardId`, `columnId`, `priority`, `dueDate`, and `tags` when applicable.

| Event | When it is emitted |
| --- | --- |
| `tasks:created` | A task is created. |
| `tasks:updated` | A task is updated. |
| `tasks:moved` | A task moves between columns or boards. |
| `tasks:completed` | A task enters a done column. |
| `tasks:cancelled` | A task enters a cancelled column. |
| `tasks:reopened` | A task leaves a terminal column. |
| `tasks:deleted` | A task is deleted. |
| `tasks:due` | An open task reaches its due date. |
| `tasks:comment_added` | A comment is created. |
| `tasks:comment_deleted` | A comment is deleted. |
| `tasks:board_*` | A board is created, updated, or deleted. |
| `tasks:column_*` | A column is created, updated, or deleted. |

Listen through Lógos with `dispatchEvent` consumers or the runtime event subscription mechanism. Tasks uses `dispatchEvent('tasks:*', payload)` as its integration contract.

## Key features

- Multiple boards with ordered, color-coded columns.
- Open, done, and cancelled column types with matching lifecycle events.
- Priority, tags, descriptions, resolutions, due dates, and comments.
- Live Kanban updates through Server-Sent Events.
- Board, list, focus, and daily-planner views.
- Natural-language task creation with deterministic board and column validation.
- Optional semantic search through the embeddings event bridge.
- Persistent, idempotent due-date notifications.

## ThinkIac and Lógos integration

| Layer | Lógos / ThinkIac role |
| --- | --- |
| Data | `getProxy('tasks')` persists `Board`, `Column`, `Task`, and `Comment` records from `schema.prisma`. |
| HTTP | `@register_router` declarations expose the `/tasks` endpoints. |
| MCP | `@register_tool` declarations expose the `tasks_*` tools. |
| Events | `dispatchEvent` publishes `tasks:*` domain events. |
| Lifecycle | `@register_hook boot` seeds data and starts the due-date scan. |
| AI | ThinkIac's agent host classifies natural-language creation into an existing board and column. |
| UI | The package manifest registers the left-side Tasks view with the Lucide Workflow icon. |

## Development

```bash
npm test --prefix apps/thinkiac/packages/tasks
```

The test suite verifies task context, the message-widget parser, and the system-board policy.
