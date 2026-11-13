<script>
    // Widget compacto do menu (manifest.menu, ver package.json) — cria tasks.
    // Dois modos: "Manual" (padrão) replica os campos da modal do board
    // (views/components/TaskModal.svelte) e chama POST /tasks direto; "IA"
    // usa createTaskFromText (tasks/index.js), que faz UMA chamada de LLM pra
    // classificar e cria a task. Roda num <iframe> isolado dentro do Sidebar,
    // então reporta a própria altura via postMessage/ResizeObserver — por isso
    // o formulário é inline (uma modal fixed ficaria presa ao iframe). O board
    // completo continua em views/Index.svelte, sem relação com este arquivo.
    import { onMount, onDestroy, tick } from "svelte";
    import {
        createTask,
        createTaskFromText,
        listBoards,
        listColumns,
    } from "./lib/api.js";
    import { getTheme, onThemeChange } from "./lib/theme.js";

    let mode = "manual"; // "manual" | "ai"
    let theme = getTheme();

    // Manual
    let boards = [];
    let columns = [];
    let boardId = "";
    let columnId = "";
    let loadingBoards = true;
    let form = emptyForm();

    // IA
    let text = "";

    let saving = false;
    let result = null;
    let error = null;

    function emptyForm() {
        return {
            title: "",
            description: "",
            priority: "medium",
            dueDate: "",
            tags: "",
        };
    }

    function send(type, detail) {
        parent.postMessage({ source: "aurora", type, detail }, "*");
    }
    function reportHeight() {
        send("widget:height", document.documentElement.scrollHeight);
    }

    let resizeObserver;
    let unsubscribeTheme;
    onMount(async () => {
        resizeObserver = new ResizeObserver(reportHeight);
        resizeObserver.observe(document.body);
        reportHeight();
        unsubscribeTheme = onThemeChange(t => (theme = t));
        await loadBoards();
    });
    onDestroy(() => {
        if (resizeObserver) resizeObserver.disconnect();
        if (unsubscribeTheme) unsubscribeTheme();
    });

    async function loadBoards() {
        loadingBoards = true;
        try {
            boards = await listBoards();
            if (boards.length) {
                boardId = boards[0].id;
                await loadColumns();
            }
        } catch (e) {
            error = e.message;
        }
        loadingBoards = false;
        await tick();
        reportHeight();
    }

    async function loadColumns() {
        if (!boardId) {
            columns = [];
            columnId = "";
            return;
        }
        columns = await listColumns(boardId);
        columnId = columns[0]?.id ?? "";
    }

    async function onBoardChange() {
        try {
            await loadColumns();
        } catch (e) {
            error = e.message;
        }
        await tick();
        reportHeight();
    }

    async function setMode(next) {
        mode = next;
        error = null;
        await tick();
        reportHeight();
    }

    async function submitManual() {
        const title = form.title.trim();
        if (!title || !columnId || saving) return;
        saving = true;
        error = null;
        try {
            const task = await createTask({
                boardId,
                columnId,
                title,
                description: form.description.trim() || null,
                priority: form.priority,
                dueDate: form.dueDate
                    ? new Date(form.dueDate).toISOString()
                    : null,
                tags: form.tags
                    .split(",")
                    .map(t => t.trim())
                    .filter(Boolean),
            });
            result = {
                title: task.title,
                board: boards.find(b => b.id === boardId)?.name ?? "",
                column: columns.find(c => c.id === columnId)?.name ?? "",
            };
            form = emptyForm();
        } catch (e) {
            error = e.message;
        }
        saving = false;
        await tick();
        reportHeight();
    }

    async function submitAi() {
        const t = text.trim();
        if (!t || saving) return;
        saving = true;
        error = null;
        try {
            result = await createTaskFromText(t);
            text = "";
        } catch (e) {
            error = e.message;
        }
        saving = false;
        await tick();
        reportHeight();
    }

    async function another() {
        result = null;
        error = null;
        await tick();
        reportHeight();
    }

    function handleKeydown(event) {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            mode === "manual" ? submitManual() : submitAi();
        }
    }

    $: canSaveManual = !!form.title.trim() && !!columnId && !saving;
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="wrap" data-theme={theme}>
    {#if result}
        <div class="result">
            <p class="result-title">
                Criada em <strong>{result.board}</strong> / {result.column}
            </p>
            <p class="result-task">{result.title}</p>
            <button class="link-btn" on:click={another}>Criar outra →</button>
        </div>
    {:else}
        <div class="tabs" role="tablist">
            <button
                role="tab"
                aria-selected={mode === "manual"}
                class="tab"
                class:active={mode === "manual"}
                on:click={() => setMode("manual")}>Manual</button
            >
            <button
                role="tab"
                aria-selected={mode === "ai"}
                class="tab"
                class:active={mode === "ai"}
                on:click={() => setMode("ai")}>IA</button
            >
        </div>

        {#if mode === "manual"}
            <input
                class="field title-field"
                bind:value={form.title}
                placeholder="Título da tarefa"
                disabled={saving}
            />

            <div class="section">
                <span class="label">Descrição</span>
                <textarea
                    class="field textarea"
                    bind:value={form.description}
                    placeholder="Adicionar descrição…"
                    rows="2"
                    disabled={saving}
                    on:input={reportHeight}
                ></textarea>
            </div>

            <div class="grid">
                <div class="prop">
                    <span class="label">Board</span>
                    <select
                        class="field"
                        bind:value={boardId}
                        on:change={onBoardChange}
                        disabled={saving || loadingBoards}
                    >
                        {#each boards as b}
                            <option value={b.id}>{b.name}</option>
                        {/each}
                    </select>
                </div>
                <div class="prop">
                    <span class="label">Coluna</span>
                    <select
                        class="field"
                        bind:value={columnId}
                        disabled={saving || !columns.length}
                    >
                        {#each columns as c}
                            <option value={c.id}>{c.name}</option>
                        {/each}
                    </select>
                </div>
                <div class="prop">
                    <span class="label">Prioridade</span>
                    <select
                        class="field"
                        bind:value={form.priority}
                        disabled={saving}
                    >
                        <option value="low">Baixa</option>
                        <option value="medium">Média</option>
                        <option value="high">Alta</option>
                        <option value="urgent">Urgente</option>
                    </select>
                </div>
                <div class="prop">
                    <span class="label">Vencimento</span>
                    <input
                        type="datetime-local"
                        class="field"
                        bind:value={form.dueDate}
                        disabled={saving}
                    />
                </div>
            </div>

            <div class="section">
                <span class="label">Tags</span>
                <input
                    type="text"
                    class="field"
                    bind:value={form.tags}
                    placeholder="frontend, bug"
                    disabled={saving}
                />
            </div>

            {#if error}<p class="error">{error}</p>{/if}

            <button
                class="submit-btn"
                on:click={submitManual}
                disabled={!canSaveManual}
            >
                {saving ? "Salvando…" : "Criar"}
            </button>
        {:else}
            <textarea
                class="field textarea"
                placeholder="Descreva a task…"
                bind:value={text}
                rows="3"
                disabled={saving}
                on:input={reportHeight}
            ></textarea>
            <p class="hint">A IA escolhe board, coluna, prioridade e tags.</p>

            {#if error}<p class="error">{error}</p>{/if}

            <button
                class="submit-btn"
                on:click={submitAi}
                disabled={!text.trim() || saving}
            >
                {saving ? "Pensando…" : "Criar"}
            </button>
        {/if}
    {/if}
</div>

<style>
    :global(html), :global(body) { margin: 0; padding: 0; background: transparent; overflow-x: hidden; }
    :global(*) { box-sizing: border-box; }

    .wrap {
        font-family: var(--tk-font);
        font-size: 13px;
        color: var(--tk-text);
        padding: 4px 2px;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .wrap[data-theme="dark"] {
        --tk-surface: #181818;
        --tk-surface-2: #1f1f1f;
        --tk-border: rgba(255, 255, 255, 0.09);
        --tk-border-hi: rgba(255, 255, 255, 0.16);
        --tk-text: #f5f5f5;
        --tk-muted: #888888;
        --tk-muted-2: rgba(136, 136, 136, 0.5);
        --tk-accent: #f5f5f5;
        --tk-on-accent: #111111;
        --tk-radius-md: 8px;
        --tk-radius-lg: 14px;
        --tk-font: 'Ubuntu', system-ui, sans-serif;
    }
    .wrap[data-theme="light"] {
        --tk-surface: #f5f5f5;
        --tk-surface-2: #ececec;
        --tk-border: rgba(0, 0, 0, 0.1);
        --tk-border-hi: rgba(0, 0, 0, 0.18);
        --tk-text: #1a1a1a;
        --tk-muted: #666666;
        --tk-muted-2: rgba(0, 0, 0, 0.4);
        --tk-accent: #111111;
        --tk-on-accent: #ffffff;
        --tk-radius-md: 8px;
        --tk-radius-lg: 14px;
        --tk-font: 'Ubuntu', system-ui, sans-serif;
    }

    .tabs {
        display: flex;
        gap: 2px;
        padding: 2px;
        background: var(--tk-surface);
        border: 1px solid var(--tk-border);
        border-radius: var(--tk-radius-md);
    }
    .tab {
        flex: 1;
        height: 26px;
        border: none;
        border-radius: 6px;
        background: none;
        color: var(--tk-muted);
        font-family: inherit;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.12s;
    }
    .tab:hover { color: var(--tk-text); }
    .tab.active {
        background: var(--tk-surface-2);
        color: var(--tk-text);
        font-weight: 600;
    }

    .section { display: flex; flex-direction: column; gap: 5px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .prop { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .label {
        font-size: 10px;
        font-weight: 600;
        color: var(--tk-muted-2);
        text-transform: uppercase;
        letter-spacing: 0.06em;
    }

    .field {
        width: 100%;
        height: 32px;
        padding: 0 9px;
        background: var(--tk-surface-2);
        border: 1px solid var(--tk-border);
        border-radius: var(--tk-radius-md);
        color: var(--tk-text);
        font-family: inherit;
        font-size: 12.5px;
        outline: none;
    }
    .field:focus { border-color: var(--tk-border-hi); }
    .field::placeholder { color: var(--tk-muted-2); }
    .field:disabled { opacity: 0.5; }
    .title-field { height: 34px; font-size: 13.5px; font-weight: 600; }
    .textarea {
        height: auto;
        padding: 8px 9px;
        resize: vertical;
        line-height: 1.5;
    }

    .hint { margin: 0; font-size: 11px; color: var(--tk-muted-2); }
    .error { margin: 0; font-size: 11px; color: #f43f5e; }

    .submit-btn {
        align-self: flex-end;
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        color: var(--tk-on-accent);
        background: var(--tk-accent);
        border: none;
        border-radius: var(--tk-radius-md);
        padding: 7px 14px;
        cursor: pointer;
    }
    .submit-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .result {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 10px 12px;
        border: 1px solid var(--tk-border);
        border-radius: var(--tk-radius-lg);
        background: var(--tk-surface);
    }
    .result-title { margin: 0; font-size: 11px; color: var(--tk-muted); }
    .result-title strong { color: var(--tk-text); }
    .result-task { margin: 0; font-size: 13px; font-weight: 600; }
    .link-btn {
        align-self: flex-start;
        margin-top: 4px;
        font-family: inherit;
        font-size: 11.5px;
        font-weight: 500;
        color: var(--tk-muted);
        background: transparent;
        border: none;
        padding: 0;
        cursor: pointer;
    }
    .link-btn:hover { color: var(--tk-text); }
</style>
