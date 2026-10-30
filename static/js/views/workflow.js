import { listWorkflows, getWorkflow, runWorkflow, getTask, getAccount } from '../core/api.js';
import { statusMeta } from '../core/constants.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast, emptyState, copyText } from '../core/ui.js';
import { escapeHtml, num, timeAgo } from '../core/format.js';
import { on, EVENTS } from '../core/bus.js';

const NODE_ICONS = {
    prompt: 'wand',
    model: 'cpu',
    lora: 'layers',
    sampler: 'sliders',
    upscale: 'image',
    save: 'download',
    load: 'upload',
    video: 'video',
    controlnet: 'grid'
};

export async function render(host, ctx) {
    setPageTitle('工作流编排');
    const { items } = await listWorkflows();
    const initialId = ctx.query.id || ctx.query.workflow || items[0]?.id;
    let data = await getWorkflow(initialId);
    const account = await getAccount();

    const state = {
        workflowId: data.workflow.id,
        activeNode: data.workflow.nodes[0]?.id || '',
        taskId: null,
        polling: null,
        unsubscribe: null,
        count: 2
    };

    host.innerHTML = `
        <div class="page-head">
            <div class="page-head-main">
                <h1 class="page-title">工作流编排与执行</h1>
                <div class="page-sub">把编码、采样、放大、视频合成等节点串成可复用链路，一键批量产出</div>
            </div>
            <div class="page-actions">
                <span class="balance-chip">${icon('credit', 14)} <b id="wfBalance">${num(account.credits)}</b></span>
                <a class="btn btn-outline" href="${url('tasks.html?type=workflow')}">${icon('clock', 15)}执行记录</a>
                <a class="btn btn-primary" href="${url('app/ai-app-create.html')}">${icon('plus', 15)}封装为应用</a>
            </div>
        </div>
        <div class="wf-layout">
            <aside class="wf-side">
                <div class="card">
                    <div class="card-head"><div class="card-title">模板库</div><div class="spacer"></div><span class="badge">${items.length}</span></div>
                    <div class="card-body col" style="gap:8px" id="wfList"></div>
                </div>
                <div class="card">
                    <div class="card-head"><div class="card-title">执行记录</div></div>
                    <div class="card-body" id="runList" style="padding-top:4px"></div>
                </div>
            </aside>

            <div class="col" style="gap:14px;min-width:0">
                <div class="card">
                    <div class="wf-toolbar">
                        <div style="min-width:0">
                            <div class="row" style="gap:8px">
                                <b id="wfName" style="font-size:15px"></b>
                                <span class="badge badge-brand" id="wfVersion"></span>
                            </div>
                            <div class="small muted" id="wfDesc" style="margin-top:2px"></div>
                        </div>
                        <span class="spacer"></span>
                        <select class="select input-sm" id="wfCount" style="width:110px" aria-label="生成数量">
                            <option value="1">1 张</option>
                            <option value="2" selected>2 张</option>
                            <option value="4">4 张</option>
                        </select>
                        <button class="btn btn-outline btn-sm" id="copyId">${icon('copy', 13)}复制 ID</button>
                        <button class="btn btn-primary btn-sm" id="runWf">${icon('play', 13)}运行工作流</button>
                    </div>
                    <div class="wf-canvas" id="canvas"></div>
                </div>

                <div class="card">
                    <div class="card-head">
                        <div class="card-title">执行输出</div>
                        <div class="spacer"></div>
                        <span id="wfState"></span>
                    </div>
                    <div class="card-body" id="outputBody">
                        ${emptyState({ title: '尚未执行', desc: '点击右上角「运行工作流」，节点会按顺序点亮并产出结果。' })}
                    </div>
                </div>
            </div>

            <aside class="wf-inspector" id="inspector"></aside>
        </div>`;

    const canvas = host.querySelector('#canvas');
    const inspector = host.querySelector('#inspector');
    const wfList = host.querySelector('#wfList');
    const runList = host.querySelector('#runList');
    const outputBody = host.querySelector('#outputBody');
    const wfState = host.querySelector('#wfState');

    drawSide();
    drawWorkflow();
    drawRuns();

    function drawSide() {
        wfList.innerHTML = items.map((w) => `<button class="lib-item ${w.id === state.workflowId ? 'active' : ''}" data-wf="${w.id}"
            style="text-align:left;padding:10px;border-radius:10px;border:1px solid ${w.id === state.workflowId ? 'var(--brand-300)' : 'transparent'};background:${w.id === state.workflowId ? 'var(--brand-50)' : 'transparent'};width:100%">
            <div class="row" style="gap:8px">
                <span style="color:var(--brand-600)">${icon('workflow', 15)}</span>
                <div style="min-width:0">
                    <div class="small" style="font-weight:600">${escapeHtml(w.name)}</div>
                    <div class="small muted">${w.nodes.length} 节点 · ${num(w.runs)} 次运行</div>
                </div>
            </div>
        </button>`).join('');
    }

    function drawWorkflow() {
        const { workflow } = data;
        host.querySelector('#wfName').textContent = workflow.name;
        host.querySelector('#wfVersion').textContent = workflow.version;
        host.querySelector('#wfDesc').textContent = workflow.desc;

        canvas.innerHTML = workflow.nodes.map((node, i) => `<div class="wf-node ${state.activeNode === node.id ? 'active' : ''}" data-node="${node.id}">
            <div class="nd-head">
                <span class="badge">${i + 1}</span>
                <span style="color:var(--brand-600)">${icon(NODE_ICONS[node.type] || 'workflow', 14)}</span>
                <b class="small">${escapeHtml(node.title)}</b>
                <span class="spacer"></span>
                <span class="nd-status small muted">待执行</span>
            </div>
            <div class="nd-body small muted">${escapeHtml(describeNode(node))}</div>
        </div>${i < workflow.nodes.length - 1 ? '<div class="wf-connector"></div>' : ''}`).join('');

        drawInspector();
    }

    function drawInspector() {
        const node = data.workflow.nodes.find((n) => n.id === state.activeNode) || data.workflow.nodes[0];
        if (!node) {
            inspector.innerHTML = '';
            return;
        }
        inspector.innerHTML = `<div class="card">
            <div class="card-head">
                <div>
                    <div class="card-title">节点参数</div>
                    <div class="card-sub">${escapeHtml(node.title)}</div>
                </div>
            </div>
            <div class="card-body">
                <dl class="param-list">
                    ${Object.entries(node.params || {}).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}
                    <dt>节点类型</dt><dd>${escapeHtml(node.type)}</dd>
                </dl>
                <div class="divider"></div>
                <div class="small muted" style="line-height:1.8">节点参数在当前演示环境中只读，实际部署可在此接入可视化编辑与断点调试。</div>
            </div>
        </div>
        <div class="card" style="margin-top:12px">
            <div class="card-head"><div class="card-title">链路统计</div></div>
            <div class="card-body small col" style="gap:8px">
                <div class="row between"><span class="muted">节点数</span><b>${data.workflow.nodes.length}</b></div>
                <div class="row between"><span class="muted">累计运行</span><b>${num(data.workflow.runs)}</b></div>
                <div class="row between"><span class="muted">单次消耗</span><b>18 算力</b></div>
                <div class="row between"><span class="muted">维护者</span><b>${escapeHtml(data.workflow.owner?.name || '官方')}</b></div>
            </div>
        </div>`;
    }

    function drawRuns() {
        const runs = data.runs || [];
        runList.innerHTML = runs.length
            ? runs.map((t) => {
                const st = statusMeta(t.status);
                return `<a class="history-item" href="${url('tasks.html')}?id=${t.id}" style="display:flex;gap:8px;align-items:center;padding:9px 0;border-bottom:1px solid var(--border)">
                    <span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${st.label}</span>
                    <div style="min-width:0;flex:1">
                        <div class="small ellipsis">${escapeHtml(t.title)}</div>
                        <div class="small muted">${timeAgo(t.createdAt)}</div>
                    </div>
                </a>`;
            }).join('')
            : '<div class="small muted" style="padding:10px 0">暂无执行记录</div>';
    }

    canvas.addEventListener('click', (e) => {
        const nodeEl = e.target.closest('[data-node]');
        if (!nodeEl) return;
        state.activeNode = nodeEl.dataset.node;
        canvas.querySelectorAll('.wf-node').forEach((el) => el.classList.toggle('active', el.dataset.node === state.activeNode));
        drawInspector();
    });

    wfList.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-wf]');
        if (!btn) return;
        state.workflowId = btn.dataset.wf;
        data = await getWorkflow(state.workflowId);
        state.activeNode = data.workflow.nodes[0]?.id || '';
        stopWatch();
        drawSide();
        drawWorkflow();
        drawRuns();
        wfState.innerHTML = '';
        outputBody.innerHTML = emptyState({ title: '尚未执行', desc: '点击「运行工作流」开始执行当前链路。' });
    });

    host.querySelector('#copyId')?.addEventListener('click', () => copyText(state.workflowId, '工作流 ID 已复制'));

    host.querySelector('#wfCount')?.addEventListener('change', (e) => {
        state.count = Number(e.target.value) || 2;
    });

    host.querySelector('#runWf')?.addEventListener('click', async () => {
        const btn = host.querySelector('#runWf');
        btn.classList.add('loading');
        btn.disabled = true;
        try {
            const task = await runWorkflow(state.workflowId, { count: state.count });
            toast('工作流已开始执行', 'success');
            const next = await getAccount();
            host.querySelector('#wfBalance').textContent = num(next.credits);
            watch(task);
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            btn.classList.remove('loading');
            btn.disabled = false;
        }
    });

    function watch(task) {
        stopWatch();
        state.taskId = task.id;
        paint(task);
        state.unsubscribe = on(EVENTS.taskUpdate, (t) => {
            if (t && t.id === state.taskId) paint(t);
        });
        state.polling = setInterval(async () => {
            try {
                paint(await getTask(state.taskId));
            } catch (err) {
                console.warn(err);
            }
        }, 1500);
    }

    function stopWatch() {
        if (state.polling) clearInterval(state.polling);
        if (state.unsubscribe) state.unsubscribe();
        state.polling = null;
        state.unsubscribe = null;
    }

    function paint(task) {
        const st = statusMeta(task.status);
        wfState.innerHTML = `<span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${st.label}</span>`;

        const nodes = [...canvas.querySelectorAll('.wf-node')];
        const connectors = [...canvas.querySelectorAll('.wf-connector')];
        const doneCount = Math.floor(((task.progress || 0) / 100) * nodes.length);
        nodes.forEach((el, i) => {
            el.classList.toggle('done', i < doneCount);
            el.classList.remove('active');
            const statusEl = el.querySelector('.nd-status');
            if (i < doneCount) statusEl.textContent = '已完成';
            else if (i === doneCount && ['queued', 'running'].includes(task.status)) {
                el.classList.add('active');
                statusEl.textContent = '执行中…';
            } else statusEl.textContent = '待执行';
        });
        connectors.forEach((el, i) => el.classList.toggle('active', i < doneCount));

        const running = ['queued', 'running'].includes(task.status);
        outputBody.innerHTML = `
            <div class="row" style="gap:10px;margin-bottom:10px">
                <div class="progress ${task.status === 'failed' ? 'danger' : task.status === 'succeeded' ? 'ok' : ''}" style="flex:1"><i style="width:${Math.max(2, task.progress || 0)}%"></i></div>
                <b class="small" style="width:44px;text-align:right">${task.progress || 0}%</b>
            </div>
            <div class="row small muted" style="gap:14px;margin-bottom:12px">
                <span>${icon('workflow', 12)} ${escapeHtml(task.title)}</span>
                <span>${icon('credit', 12)} ${task.cost} 算力</span>
                <span>${icon('clock', 12)} ${timeAgo(task.createdAt)}</span>
            </div>
            ${task.error ? `<div class="result-box" style="color:var(--danger)">${escapeHtml(task.error)}</div>` : ''}
            ${(task.outputs || []).length ? `<div class="result-grid">
                ${task.outputs.map((o) => o.type === 'image'
            ? `<img src="${escapeHtml(o.url)}" alt="${escapeHtml(o.title || '工作流产物')}" loading="lazy">`
            : `<div class="result-box small">${escapeHtml(o.title || o.type)}</div>`).join('')}
            </div>` : running ? `<div class="small muted">${escapeHtml((task.logs || []).slice(-1)[0]?.msg || '节点执行中…')}</div>` : ''}
            <div class="log-panel" style="margin-top:12px">
                ${(task.logs || []).slice(-10).map((l) => `<div class="log-line ${l.level === 'warn' ? 'warn' : l.level === 'error' ? 'err' : ''}">
                    <span class="t">${escapeHtml(l.t || '')}</span><span class="m">${escapeHtml(l.msg || '')}</span>
                </div>`).join('')}
            </div>`;

        if (!running) {
            stopWatch();
            if (task.status === 'succeeded') {
                wfList.querySelector(`[data-wf="${state.workflowId}"] .small.muted`).innerHTML = `${data.workflow.nodes.length} 节点 · ${num(data.workflow.runs + 1)} 次运行`;
            }
        }
    }

    await getAccount().then((a) => {
        host.querySelector('#wfBalance').textContent = num(a.credits);
    }).catch(() => {});
}

function describeNode(node) {
    const p = node.params || {};
    if (p.positive) return p.positive;
    if (p.script) return p.script;
    if (p.model) return `模型：${p.model}`;
    if (p.lora) return `LoRA：${p.lora} · 强度 ${p.strength ?? '-'}`;
    if (p.steps) return `steps ${p.steps} · cfg ${p.cfg ?? '-'}${p.sampler ? ` · ${p.sampler}` : ''}`;
    if (p.scale) return `放大 ${p.scale}×${p.denoise ? ` · 重绘 ${p.denoise}` : ''}`;
    if (p.format) return `输出格式 ${p.format}`;
    return Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' · ') || '默认参数';
}
