import { createApp, listWorkflows } from '../core/api.js';
import { APP_CATEGORIES, MODELS } from '../core/constants.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast } from '../core/ui.js';
import { escapeHtml, uid } from '../core/format.js';

const FIELD_TYPES = [
    { id: 'text', name: '单行文本' },
    { id: 'textarea', name: '多行文本' },
    { id: 'select', name: '下拉选择' },
    { id: 'range', name: '滑杆数值' },
    { id: 'switch', name: '开关' },
    { id: 'number', name: '数字输入' }
];

export async function render(host, ctx) {
    setPageTitle('创建应用');
    const { items: workflows } = await listWorkflows().catch(() => ({ items: [] }));

    const state = {
        fields: [
            { id: uid('f'), key: 'prompt', label: '画面描述', type: 'textarea', required: true, placeholder: '描述你想生成的内容', def: '' },
            { id: uid('f'), key: 'ratio', label: '画幅比例', type: 'select', required: false, options: '1:1,4:3,16:9,9:16', def: '16:9' }
        ]
    };

    host.innerHTML = `
        <div class="page-head">
            <div class="page-head-main">
                <h1 class="page-title">创建 AI 应用 <span class="badge badge-brand">新建</span></h1>
                <div class="page-sub">配置输入参数与底层链路，把能力封装成他人可直接运行的应用</div>
            </div>
            <div class="page-actions">
                <a class="btn btn-outline" href="${url('app/ai-apps.html')}">${icon('arrow-left', 15)}返回广场</a>
                <button class="btn btn-outline" id="previewBtn">${icon('eye', 15)}预览表单</button>
                <button class="btn btn-primary" id="submitBtn">${icon('upload', 15)}发布应用</button>
            </div>
        </div>

        <div class="create-wrap">
            <div class="card">
                <div class="form-section">
                    <div class="section-head"><span class="n">1</span><h3>基本信息</h3><span class="spacer"></span>
                        <span class="small muted">名称与简介会展示在应用广场</span></div>
                    <div class="form-grid">
                        <div class="field">
                            <label class="label" for="fName">应用名称 <span class="req">*</span></label>
                            <input class="input" id="fName" maxlength="20" placeholder="例如：古风头像生成器">
                        </div>
                        <div class="field">
                            <label class="label" for="fCategory">分类</label>
                            <select class="select" id="fCategory">
                                ${APP_CATEGORIES.filter((c) => c.id !== 'all').map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}
                            </select>
                        </div>
                        <div class="field span-2">
                            <label class="label" for="fDesc">应用简介 <span class="req">*</span></label>
                            <textarea class="textarea" id="fDesc" maxlength="160" style="min-height:76px"
                                placeholder="一句话说明这个应用能帮用户解决什么问题"></textarea>
                        </div>
                        <div class="field span-2">
                            <label class="label" for="fTags">标签 <span class="hint-inline">用逗号分隔，最多 4 个</span></label>
                            <input class="input" id="fTags" placeholder="头像, 国风, 一键生成">
                        </div>
                    </div>
                </div>

                <div class="form-section">
                    <div class="section-head"><span class="n">2</span><h3>运行配置</h3><span class="spacer"></span>
                        <span class="cost-pill">${icon('credit', 13)} 价格即单次运行消耗的算力</span></div>
                    <div class="form-grid">
                        <div class="field">
                            <label class="label" for="fPrice">单次运行价格（算力）</label>
                            <input class="input" type="number" id="fPrice" min="0" max="200" value="6">
                        </div>
                        <div class="field">
                            <label class="label" for="fModel">底层模型</label>
                            <select class="select" id="fModel">
                                ${MODELS.map((m) => `<option value="${m.id}">${m.name} · ${m.kind === 'video' ? '视频' : '图像'}</option>`).join('')}
                            </select>
                        </div>
                        <div class="field span-2">
                            <label class="label" for="fWorkflow">关联工作流 <span class="hint-inline">可选，复杂链路建议编排工作流</span></label>
                            <select class="select" id="fWorkflow">
                                <option value="">不关联（使用内置推理链路）</option>
                                ${workflows.map((w) => `<option value="${w.id}">${escapeHtml(w.name)} · ${w.nodes.length} 个节点</option>`).join('')}
                            </select>
                        </div>
                    </div>
                </div>

                <div class="form-section">
                    <div class="section-head"><span class="n">3</span><h3>输入参数</h3><span class="spacer"></span>
                        <button class="btn btn-sm btn-outline" id="addField">${icon('plus', 14)}添加参数</button></div>
                    <div class="col" id="fieldList" style="gap:10px"></div>
                    <div class="hint" style="margin-top:8px">参数会按顺序渲染成运行表单；key 需唯一且使用英文，例如 prompt、style、ratio。</div>
                </div>
            </div>

            <aside class="create-side">
                <div class="card">
                    <div class="card-head"><div class="card-title">表单预览</div></div>
                    <div class="card-body" id="previewBody"></div>
                </div>
                <div class="card" style="margin-top:14px">
                    <div class="card-head"><div class="card-title">发布检查</div></div>
                    <div class="card-body col" style="gap:8px" id="checkList"></div>
                </div>
            </aside>
        </div>`;

    const listEl = host.querySelector('#fieldList');
    const previewEl = host.querySelector('#previewBody');
    const checkEl = host.querySelector('#checkList');

    function drawFields() {
        if (!state.fields.length) {
            listEl.innerHTML = `<div class="small muted" style="padding:12px 0">还没有参数，点击右上角「添加参数」。</div>`;
        } else {
            listEl.innerHTML = state.fields.map((f, i) => `<div class="card" style="padding:12px;background:var(--bg-soft)" data-field="${f.id}">
                <div class="row" style="gap:8px;margin-bottom:8px">
                    <span class="badge">${i + 1}</span>
                    <input class="input input-sm" style="max-width:150px" data-prop="label" value="${escapeHtml(f.label)}" placeholder="参数名称">
                    <input class="input input-sm mono" style="max-width:130px" data-prop="key" value="${escapeHtml(f.key)}" placeholder="key">
                    <select class="select input-sm" style="max-width:118px" data-prop="type">
                        ${FIELD_TYPES.map((t) => `<option value="${t.id}" ${f.type === t.id ? 'selected' : ''}>${t.name}</option>`).join('')}
                    </select>
                    <label class="row small" style="gap:5px;white-space:nowrap">
                        <input type="checkbox" data-prop="required" ${f.required ? 'checked' : ''}> 必填
                    </label>
                    <span class="spacer"></span>
                    <button class="btn btn-sm btn-ghost" data-act="up" title="上移">${icon('chevron-down', 13)}</button>
                    <button class="btn btn-sm btn-ghost" data-act="remove" title="删除">${icon('trash', 13)}</button>
                </div>
                <div class="row" style="gap:8px">
                    <input class="input input-sm" style="flex:1" data-prop="placeholder" value="${escapeHtml(f.placeholder || '')}" placeholder="占位提示">
                    <input class="input input-sm" style="flex:1" data-prop="def" value="${escapeHtml(f.def || '')}" placeholder="默认值">
                    <input class="input input-sm mono" style="flex:1" data-prop="options" value="${escapeHtml(f.options || '')}" placeholder="选项（逗号分隔）" ${f.type === 'select' ? '' : 'disabled'}>
                </div>
            </div>`).join('');
        }
        drawPreview();
        drawChecks();
    }

    function drawPreview() {
        const name = host.querySelector('#fName').value.trim() || '未命名应用';
        previewEl.innerHTML = `
            <div class="row" style="gap:10px;margin-bottom:12px">
                <span class="app-icon" style="width:38px;height:38px;font-size:16px">${escapeHtml(name.slice(0, 1))}</span>
                <div>
                    <div style="font-weight:600;font-size:13px">${escapeHtml(name)}</div>
                    <div class="small muted">${escapeHtml(host.querySelector('#fDesc').value.trim() || '暂无简介')}</div>
                </div>
            </div>
            <div class="col" style="gap:10px">
                ${state.fields.map((f) => `
                    <div class="field" style="margin:0">
                        <label class="label">${escapeHtml(f.label || '未命名参数')}${f.required ? '<span class="req">*</span>' : ''}</label>
                        ${f.type === 'textarea'
                ? `<div class="textarea" style="color:var(--muted);min-height:56px;font-size:12px">${escapeHtml(f.placeholder || f.def || '用户输入…')}</div>`
                : f.type === 'select'
                    ? `<div class="select" style="color:var(--muted);font-size:12px">${escapeHtml((f.options || '选项').split(',')[0])}</div>`
                    : f.type === 'switch'
                        ? `<div class="switch ${f.def === 'on' ? 'on' : ''}"></div>`
                        : `<div class="input" style="color:var(--muted);font-size:12px">${escapeHtml(f.def || f.placeholder || '—')}</div>`}
                    </div>`).join('') || '<div class="small muted">暂无参数</div>'}
            </div>`;
    }

    function drawChecks() {
        const checks = [
            { ok: !!host.querySelector('#fName').value.trim(), text: '填写应用名称' },
            { ok: !!host.querySelector('#fDesc').value.trim(), text: '填写应用简介' },
            { ok: state.fields.length > 0, text: '至少配置一个输入参数' },
            { ok: state.fields.every((f) => f.key && /^[a-zA-Z_][\w-]*$/.test(f.key)), text: '参数 key 合法且唯一' }
        ];
        checkEl.innerHTML = checks.map((c) => `<div class="row small" style="gap:8px;color:${c.ok ? 'var(--ok)' : 'var(--muted)'}">
            ${icon(c.ok ? 'check' : 'x', 14)}<span>${c.text}</span></div>`).join('');
    }

    listEl.addEventListener('input', (e) => {
        const box = e.target.closest('[data-field]');
        if (!box) return;
        const field = state.fields.find((f) => f.id === box.dataset.field);
        const prop = e.target.dataset.prop;
        if (!field || !prop) return;
        field[prop] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
        if (prop === 'type') drawFields();
        else drawPreview(), drawChecks();
    });

    listEl.addEventListener('change', (e) => {
        const box = e.target.closest('[data-field]');
        if (!box || e.target.dataset.prop !== 'type') return;
        const field = state.fields.find((f) => f.id === box.dataset.field);
        if (field) {
            field.type = e.target.value;
            drawFields();
        }
    });

    listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const box = e.target.closest('[data-field]');
        const idx = state.fields.findIndex((f) => f.id === box?.dataset.field);
        if (idx < 0) return;
        if (btn.dataset.act === 'remove') state.fields.splice(idx, 1);
        if (btn.dataset.act === 'up' && idx > 0) {
            const [item] = state.fields.splice(idx, 1);
            state.fields.splice(idx - 1, 0, item);
        }
        drawFields();
    });

    host.querySelector('#addField')?.addEventListener('click', () => {
        state.fields.push({ id: uid('f'), key: `param${state.fields.length + 1}`, label: '新参数', type: 'text', required: false, placeholder: '', def: '' });
        drawFields();
    });

    ['#fName', '#fDesc'].forEach((sel) => {
        host.querySelector(sel)?.addEventListener('input', () => {
            drawPreview();
            drawChecks();
        });
    });

    host.querySelector('#previewBtn')?.addEventListener('click', () => {
        drawPreview();
        toast('已在右侧更新表单预览');
    });

    host.querySelector('#submitBtn')?.addEventListener('click', async () => {
        const name = host.querySelector('#fName').value.trim();
        const desc = host.querySelector('#fDesc').value.trim();
        if (!name) return toast('请填写应用名称', 'error');
        if (!desc) return toast('请填写应用简介', 'error');
        if (!state.fields.length) return toast('至少配置一个输入参数', 'error');
        const keys = state.fields.map((f) => f.key);
        if (new Set(keys).size !== keys.length) return toast('参数 key 不能重复', 'error');

        const inputs = state.fields.map((f) => {
            const base = {
                key: f.key,
                label: f.label || f.key,
                type: f.type,
                required: !!f.required,
                placeholder: f.placeholder || '',
                default: f.type === 'number' || f.type === 'range' ? Number(f.def) || 0 : f.def || ''
            };
            if (f.type === 'select') {
                base.options = String(f.options || '').split(',').map((s) => s.trim()).filter(Boolean)
                    .map((v) => ({ value: v, label: v }));
            }
            if (f.type === 'range') {
                base.min = 0;
                base.max = 50;
                base.step = 1;
            }
            return base;
        });

        const btn = host.querySelector('#submitBtn');
        btn.classList.add('loading');
        btn.disabled = true;
        try {
            const app = await createApp({
                name,
                desc,
                category: host.querySelector('#fCategory').value,
                price: Number(host.querySelector('#fPrice').value) || 0,
                model: host.querySelector('#fModel').value,
                workflowId: host.querySelector('#fWorkflow').value || null,
                tags: host.querySelector('#fTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 4),
                inputs,
                status: 'published'
            });
            toast('应用已发布，正在跳转', 'success');
            window.setTimeout(() => {
                window.location.href = `${url('app/ai-app-detail.html')}?id=${app.id}`;
            }, 700);
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            btn.classList.remove('loading');
            btn.disabled = false;
        }
    });

    drawFields();
}
