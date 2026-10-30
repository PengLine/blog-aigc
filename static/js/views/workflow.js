import { listWorkflows, getWorkflow, runWorkflow, getTask, getAccount, patchWorkflow, duplicateWorkflow } from '../core/api.js';
import { statusMeta } from '../core/constants.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast, emptyState, copyText, imgTag } from '../core/ui.js';
import { escapeHtml, num, timeAgo } from '../core/format.js';
import { on, EVENTS } from '../core/bus.js';

const NODE_ICONS = {
    prompt: 'wand', model: 'cpu', lora: 'layers', sampler: 'sliders',
    upscale: 'image', save: 'download', load: 'upload', video: 'video', controlnet: 'grid'
};

/** 节点类型元数据：用于「添加节点」面板与切换类型时的默认参数 */
const NODE_TYPES = [
    { type: 'prompt', name: '提示词编码', defaults: { positive: '', negative: 'low quality, watermark' } },
    { type: 'model', name: '加载底模', defaults: { model: 'lingxi-xl', vae: 'automatic' } },
    { type: 'lora', name: '叠加 LoRA', defaults: { lora: '', strength: 0.7 } },
    { type: 'sampler', name: 'K 采样器', defaults: { steps: 28, cfg: 6.5, sampler: 'DPM++ 2M Karras', seed: -1 } },
    { type: 'controlnet', name: 'ControlNet', defaults: { pose: 'canny', strength: 0.9 } },
    { type: 'upscale', name: '潜空间放大', defaults: { scale: 2, denoise: 0.35 } },
    { type: 'video', name: '图生视频', defaults: { model: 'Kling Video', duration: 5 } },
    { type: 'load', name: '载入素材', defaults: { source: '上传素材' } },
    { type: 'save', name: '保存输出', defaults: { format: 'PNG', prefix: 'linche' } }
];
const typeMeta = (t) => NODE_TYPES.find((n) => n.type === t) || { name: t, defaults: {} };

const GRID_X = 240;
const GRID_Y = 104;
const PAD = 40;

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
        count: 2,
        dirty: false,
        savedAt: ''
    };

    host.innerHTML = `
        <div class="page-head">
            <div class="page-head-main">
                <h1 class="page-title">工作流编排与执行</h1>
                <div class="page-sub">拖动节点自由布局、增删改节点并串联链路，一键批量产出</div>
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
                                <span class="small" id="wfSave" style="color:var(--muted-2)"></span>
                            </div>
                            <div class="small muted" id="wfDesc" style="margin-top:2px"></div>
                        </div>
                        <span class="spacer"></span>
                        <select class="select input-sm" id="wfCount" style="width:96px" aria-label="生成数量">
                            <option value="1">1 张</option>
                            <option value="2" selected>2 张</option>
                            <option value="4">4 张</option>
                        </select>
                        <button class="btn btn-outline btn-sm" id="addNodeBtn" style="position:relative">${icon('plus', 13)}添加节点</button>
                        <button class="btn btn-outline btn-sm" id="autoLayout">${icon('grid', 13)}自动排列</button>
                        <button class="btn btn-outline btn-sm" id="saveAs">${icon('copy', 13)}另存副本</button>
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
                        ${emptyState({ title: '尚未执行', desc: '拖动可调整布局，选中节点后可在右侧编辑参数，点击右上角「运行工作流」产出结果。' })}
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

    // 首次加载：缺失坐标的节点自动布局并静默持久化，保证下次打开位置一致
    if (data.workflow.nodes.some((n) => !n.pos)) {
        autoLayout();
        persist(false);
    }

    drawSide();
    drawHead();
    drawNodes();
    drawRuns();

    /* ------------------------------ 渲染 ------------------------------ */

    function wf() {
        return data.workflow;
    }

    function drawSide() {
        wfList.innerHTML = items.map((w) => {
            // 当前工作流的节点数取实时值（增删后侧栏同步）
            const nodeCount = w.id === state.workflowId ? wf().nodes.length : w.nodes.length;
            return `<button class="lib-item ${w.id === state.workflowId ? 'active' : ''}" data-wf="${w.id}"
            style="text-align:left;padding:10px;border-radius:10px;border:1px solid ${w.id === state.workflowId ? 'var(--brand-300)' : 'transparent'};background:${w.id === state.workflowId ? 'var(--brand-50)' : 'transparent'};width:100%">
            <div class="row" style="gap:8px">
                <span style="color:var(--brand-600)">${icon('workflow', 15)}</span>
                <div style="min-width:0">
                    <div class="small" style="font-weight:600">${escapeHtml(w.name)}</div>
                    <div class="small muted">${nodeCount} 节点 · ${num(w.runs)} 次运行</div>
                </div>
            </div>
        </button>`;
        }).join('');
    }

    function drawHead() {
        host.querySelector('#wfName').textContent = wf().name;
        host.querySelector('#wfVersion').textContent = wf().version;
        host.querySelector('#wfDesc').textContent = wf().desc;
    }

    function nodeHtml(node, i) {
        return `<div class="wf-node ${state.activeNode === node.id ? 'active' : ''}" data-node="${node.id}"
            style="left:${node.pos.x}px;top:${node.pos.y}px">
            <button class="wf-del" data-del="${node.id}" title="删除节点" aria-label="删除节点">${icon('x', 12)}</button>
            <div class="nd-head">
                <span class="nd-grip">${icon('grid', 12)}</span>
                <span class="badge">${i + 1}</span>
                <span style="color:var(--brand-600)">${icon(NODE_ICONS[node.type] || 'workflow', 14)}</span>
                <b class="small">${escapeHtml(node.title)}</b>
                <span class="nd-status small muted">待执行</span>
            </div>
            <div class="nd-body small muted">${escapeHtml(describeNode(node))}</div>
        </div>`;
    }

    function drawNodes() {
        const nodes = wf().nodes;
        if (!nodes.length) {
            canvas.innerHTML = `<div style="position:absolute;inset:0;display:grid;place-items:center">${emptyState({ title: '空工作流', desc: '点击工具栏「添加节点」开始搭建链路。' })}</div>`;
            drawInspector();
            return;
        }
        const worldW = Math.max(...nodes.map((n) => n.pos.x)) + 260 + PAD;
        const worldH = Math.max(...nodes.map((n) => n.pos.y)) + 120 + PAD;
        canvas.innerHTML = `<div class="wf-world" style="width:${worldW}px;height:${worldH}px">
            <svg class="wf-links" width="${worldW}" height="${worldH}">
                <defs><marker id="wfArrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                    <path d="M0 0 L8 4 L0 8 z" fill="var(--border-strong)"/></marker></defs>
                <g class="wf-edge-layer"></g>
            </svg>
            ${nodes.map((n, i) => nodeHtml(n, i)).join('')}
        </div>`;
        // 同步绘一次（offsetWidth/Height 会强制布局，无需等帧），再用 rAF 兜一次处理字体回流后的细微偏移
        drawEdges();
        requestAnimationFrame(drawEdges);
        drawInspector();
    }

    function drawEdges() {
        const layer = canvas.querySelector('.wf-edge-layer');
        if (!layer) return;
        const nodes = wf().nodes;
        const els = Array.from(canvas.querySelectorAll('.wf-node'));
        const size = new Map();
        els.forEach((el) => size.set(el.dataset.node, el));
        let svg = '';
        for (let i = 0; i < nodes.length - 1; i += 1) {
            const a = nodes[i];
            const b = nodes[i + 1];
            const ae = size.get(a.id);
            const be = size.get(b.id);
            if (!ae || !be) continue;
            const sx = a.pos.x + ae.offsetWidth / 2;
            const sy = a.pos.y + ae.offsetHeight;
            const tx = b.pos.x + be.offsetWidth / 2;
            const ty = b.pos.y;
            const k = Math.max(24, (ty - sy) / 2);
            svg += `<path class="wf-edge" data-edge="${i}" marker-end="url(#wfArrow)"
                d="M${sx} ${sy} C ${sx} ${sy + k}, ${tx} ${ty - k}, ${tx} ${ty}"/>`;
        }
        layer.innerHTML = svg;
    }

    function drawInspector() {
        const node = wf().nodes.find((n) => n.id === state.activeNode) || wf().nodes[0];
        if (!node) {
            inspector.innerHTML = emptyState({ title: '未选中节点', desc: '在画布点选节点后，这里可编辑标题、类型与参数。' });
            return;
        }
        const idx = wf().nodes.findIndex((n) => n.id === node.id);
        const total = wf().nodes.length;
        inspector.innerHTML = `<div class="card">
            <div class="card-head">
                <div>
                    <div class="card-title">编辑节点</div>
                    <div class="card-sub">${escapeHtml(typeMeta(node.type).name)} · 第 ${idx + 1}/${total} 步</div>
                </div>
                <div class="spacer"></div>
                <button class="icon-btn" data-move="-1" ${idx === 0 ? 'disabled' : ''} title="上移">${icon('arrow-up', 15)}</button>
                <button class="icon-btn" data-move="1" ${idx === total - 1 ? 'disabled' : ''} title="下移">${icon('arrow-down', 15)}</button>
            </div>
            <div class="card-body col" style="gap:10px">
                <label class="small muted">节点标题
                    <input class="input input-sm" id="ndTitle" value="${escapeHtml(node.title)}" style="margin-top:4px">
                </label>
                <label class="small muted">节点类型
                    <select class="select input-sm" id="ndType" style="margin-top:4px;width:100%">
                        ${NODE_TYPES.map((t) => `<option value="${t.type}" ${t.type === node.type ? 'selected' : ''}>${t.name}</option>`).join('')}
                    </select>
                </label>
                <div class="divider" style="margin:2px 0"></div>
                <div class="row between"><b class="small">参数</b><button class="btn btn-ghost btn-sm" id="addParam">${icon('plus', 12)}加参数</button></div>
                <div class="col" style="gap:8px" id="paramList">
                    ${Object.entries(node.params || {}).map(([k, v]) => paramRow(k, v)).join('')
                        || '<div class="small muted">暂无参数，点「加参数」新增。</div>'}
                </div>
                <button class="btn btn-outline btn-sm btn-block" id="delNode" style="color:var(--danger);border-color:var(--danger)">${icon('x', 12)}删除该节点</button>
            </div>
        </div>
        <div class="card" style="margin-top:12px">
            <div class="card-head"><div class="card-title">链路统计</div></div>
            <div class="card-body small col" style="gap:8px">
                <div class="row between"><span class="muted">节点数</span><b>${total}</b></div>
                <div class="row between"><span class="muted">累计运行</span><b>${num(wf().runs)}</b></div>
                <div class="row between"><span class="muted">维护者</span><b>${escapeHtml(wf().owner?.name || '官方')}</b></div>
                <div class="small muted" style="line-height:1.7">拖动节点可自由布局，位置与编辑都会自动保存到本地。执行顺序按节点序号（可用上/下移调整）。</div>
            </div>
        </div>`;
        bindInspector(node);
    }

    function paramRow(key, value) {
        return `<div class="row" style="gap:6px" data-param="${escapeHtml(key)}">
            <input class="input input-sm pk" value="${escapeHtml(key)}" style="flex:0 0 40%" aria-label="参数名">
            <input class="input input-sm pv" value="${escapeHtml(String(value))}" style="flex:1;min-width:0" aria-label="参数值">
            <button class="icon-btn" data-rmparam="${escapeHtml(key)}" title="删除参数">${icon('x', 14)}</button>
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

    /* ------------------------------ 编辑与持久化 ------------------------------ */

    function serialize() {
        return wf().nodes.map((n) => ({
            id: n.id, type: n.type, title: n.title,
            params: n.params || {},
            pos: n.pos ? { x: Math.round(n.pos.x), y: Math.round(n.pos.y) } : null
        }));
    }

    let saveTimer = null;
    function paintSave(text, tone) {
        state.savedAt = text;
        const el = host.querySelector('#wfSave');
        if (el) { el.textContent = text; el.style.color = tone || 'var(--muted-2)'; }
    }
    function scheduleSave(bump) {
        state.dirty = true;
        paintSave('未保存', 'var(--warn)');
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => persist(bump), 600);
    }
    async function persist(bump) {
        try {
            const res = await patchWorkflow(state.workflowId, { nodes: serialize(), bumpVersion: !!bump });
            if (res.workflow?.version) { wf().version = res.workflow.version; host.querySelector('#wfVersion').textContent = res.workflow.version; }
            state.dirty = false;
            const d = new Date();
            paintSave(`已保存 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, 'var(--ok)');
        } catch (err) {
            paintSave('保存失败', 'var(--danger)');
            toast(err.message || '保存失败', 'error');
        }
    }

    function updateNodeDom(node) {
        const el = canvas.querySelector(`.wf-node[data-node="${node.id}"]`);
        if (!el) return;
        el.querySelector('.nd-head b').textContent = node.title;
        el.querySelector('.nd-body').textContent = describeNode(node);
    }

    function autoLayout() {
        const nodes = wf().nodes;
        // 默认单列纵向链（与连线方向一致）；节点多时横向分列避免过长
        const perCol = nodes.length > 6 ? Math.ceil(nodes.length / 2) : nodes.length;
        nodes.forEach((n, i) => {
            const col = Math.floor(i / perCol);
            const row = i % perCol;
            // 偶数列自上而下、奇数列自下而上，形成蛇形，减少跨列回跳连线
            const orderedRow = col % 2 === 0 ? row : (perCol - 1 - row);
            n.pos = { x: PAD + col * GRID_X, y: PAD + orderedRow * GRID_Y };
        });
    }

    /* ------------------------------ 节点库切换 / 选择 ------------------------------ */

    canvas.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]')) return; // 删除由 pointerdown 逻辑处理
        const nodeEl = e.target.closest('[data-node]');
        if (!nodeEl) return;
        selectNode(nodeEl.dataset.node);
    });

    function selectNode(id) {
        if (state.activeNode === id) return;
        state.activeNode = id;
        canvas.querySelectorAll('.wf-node').forEach((el) => el.classList.toggle('active', el.dataset.node === id));
        drawInspector();
    }

    wfList.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-wf]');
        if (!btn) return;
        await persist(false); // 切走前保存当前编辑
        state.workflowId = btn.dataset.wf;
        stopWatch();
        data = await getWorkflow(state.workflowId);
        if (wf().nodes.some((n) => !n.pos)) { autoLayout(); persist(false); }
        state.activeNode = wf().nodes[0]?.id || '';
        drawSide();
        drawHead();
        drawNodes();
        drawRuns();
        wfState.innerHTML = '';
        outputBody.innerHTML = emptyState({ title: '尚未执行', desc: '点击「运行工作流」开始执行当前链路。' });
        paintSave('');
    });

    /* ------------------------------ 拖拽 ------------------------------ */

    let drag = null;
    let dragRaf = null;

    canvas.addEventListener('pointerdown', (e) => {
        const del = e.target.closest('[data-del]');
        if (del) { e.preventDefault(); removeNode(del.dataset.del); return; }
        const nodeEl = e.target.closest('.wf-node');
        if (!nodeEl || e.button !== 0) return;
        const node = wf().nodes.find((n) => n.id === nodeEl.dataset.node);
        if (!node) return;
        e.preventDefault();
        drag = {
            id: node.id, el: nodeEl, node,
            startX: e.clientX, startY: e.clientY,
            origX: node.pos.x, origY: node.pos.y,
            moved: false, pid: e.pointerId
        };
        try { nodeEl.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        nodeEl.addEventListener('pointermove', onDragMove);
        nodeEl.addEventListener('pointerup', onDragEnd);
        nodeEl.addEventListener('pointercancel', onDragEnd);
    });

    function onDragMove(e) {
        if (!drag) return;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        drag.moved = true;
        drag.el.classList.add('is-dragging');
        const nx = Math.max(8, drag.origX + dx);
        const ny = Math.max(8, drag.origY + dy);
        drag.node.pos = { x: nx, y: ny };
        drag.el.style.left = `${nx}px`;
        drag.el.style.top = `${ny}px`;
        growWorld();
        if (!dragRaf) dragRaf = requestAnimationFrame(() => { dragRaf = null; drawEdges(); });
    }

    function onDragEnd() {
        if (!drag) return;
        const { el, moved, id } = drag;
        el.removeEventListener('pointermove', onDragMove);
        el.removeEventListener('pointerup', onDragEnd);
        el.removeEventListener('pointercancel', onDragEnd);
        el.classList.remove('is-dragging');
        drag = null;
        if (moved) { selectNode(id); scheduleSave(false); }
        drawEdges();
    }

    function growWorld() {
        const world = canvas.querySelector('.wf-world');
        if (!world) return;
        const nodes = wf().nodes;
        const w = Math.max(...nodes.map((n) => n.pos.x)) + 260 + PAD;
        const h = Math.max(...nodes.map((n) => n.pos.y)) + 120 + PAD;
        world.style.width = `${w}px`;
        world.style.height = `${h}px`;
        const svg = canvas.querySelector('.wf-links');
        if (svg) { svg.setAttribute('width', w); svg.setAttribute('height', h); }
    }

    /* ------------------------------ 增删节点 ------------------------------ */

    function removeNode(id) {
        const nodes = wf().nodes;
        if (nodes.length <= 1) { toast('至少保留一个节点', 'warn'); return; }
        const idx = nodes.findIndex((n) => n.id === id);
        nodes.splice(idx, 1);
        if (state.activeNode === id) state.activeNode = nodes[Math.max(0, idx - 1)]?.id || '';
        drawNodes();
        drawSide();
        scheduleSave(true);
        toast('已删除节点');
    }

    function addNode(type) {
        const meta = typeMeta(type);
        const nodes = wf().nodes;
        const lastY = nodes.length ? Math.max(...nodes.map((n) => n.pos.y)) : PAD - GRID_Y;
        const lastX = nodes.length ? nodes[nodes.length - 1].pos.x : PAD;
        const id = `n${Date.now().toString(36).slice(-4)}`;
        nodes.push({ id, type, title: meta.name, params: { ...meta.defaults }, pos: { x: lastX, y: lastY + GRID_Y } });
        state.activeNode = id;
        drawNodes();
        drawSide();
        scheduleSave(true);
    }

    const addNodeBtn = host.querySelector('#addNodeBtn');
    let addMenu = null;
    addNodeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (addMenu) { closeAddMenu(); return; }
        addMenu = document.createElement('div');
        addMenu.className = 'wf-add-menu';
        addMenu.innerHTML = NODE_TYPES.map((t) => `<button data-add="${t.type}">${icon(NODE_ICONS[t.type] || 'workflow', 14)}${t.name}</button>`).join('');
        addNodeBtn.appendChild(addMenu);
        addMenu.addEventListener('click', (ev) => {
            const b = ev.target.closest('[data-add]');
            if (!b) return;
            addNode(b.dataset.add);
            closeAddMenu();
        });
    });
    function closeAddMenu() { if (addMenu) { addMenu.remove(); addMenu = null; } }
    document.addEventListener('click', (e) => { if (addMenu && !e.target.closest('#addNodeBtn')) closeAddMenu(); });

    host.querySelector('#autoLayout')?.addEventListener('click', () => {
        autoLayout();
        drawNodes();
        scheduleSave(false);
        toast('已自动排列');
    });

    host.querySelector('#saveAs')?.addEventListener('click', async () => {
        await persist(false);
        try {
            const res = await duplicateWorkflow(state.workflowId);
            toast(`已另存为「${res.workflow.name}」`, 'success');
            const list = await listWorkflows();
            items.length = 0;
            items.push(...list.items);
            state.workflowId = res.workflow.id;
            data = await getWorkflow(res.workflow.id);
            state.activeNode = wf().nodes[0]?.id || '';
            drawSide();
            drawHead();
            drawNodes();
            paintSave('');
        } catch (err) {
            toast(err.message || '另存失败', 'error');
        }
    });

    /* ------------------------------ 右侧编辑绑定 ------------------------------ */

    function bindInspector(node) {
        const titleInput = inspector.querySelector('#ndTitle');
        titleInput?.addEventListener('input', (e) => {
            node.title = e.target.value || '未命名节点';
            updateNodeDom(node);
            drawHead();
            scheduleSave(false);
        });

        inspector.querySelector('#ndType')?.addEventListener('change', (e) => {
            const oldName = typeMeta(node.type).name;
            node.type = e.target.value;
            const meta = typeMeta(node.type);
            node.params = { ...(node.params || {}) };
            // 补齐该类型默认参数中缺失的键
            Object.entries(meta.defaults).forEach(([k, v]) => { if (!(k in node.params)) node.params[k] = v; });
            // 标题未被用户自定义（等于旧类型名）时，跟随新类型名
            if (!node.title || node.title === oldName) node.title = meta.name;
            drawNodes();
            scheduleSave(true);
        });

        inspector.querySelector('#delNode')?.addEventListener('click', () => removeNode(node.id));

        const moveBtns = inspector.querySelectorAll('[data-move]');
        moveBtns.forEach((btn) => btn.addEventListener('click', () => {
            const dir = Number(btn.dataset.move);
            const nodes = wf().nodes;
            const i = nodes.findIndex((n) => n.id === node.id);
            const j = i + dir;
            if (j < 0 || j >= nodes.length) return;
            [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
            drawNodes();
            scheduleSave(true);
        }));

        const paramList = inspector.querySelector('#paramList');
        paramList?.addEventListener('input', (e) => {
            const row = e.target.closest('[data-param]');
            if (!row) return;
            const oldKey = row.dataset.param;
            const keyInput = row.querySelector('.pk');
            const valInput = row.querySelector('.pv');
            const nextKey = (keyInput.value || '').trim();
            node.params = node.params || {};
            if (nextKey !== oldKey) { delete node.params[oldKey]; keyInput.parentElement.dataset.param = nextKey; }
            if (nextKey) node.params[nextKey] = coerce(valInput.value);
            updateNodeDom(node);
            scheduleSave(false);
        });
        paramList?.addEventListener('click', (e) => {
            const rm = e.target.closest('[data-rmparam]');
            if (!rm) return;
            delete node.params[rm.dataset.rmparam];
            drawInspector();
            updateNodeDom(node);
            scheduleSave(true);
        });

        inspector.querySelector('#addParam')?.addEventListener('click', () => {
            node.params = node.params || {};
            let k = 'newKey';
            let n = 1;
            while (k in node.params) { k = `newKey${n += 1}`; }
            node.params[k] = '';
            drawInspector();
            scheduleSave(false);
        });
    }

    /* ------------------------------ 运行与执行动画 ------------------------------ */

    host.querySelector('#wfCount')?.addEventListener('change', (e) => {
        state.count = Number(e.target.value) || 2;
    });

    host.querySelector('#runWf')?.addEventListener('click', async () => {
        const btn = host.querySelector('#runWf');
        await persist(false);
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
        state.unsubscribe = on(EVENTS.taskUpdate, (t) => { if (t && t.id === state.taskId) paint(t); });
        state.polling = setInterval(async () => {
            try { paint(await getTask(state.taskId)); } catch (err) { console.warn(err); }
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

        const nodeEls = [...canvas.querySelectorAll('.wf-node')];
        const edges = [...canvas.querySelectorAll('.wf-edge')];
        const doneCount = Math.floor(((task.progress || 0) / 100) * nodeEls.length);
        nodeEls.forEach((el, i) => {
            el.classList.toggle('done', i < doneCount);
            el.classList.remove('active');
            const statusEl = el.querySelector('.nd-status');
            if (!statusEl) return;
            if (i < doneCount) statusEl.textContent = '已完成';
            else if (i === doneCount && ['queued', 'running'].includes(task.status)) { el.classList.add('active'); statusEl.textContent = '执行中…'; }
            else statusEl.textContent = '待执行';
        });
        edges.forEach((el, i) => el.classList.toggle('active', i < doneCount - 1));

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
                    ? imgTag(o.url, o.title || '工作流产物')
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
                wf().runs += 1;
                drawSide();
            }
        }
    }

    await getAccount().then((a) => {
        host.querySelector('#wfBalance').textContent = num(a.credits);
    }).catch(() => {});
}

/** 参数值类型收敛：能转数字则存数字，否则存字符串 */
function coerce(raw) {
    const s = String(raw);
    if (s.trim() !== '' && !Number.isNaN(Number(s))) return Number(s);
    return s;
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
    if (p.source) return `来源：${p.source}`;
    return Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' · ') || '默认参数';
}
