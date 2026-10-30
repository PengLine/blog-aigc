import { getApp, runApp, getTask, getAccount, createWork } from '../core/api.js';
import { statusMeta, KINDS } from '../core/constants.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast, openModal, closeModal, emptyState, copyText, videoStage } from '../core/ui.js';
import { escapeHtml, num, timeAgo } from '../core/format.js';
import { on, EVENTS } from '../core/bus.js';

export async function render(host, ctx) {
    setPageTitle('运行应用');
    let data;
    try {
        data = await getApp(ctx.query.id);
    } catch (err) {
        host.innerHTML = emptyState({
            title: '应用不可用',
            desc: err.message,
            action: `<a class="btn btn-primary" href="${url('app/ai-apps.html')}">返回应用广场</a>`
        });
        return;
    }

    const { app, runs } = data;
    const account = await getAccount();
    setPageTitle(`运行 · ${app.name}`);

    const state = {
        taskId: null,
        task: null,
        polling: null,
        unsubscribe: null
    };

    host.innerHTML = `
        <div class="page-head">
            <div class="page-head-main" style="display:flex;gap:12px;align-items:flex-start">
                <a class="icon-btn" href="${url(`app/ai-app-detail.html?id=${app.id}`)}" title="返回详情" style="margin-top:4px">${icon('arrow-left', 18)}</a>
                <div>
                    <h1 class="page-title">${escapeHtml(app.name)}
                        <span class="badge badge-violet">${escapeHtml(app.version)}</span></h1>
                    <div class="page-sub">填写参数后提交，任务将在算力队列中执行，可随时切换到其他页面</div>
                </div>
            </div>
            <div class="page-actions">
                <a class="btn btn-outline" href="${url('tasks.html')}">${icon('clock', 15)}任务中心</a>
                <span class="balance-chip">${icon('credit', 14)} <b id="balanceText">${num(account.credits)}</b></span>
                <button class="btn btn-primary" id="runBtn">${icon('rocket', 15)}运行（${app.price} 算力）</button>
            </div>
        </div>

        <div class="run-layout">
            <div class="run-panel" id="formPanel">
                <div class="run-panel-head">
                    <div>
                        <div class="card-title">参数配置</div>
                        <div class="card-sub">${app.inputs.filter((f) => f.required).length} 个必填项</div>
                    </div>
                    <div class="spacer"></div>
                    <button class="btn btn-sm btn-ghost" id="resetForm">${icon('refresh', 13)}重置默认值</button>
                </div>
                <div class="run-panel-body">
                    <form id="appForm" class="col" style="gap:14px">
                        ${app.inputs.map(fieldHtml).join('')}
                    </form>
                    <div class="card" style="padding:12px 14px;margin-top:14px;background:var(--bg-soft)">
                        <div class="row between small"><span class="muted">单次消耗</span><b>${app.price} 算力</b></div>
                        <div class="row between small" style="margin-top:6px"><span class="muted">底层模型</span><span>${escapeHtml(app.model)}</span></div>
                        <div class="row between small" style="margin-top:6px"><span class="muted">失败处理</span><span>自动退款</span></div>
                    </div>
                </div>
            </div>

            <div class="card" id="resultPanel">
                <div class="run-panel-head">
                    <div>
                        <div class="card-title">运行结果</div>
                        <div class="card-sub" id="runSub">尚未运行</div>
                    </div>
                    <div class="spacer"></div>
                    <span id="runState"></span>
                </div>
                <div class="run-panel-body" id="resultBody">
                    ${emptyState({
                        title: '等待运行',
                        desc: '填写左侧参数并点击右上角「运行」，结果会实时显示在这里。',
                        action: ''
                    })}
                </div>
                <div class="card-head" style="border-top:1px solid var(--border)">
                    <div class="card-title">最近运行</div>
                    <div class="spacer"></div>
                    <a class="small" href="${url('tasks.html?type=app')}" style="color:var(--brand)">全部记录 ${icon('chevron-right', 12)}</a>
                </div>
                <div class="card-body" id="historyBody" style="padding-top:4px">
                    ${runs.length ? runs.map(historyRow).join('') : '<div class="small muted" style="padding:12px 0">暂无运行记录</div>'}
                </div>
            </div>
        </div>`;

    const form = host.querySelector('#appForm');
    const resultBody = host.querySelector('#resultBody');
    const runState = host.querySelector('#runState');
    const runSub = host.querySelector('#runSub');
    const balanceText = host.querySelector('#balanceText');

    form.querySelectorAll('input[type="range"]').forEach((input) => {
        const output = form.querySelector(`[data-range-value="${input.dataset.input}"]`);
        input.addEventListener('input', () => {
            if (output) output.textContent = input.value;
        });
    });

    form.querySelectorAll('.switch[data-name]').forEach((el) => {
        el.addEventListener('click', () => el.classList.toggle('on'));
    });

    host.querySelector('#resetForm')?.addEventListener('click', () => {
        app.inputs.forEach((field) => {
            const el = form.querySelector(`[data-input="${field.key}"]`);
            if (!el) return;
            if (field.type === 'switch') {
                el.classList.toggle('on', !!field.default);
            } else {
                el.value = field.default ?? '';
                if (field.type === 'range') {
                    const output = form.querySelector(`[data-range-value="${field.key}"]`);
                    if (output) output.textContent = el.value;
                }
            }
        });
        toast('已恢复默认参数');
    });

    host.querySelector('#runBtn')?.addEventListener('click', () => submit());
    host.querySelector('#historyBody')?.addEventListener('click', (e) => {
        const item = e.target.closest('[data-task]');
        if (!item) return;
        loadTask(item.dataset.task);
    });

    form.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
    });

    function collect() {
        const inputs = {};
        app.inputs.forEach((field) => {
            const el = form.querySelector(`[data-input="${field.key}"]`);
            if (!el) return;
            if (field.type === 'switch') inputs[field.key] = el.classList.contains('on');
            else if (field.type === 'range' || field.type === 'number') inputs[field.key] = Number(el.value);
            else inputs[field.key] = el.value.trim();
        });
        return inputs;
    }

    async function submit() {
        const inputs = collect();
        const missing = app.inputs.filter((f) => f.required && !String(inputs[f.key] || '').trim());
        if (missing.length) {
            toast(`请填写「${missing[0].label}」`, 'error');
            const el = form.querySelector(`[data-input="${missing[0].key}"]`);
            el?.focus();
            return;
        }
        const btn = host.querySelector('#runBtn');
        btn.classList.add('loading');
        btn.disabled = true;
        try {
            const task = await runApp(app.id, inputs);
            toast('任务已提交，正在排队', 'success');
            const next = await getAccount();
            balanceText.textContent = num(next.credits);
            watch(task);
            prependHistory(task);
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            btn.classList.remove('loading');
            btn.disabled = false;
        }
    }

    function watch(task) {
        stopWatch();
        state.task = task;
        state.taskId = task.id;
        paint(task);
        state.unsubscribe = on(EVENTS.taskUpdate, (t) => {
            if (t && t.id === state.taskId) paint(t);
        });
        state.polling = setInterval(async () => {
            if (!state.taskId) return;
            try {
                const latest = await getTask(state.taskId);
                paint(latest);
            } catch (err) {
                console.warn(err);
            }
        }, 1600);
    }

    function stopWatch() {
        if (state.polling) clearInterval(state.polling);
        if (state.unsubscribe) state.unsubscribe();
        state.polling = null;
        state.unsubscribe = null;
    }

    async function loadTask(id) {
        try {
            const task = await getTask(id);
            state.task = task;
            state.taskId = task.id;
            paint(task);
            if (['queued', 'running'].includes(task.status)) watch(task);
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    function paint(task) {
        state.task = task;
        const st = statusMeta(task.status);
        runState.innerHTML = `<span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${st.label}</span>`;
        runSub.textContent = `任务 ${task.id} · ${timeAgo(task.createdAt)} · 消耗 ${task.cost} 算力`;

        const running = ['queued', 'running'].includes(task.status);
        resultBody.innerHTML = `
            <div class="row" style="gap:10px;margin-bottom:12px">
                <div class="progress ${task.status === 'failed' ? 'danger' : task.status === 'succeeded' ? 'ok' : ''}" style="flex:1"><i style="width:${Math.max(2, task.progress || 0)}%"></i></div>
                <b class="small" style="width:44px;text-align:right">${task.progress || 0}%</b>
            </div>
            <div class="row small muted" style="gap:12px;margin-bottom:12px">
                <span>${icon('cpu', 12)} ${escapeHtml(task.title)}</span>
                ${task.finishedAt ? `<span>${icon('clock', 12)} ${timeAgo(task.finishedAt)}完成</span>` : ''}
            </div>
            ${task.error ? `<div class="card" style="padding:10px 12px;background:var(--danger-bg);border-color:#fecaca;margin-bottom:12px">
                <div class="row small" style="color:var(--danger)">${icon('alert', 14)}<span>${escapeHtml(task.error)}</span></div>
            </div>` : ''}
            ${outputsHtml(task, running)}
            <div class="log-panel" style="margin-top:12px">
                ${(task.logs || []).slice(-8).map((l) => `<div class="log-line ${l.level === 'warn' ? 'warn' : l.level === 'error' ? 'err' : ''}">
                    <span class="t">${escapeHtml(l.t || '')}</span><span class="m">${escapeHtml(l.msg || '')}</span>
                </div>`).join('')}
            </div>`;

        resultBody.querySelectorAll('[data-copy-text]').forEach((btn) => {
            btn.addEventListener('click', () => copyText(btn.dataset.copyText, '已复制结果'));
        });
        resultBody.querySelectorAll('[data-save]').forEach((btn) => {
            btn.addEventListener('click', () => saveAsAsset(btn.dataset.save, btn.dataset.type || 'image'));
        });

        if (!running) stopWatch();
    }

    function outputsHtml(task, running) {
        if (running && !task.outputs?.length) {
            return `<div class="result-box row" style="gap:10px;color:var(--muted)">
                ${icon('sparkles', 16)}<span class="small">正在生成，可离开页面，稍后在任务中心查看结果</span>
            </div>`;
        }
        if (!task.outputs?.length) return '';
        const images = task.outputs.filter((o) => o.type === 'image');
        const videos = task.outputs.filter((o) => o.type === 'video');
        const texts = task.outputs.filter((o) => o.type === 'text');
        const models = task.outputs.filter((o) => o.type === 'model');
        return `
            ${images.length ? `<div class="result-grid">
                ${images.map((o) => `<div style="position:relative">
                    <img src="${escapeHtml(o.url)}" alt="${escapeHtml(o.title || '生成结果')}" loading="lazy" data-fb-title="${escapeHtml(o.title || '生成结果')}" onerror="this.onerror=null;if(window.__coverFallback)this.src=window.__coverFallback(this.dataset.fbTitle)">
                    <button class="btn btn-sm btn-outline" data-save="${escapeHtml(o.url)}" data-type="image"
                        style="position:absolute;right:6px;bottom:6px;background:var(--surface);color:var(--text)">${icon('layers', 12)}存为资产</button>
                </div>`).join('')}
            </div>` : ''}
            ${videos.length ? videos.map((o) => `<div class="result-box" style="padding:0;overflow:hidden">
                ${videoStage(o, { title: o.title })}
            </div>`).join('') : ''}
            ${texts.map((o) => `<div class="result-box">
                <div class="row between" style="margin-bottom:8px">
                    <b class="small">${escapeHtml(o.title || '文本结果')}</b>
                    <button class="btn btn-sm btn-ghost" data-copy-text="${escapeHtml(o.text)}">${icon('copy', 13)}复制</button>
                </div>
                <div class="small" style="white-space:pre-wrap;line-height:1.8;color:var(--text-2)">${escapeHtml(o.text)}</div>
            </div>`).join('')}
            ${models.map((o) => `<div class="result-box row" style="justify-content:space-between">
                <span class="small">${icon('cpu', 14)} ${escapeHtml(o.title)}</span>
                <a class="btn btn-sm btn-outline" href="${url(`assets/model-detail.html?id=${o.workId}`)}">查看模型</a>
            </div>`).join('')}`;
    }

    function saveAsAsset(coverUrl, type) {
        const imageKinds = ['character', 'prop', 'scenic'];
        const inputs = collect();
        const prompt = inputs.prompt || inputs.story || inputs.product || app.name;
        openModal({
            title: '保存为资产',
            size: 'sm',
            body: `<div class="col" style="gap:12px">
                <div class="field" style="margin:0">
                    <label class="label">资产名称</label>
                    <input class="input" id="svTitle" value="${escapeHtml(`${app.name} · ${new Date().toLocaleDateString('zh-CN')}`)}" maxlength="40">
                </div>
                <div class="field" style="margin:0">
                    <label class="label">资产类型</label>
                    <select class="select" id="svKind">
                        ${imageKinds.map((k) => `<option value="${k}">${KINDS[k].name}</option>`).join('')}
                    </select>
                </div>
                <div class="field" style="margin:0">
                    <label class="label">备注</label>
                    <textarea class="textarea" id="svDesc" style="min-height:64px">由「${escapeHtml(app.name)}」生成，可继续在创作中心迭代。</textarea>
                </div>
            </div>`,
            footer: `<button class="btn btn-outline" data-close>取消</button>
                     <button class="btn btn-primary" id="svOk">保存草稿</button>`,
            onMount(card, root) {
                root.querySelector('[data-close]')?.addEventListener('click', closeModal);
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
                            cover: coverUrl,
                            mediaUrl: type === 'video' ? coverUrl : null,
                            tags: [app.name, '应用生成'],
                            prompt,
                            params: { model: app.model },
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

    function prependHistory(task) {
        const body = host.querySelector('#historyBody');
        const row = document.createElement('a');
        row.className = 'history-item';
        row.href = 'javascript:void(0)';
        row.dataset.task = task.id;
        row.innerHTML = `<span class="badge badge-warn">排队中</span>
            <div style="min-width:0;flex:1"><div class="small ellipsis">${escapeHtml(task.title)}</div>
            <div class="small muted">${timeAgo(task.createdAt)}</div></div>`;
        body.querySelector('.small.muted')?.remove();
        body.prepend(row);
    }

    await getAccount().then((a) => {
        balanceText.textContent = num(a.credits);
    }).catch(() => {});

    if (ctx.query.task) loadTask(ctx.query.task);
}

function fieldHtml(field) {
    const common = `data-input="${escapeHtml(field.key)}"`;
    if (field.type === 'textarea') {
        return `<div class="field" style="margin:0">
            <label class="label">${escapeHtml(field.label)}${field.required ? '<span class="req">*</span>' : ''}</label>
            <textarea class="textarea" ${common} style="min-height:104px" placeholder="${escapeHtml(field.placeholder || '')}">${escapeHtml(String(field.default ?? ''))}</textarea>
            ${field.help ? `<div class="hint">${escapeHtml(field.help)}</div>` : ''}
        </div>`;
    }
    if (field.type === 'select') {
        return `<div class="field" style="margin:0">
            <label class="label">${escapeHtml(field.label)}</label>
            <select class="select" ${common}>
                ${(field.options || []).map((o) => `<option value="${escapeHtml(o.value)}" ${field.default === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
            </select>
            ${field.help ? `<div class="hint">${escapeHtml(field.help)}</div>` : ''}
        </div>`;
    }
    if (field.type === 'range') {
        return `<div class="field" style="margin:0">
            <label class="label">${escapeHtml(field.label)}
                <span class="hint-inline" data-range-value="${escapeHtml(field.key)}">${field.default ?? field.min ?? 0}</span></label>
            <input class="range" type="range" ${common} min="${field.min ?? 0}" max="${field.max ?? 100}" step="${field.step ?? 1}" value="${field.default ?? field.min ?? 0}">
            ${field.help ? `<div class="hint">${escapeHtml(field.help)}</div>` : ''}
        </div>`;
    }
    if (field.type === 'switch') {
        return `<div class="field" style="margin:0">
            <label class="label">${escapeHtml(field.label)}</label>
            <div class="row" style="gap:10px">
                <div class="switch ${field.default ? 'on' : ''}" data-name="${escapeHtml(field.key)}" ${common}></div>
                <span class="small muted">${escapeHtml(field.help || '开启后生效')}</span>
            </div>
        </div>`;
    }
    return `<div class="field" style="margin:0">
        <label class="label">${escapeHtml(field.label)}${field.required ? '<span class="req">*</span>' : ''}</label>
        <input class="input" type="${field.type === 'number' ? 'number' : 'text'}" ${common}
            value="${escapeHtml(String(field.default ?? ''))}" placeholder="${escapeHtml(field.placeholder || '')}">
        ${field.help ? `<div class="hint">${escapeHtml(field.help)}</div>` : ''}
    </div>`;
}

function historyRow(task) {
    const st = statusMeta(task.status);
    return `<a class="history-item" href="javascript:void(0)" data-task="${task.id}" style="display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
        <span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${st.label}</span>
        <div style="min-width:0;flex:1">
            <div class="small ellipsis">${escapeHtml(task.title)}</div>
            <div class="small muted">${timeAgo(task.createdAt)} · ${task.outputs?.length || 0} 个产物</div>
        </div>
        <span class="small muted">${task.cost} 算力</span>
    </a>`;
}
