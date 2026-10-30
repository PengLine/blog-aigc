import { listTasks, getTask, cancelTask, retryTask, createWork } from '../core/api.js';
import { TASK_TYPES, KINDS, statusMeta } from '../core/constants.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast, emptyState, renderPagination, skeletonRows, confirmDialog, openModal, closeModal, copyText, videoStage } from '../core/ui.js';
import { escapeHtml, num, timeAgo, fmtDate } from '../core/format.js';
import { on, EVENTS } from '../core/bus.js';

const TABS = [
    { id: 'all', name: '全部' },
    { id: 'running', name: '运行中' },
    { id: 'queued', name: '排队中' },
    { id: 'succeeded', name: '已完成' },
    { id: 'failed', name: '失败' }
];

export async function render(host, ctx) {
    setPageTitle('任务中心');
    const state = {
        status: ctx.query.status || 'all',
        type: ctx.query.type || 'all',
        page: 1,
        pageSize: 12,
        counts: {},
        items: []
    };

    host.innerHTML = `
        <div class="page-head">
            <div class="page-head-main">
                <h1 class="page-title">任务中心</h1>
                <div class="page-sub">生成、训练、工作流与应用运行都在这里排队执行，失败会自动退还算力</div>
            </div>
            <div class="page-actions">
                <a class="btn btn-outline" href="${url('assets/create-character.html')}">${icon('plus', 15)}新建生成任务</a>
                <button class="btn btn-outline" id="refreshBtn">${icon('refresh', 15)}刷新</button>
            </div>
        </div>

        <div class="grid cols-4" style="margin-bottom:16px" id="summaryRow"></div>

        <div class="card" style="padding:12px 14px;margin-bottom:14px">
            <div class="asset-toolbar">
                <div class="tabs" id="statusTabs" style="border:none;margin:0">
                    ${TABS.map((t) => `<button class="tab ${state.status === t.id ? 'active' : ''}" data-status="${t.id}">${t.name}<span class="count" data-count="${t.id}">0</span></button>`).join('')}
                </div>
                <span class="spacer"></span>
                <select class="select input-sm" id="typeFilter" style="width:132px" aria-label="任务类型">
                    <option value="all">全部类型</option>
                    ${Object.entries(TASK_TYPES).filter(([k]) => k !== 'review').map(([k, v]) => `<option value="${k}" ${state.type === k ? 'selected' : ''}>${v.name}</option>`).join('')}
                </select>
            </div>
        </div>

        <div class="card" id="taskList">${skeletonRows(6)}</div>
        <div class="pagination" id="taskPager" style="margin-top:16px"></div>`;

    const listEl = host.querySelector('#taskList');
    const pagerEl = host.querySelector('#taskPager');
    const tabsEl = host.querySelector('#statusTabs');
    const summaryEl = host.querySelector('#summaryRow');

    let reloadTimer = null;

    async function load(silent = false) {
        if (!silent) listEl.innerHTML = skeletonRows(6);
        try {
            const res = await listTasks({ status: state.status, type: state.type, page: state.page, pageSize: state.pageSize });
            state.items = res.items;
            state.counts = res.counts;
            paintSummary(res);
            paintTabs(res);
            if (!res.items.length) {
                listEl.innerHTML = emptyState({
                    title: '没有任务',
                    desc: state.status === 'all' ? '发起一次生成或运行应用，任务会出现在这里。' : '当前筛选条件下没有任务。',
                    action: `<a class="btn btn-primary" href="${url('assets/create-character.html')}">${icon('plus', 14)}开始创作</a>`
                });
                pagerEl.innerHTML = '';
                return;
            }
            listEl.innerHTML = `<div style="padding:4px 8px">${res.items.map(rowHtml).join('')}</div>`;
            renderPagination(pagerEl, {
                page: res.page,
                pages: res.pages,
                total: res.total,
                pageSize: res.pageSize,
                onChange: (page) => {
                    state.page = page;
                    load();
                }
            });
        } catch (err) {
            listEl.innerHTML = emptyState({ title: '任务加载失败', desc: err.message, action: '<button class="btn btn-outline" data-retry>重试</button>' });
        }
    }

    function paintSummary(res) {
        const c = res.counts || {};
        const active = (c.running || 0) + (c.queued || 0);
        summaryEl.innerHTML = `
            ${statCard('全部任务', c.all || 0, '含已完成与失败', 'layers')}
            ${statCard('进行中', active, `${c.running || 0} 运行 · ${c.queued || 0} 排队`, 'zap')}
            ${statCard('已完成', c.succeeded || 0, '产物可在详情查看', 'check')}
            ${statCard('失败', c.failed || 0, '失败自动退款', 'alert')}`;
    }

    function paintTabs(res) {
        const c = res.counts || {};
        tabsEl.querySelectorAll('[data-count]').forEach((el) => {
            const key = el.dataset.count;
            el.textContent = key === 'all' ? c.all || 0 : c[key] || 0;
        });
    }

    function rowHtml(task) {
        const st = statusMeta(task.status);
        const type = TASK_TYPES[task.type] || { name: '任务', icon: 'zap' };
        const running = ['queued', 'running'].includes(task.status);
        return `<div class="task-row" data-task="${task.id}">
            <span class="task-icon" style="background:var(--brand-50);color:var(--brand-600)">${icon(type.icon, 16)}</span>
            <div class="task-main">
                <div class="task-title">${escapeHtml(task.title)}
                    <span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${st.label}</span>
                </div>
                <div class="task-sub">${type.name} · 消耗 ${task.cost} 算力 · ${timeAgo(task.createdAt)}
                    ${task.outputs?.length ? ` · ${task.outputs.length} 个产物` : ''}</div>
                ${running ? `<div class="task-bar">${progressBar(task.progress)}
                    <span class="small muted">${escapeHtml((task.logs || []).slice(-1)[0]?.msg || '等待调度')}</span></div>` : ''}
                ${task.status === 'failed' ? `<div class="small" style="color:var(--danger);margin-top:4px">${escapeHtml(task.error || '任务执行失败')}</div>` : ''}
            </div>
            <div class="task-actions">
                <button class="btn btn-sm btn-ghost" data-act="detail" data-id="${task.id}">${icon('info', 14)}详情</button>
                ${running ? `<button class="btn btn-sm btn-ghost" data-act="cancel" data-id="${task.id}">${icon('stop', 14)}取消</button>` : ''}
                ${['failed', 'canceled'].includes(task.status) ? `<button class="btn btn-sm btn-outline" data-act="retry" data-id="${task.id}">${icon('refresh', 14)}重试</button>` : ''}
                ${task.status === 'succeeded' && task.outputs?.length ? `<button class="btn btn-sm btn-outline" data-act="detail" data-id="${task.id}">${icon('eye', 14)}查看结果</button>` : ''}
            </div>
        </div>`;
    }

    listEl.addEventListener('click', async (e) => {
        if (e.target.closest('[data-retry]')) {
            load();
            return;
        }
        const btn = e.target.closest('[data-act]');
        if (!btn) {
            const row = e.target.closest('[data-task]');
            if (row && !e.target.closest('button')) showDetail(row.dataset.task);
            return;
        }
        const { act, id } = btn.dataset;
        if (act === 'detail') return showDetail(id);
        if (act === 'cancel') {
            const ok = await confirmDialog({ title: '取消任务', message: '任务取消后会立即停止执行，并按消耗退还算力。', confirmText: '取消任务', danger: true });
            if (!ok) return;
            try {
                await cancelTask(id);
                toast('任务已取消，算力已退还', 'success');
                load();
            } catch (err) {
                toast(err.message, 'error');
            }
            return;
        }
        if (act === 'retry') {
            try {
                const task = await retryTask(id);
                toast('已重新提交任务', 'success');
                load();
                scheduleReload();
                void task;
            } catch (err) {
                toast(err.message, 'error');
            }
        }
    });

    async function showDetail(id) {
        try {
            const task = await getTask(id);
            const st = statusMeta(task.status);
            const type = TASK_TYPES[task.type] || { name: '任务' };
            openModal({
                title: `${type.name} · ${task.title}`,
                size: 'lg',
                body: `<div class="col" style="gap:12px">
                    <div class="row wrap" style="gap:8px">
                        <span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${st.label}</span>
                        <span class="tag">${task.id}</span>
                        <span class="tag">${task.cost} 算力</span>
                        <span class="tag">${fmtDate(task.createdAt, true)}</span>
                    </div>
                    <div>
                        <div class="row between small" style="margin-bottom:6px"><span class="muted">进度</span><b>${task.progress || 0}%</b></div>
                        ${progressBar(task.progress, task.status === 'failed' ? 'danger' : task.status === 'succeeded' ? 'ok' : '')}
                    </div>
                    ${task.error ? `<div class="result-box" style="color:var(--danger)">${escapeHtml(task.error)}</div>` : ''}
                    ${(task.outputs || []).length ? `<div>
                        <div class="label" style="margin-bottom:6px">产物</div>
                        <div class="result-grid">
                            ${task.outputs.map((o) => o.type === 'image'
                    ? `<img src="${escapeHtml(o.url)}" alt="${escapeHtml(o.title || '产物')}" loading="lazy">`
                    : o.type === 'video'
                        ? videoStage(o, { title: task.title, prompt: task.payload?.prompt || '', extra: 'style="width:100%;border-radius:10px"' })
                        : `<div class="result-box small" style="white-space:pre-wrap">${escapeHtml(o.text || o.title || o.workId || '')}</div>`).join('')}
                        </div>
                    </div>` : ''}
                    <div>
                        <div class="label" style="margin-bottom:6px">执行日志</div>
                        <div class="log-panel">
                            ${(task.logs || []).map((l) => `<div class="log-line ${l.level === 'warn' ? 'warn' : l.level === 'error' ? 'err' : ''}">
                                <span class="t">${escapeHtml(l.t || '')}</span><span class="m">${escapeHtml(l.msg || '')}</span>
                            </div>`).join('') || '<div class="small muted">暂无日志</div>'}
                        </div>
                    </div>
                </div>`,
                footer: `${task.payload?.prompt ? `<button class="btn btn-outline" data-x="copy">${icon('copy', 14)}复制提示词</button>` : ''}
                    ${task.payload?.prompt ? `<a class="btn btn-outline" href="${againHref(task)}">${icon('refresh', 14)}再创作</a>` : ''}
                    ${hasMedia(task) ? `<button class="btn btn-primary" data-x="save">${icon('download', 14)}存为资产</button>` : ''}
                    <button class="btn btn-ghost" data-close>关闭</button>`,
                onMount(card) {
                    card.querySelector('[data-x="copy"]')?.addEventListener('click', () => copyText(task.payload.prompt));
                    card.querySelector('[data-x="save"]')?.addEventListener('click', () => saveOutput(task));
                }
            });
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /** 产物存为资产（与运行工作台一致：先选类型与名称，落为草稿） */
    function saveOutput(task) {
        const out = (task.outputs || []).find((o) => ['image', 'video'].includes(o.type));
        if (!out) {
            toast('该任务没有可入库的图像或视频产物', 'warn');
            return;
        }
        const kinds = ['character', 'prop', 'scenic'];
        closeModal();
        openModal({
            title: '保存为资产',
            size: 'sm',
            body: `<div class="col" style="gap:12px">
                <div class="field" style="margin:0">
                    <label class="label">资产名称</label>
                    <input class="input" id="svTitle" maxlength="40" value="${escapeHtml(`${task.title} · ${new Date().toLocaleDateString('zh-CN')}`)}">
                </div>
                <div class="field" style="margin:0">
                    <label class="label">资产类型</label>
                    <select class="select" id="svKind">
                        ${kinds.map((k) => `<option value="${k}">${KINDS[k].name}</option>`).join('')}
                    </select>
                </div>
                <div class="field" style="margin:0">
                    <label class="label">备注</label>
                    <textarea class="textarea" id="svDesc" style="min-height:64px">由任务「${escapeHtml(task.title)}」产出，可继续在创作中心迭代。</textarea>
                </div>
            </div>`,
            footer: `<button class="btn btn-outline" data-close>取消</button>
                     <button class="btn btn-primary" id="svOk">保存草稿</button>`,
            onMount(card) {
                card.querySelector('#svOk').addEventListener('click', async () => {
                    const title = card.querySelector('#svTitle').value.trim();
                    const kind = card.querySelector('#svKind').value;
                    if (!title) {
                        toast('请填写资产名称', 'error');
                        return;
                    }
                    try {
                        const res = await createWork({
                            kind,
                            title,
                            desc: card.querySelector('#svDesc').value.trim(),
                            subtype: 'other',
                            cover: out.url,
                            mediaUrl: out.type === 'video' ? out.url : null,
                            tags: [TASK_TYPES[task.type]?.name || '任务产物'],
                            prompt: task.payload?.prompt || '',
                            params: { model: task.payload?.model || 'lingxi-xl' },
                            price: { mode: 'free', amount: 0 },
                            visibility: 'public',
                            status: 'draft'
                        });
                        closeModal();
                        toast('已保存到资产库（草稿）', 'success');
                        window.setTimeout(() => {
                            window.location.href = `${url(KINDS[kind].detail)}?id=${res.work.id}`;
                        }, 600);
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                });
            }
        });
    }

    tabsEl.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-status]');
        if (!tab) return;
        state.status = tab.dataset.status;
        state.page = 1;
        tabsEl.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el === tab));
        load();
    });

    host.querySelector('#typeFilter')?.addEventListener('change', (e) => {
        state.type = e.target.value;
        state.page = 1;
        load();
    });

    host.querySelector('#refreshBtn')?.addEventListener('click', () => load());

    on(EVENTS.taskUpdate, () => scheduleReload());

    function scheduleReload() {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => load(true), 500);
    }

    await load();

    if (ctx.query.id) {
        showDetail(ctx.query.id);
    }
}

function statCard(label, value, sub, iconName) {
    return `<div class="metric">
        <div class="row" style="gap:8px">
            <span style="width:28px;height:28px;border-radius:8px;background:var(--brand-50);color:var(--brand-600);display:inline-flex;align-items:center;justify-content:center">${icon(iconName, 14)}</span>
            <span class="metric-label">${escapeHtml(label)}</span>
        </div>
        <div class="metric-value">${num(value)}</div>
        <div class="metric-trend">${escapeHtml(sub)}</div>
    </div>`;
}

function progressBar(value, tone = '') {
    return `<div class="progress ${tone} progress-sm"><i style="width:${Math.max(2, Math.min(100, value || 0))}%"></i></div>`;
}

function hasMedia(task) {
    return (task.outputs || []).some((o) => ['image', 'video'].includes(o.type));
}

/** 再创作：按任务类型落回对应创作台，并携带提示词与模型 */
function againHref(task) {
    const prompt = task.payload?.prompt || '';
    const page = task.type === 'video'
        ? 'assets/create-video.html'
        : task.type === 'train'
            ? 'lora-train.html'
            : 'assets/create-scenic.html';
    if (task.type === 'train') return url(page);
    const qs = `?prompt=${encodeURIComponent(prompt)}${task.payload?.model ? `&model=${encodeURIComponent(task.payload.model)}` : ''}`;
    return `${url(page)}${qs}`;
}
