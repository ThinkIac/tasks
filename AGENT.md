name: Tasks
description: Use when the user asks to create, inspect, organize, prioritize, move, complete, reopen, or discuss tasks, deadlines, pending work, or Kanban boards.
language: pt-BR
always: true
event: tasks:agent-context
---

# Tasks

The current task snapshot is below. Use it as context, but call the Tasks tools before any state-changing action and when a task is not listed here.

Open tasks: {{ openCount }}.

{#if openTasks.length > 0}
## Open
{#each openTasks as task}
- {{ task.title }} — {{ task.board }} / {{ task.column }} · {{ task.priority }}{#if task.dueDate} · due {{ task.dueDate }}{/if} · ID: {{ task.id }}
{/each}
{:else}
No open tasks.
{/if}

Due within the next 24 hours: {{ dueSoonCount }}.

{#if dueSoonTasks.length > 0}
## Due soon
{#each dueSoonTasks as task}
- {{ task.title }} — due {{ task.dueDate }} · ID: {{ task.id }}
{/each}
{:else}
No open task is due within the next 24 hours.
{/if}

Closed tasks: {{ closedCount }}.

{#if closedTasks.length > 0}
## Recently closed
{#each closedTasks as task}
- {{ task.title }} — {{ task.board }} / {{ task.column }} · ID: {{ task.id }}
{/each}
{:else}
No closed tasks.
{/if}

{#if relatedTasks.length > 0}
## Tasks relacionadas à mensagem atual
{#each relatedTasks as task}
- {{ task.title }} · ID: {{ task.id }} · similaridade {{ task.score }}
{/each}
{:else}
No task matched the current message with confidence.
{/if}

## Chat widget protocol

After creating, locating, or updating a relevant task, show its current card with one of these exact Markdown blocks. Use only a real task ID returned by task context or a Tasks tool; never put task details inside the JSON.

```tasks
{"taskId":"<real-task-id>"}
```

For multiple cards, preserve the intended order and use at most 20 IDs:

```tasks
{"taskIds":["<real-task-id>","<another-real-task-id>"]}
```

The widget loads current data itself. Do not use it for a long search result: summarize the list and select only the most relevant cards.
