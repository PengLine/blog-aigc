import { getApp, toggleAppFavorite } from '../core/api.js';
import { APP_CATEGORIES, statusMeta } from '../core/constants.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast, avatarTag, emptyState, copyText } from '../core/ui.js';
import { escapeHtml, num, timeAgo } from '../core/format.js';

export async function render(host, ctx) {
    setPageTitle('应用详情');
    host.innerHTML = `<div class="split"><div class="skeleton" style="height:420px;border-radius:16px"></div><div class="skeleton" style="height:320px;border-radius:16px"></div></div>`;

    let data;
    try {
        data = await getApp(ctx.query.id);
    } catch (err) {
        host.innerHTML = emptyState({
            title: '无法打开该应用',
            desc: err.message,
            action: `<a class="btn btn-primary" href="${url('app/ai-apps.html')}">返回应用广场</a>`
        });
        return;
    }

    const { app, runs, related, workflow } = data;
    const category = APP_CATEGORIES.find((c) => c.id === app.category);
    setPageTitle(app.name);
    draw();

    function draw() {
        host.innerHTML = `
        <div class="page-head" style="align-items:flex-start">
            <div class="page-head-main" style="display:flex;gap:12px;align-items:flex-start">
                <a class="icon-btn" href="${url('app/ai-apps.html')}" title="返回列表" style="margin-top:4px">${icon('arrow-left', 18)}</a>
                <div>
                    <h1 class="page-title">${escapeHtml(app.name)}
                        <span class="badge badge-violet">${escapeHtml(app.version)}</span>
                        ${app.isMine ? '<span class="badge badge-brand">我创建的</span>' : ''}
                    </h1>
                    <div class="page-sub" style="display:flex;gap:14px;flex-wrap:wrap">
                        <span>${icon('star', 13)} ${app.rating.toFixed(1)}（${num(app.ratingCount)} 评价）</span>
                        <span>${icon('play', 13)} ${num(app.runs)} 次运行</span>
                        <span>${icon('tag', 13)} ${escapeHtml(category?.name || '其他')}</span>
                        <span>更新于 ${timeAgo(app.updatedAt)}</span>
                    </div>
                </div>
            </div>
            <div class="page-actions">
                <button class="btn btn-outline" id="favBtn">${icon('star', 15)}${app.favorite ? '已收藏' : '收藏'}</button>
                <button class="btn btn-outline" id="shareBtn">${icon('share', 15)}分享</button>
                ${app.isMine ? `<a class="btn btn-outline" href="${url('app/ai-app-create.html')}?edit=${app.id}">${icon('edit', 15)}编辑</a>` : ''}
                <a class="btn btn-primary" href="${url('app/ai-app-use.html')}?id=${app.id}">${icon('rocket', 15)}开始运行</a>
            </div>
        </div>

        <div class="split">
            <div class="col" style="gap:16px">
                <div class="card">
                    <div class="app-hero">
                        <span class="app-icon ${app.iconTone || ''}" style="width:56px;height:56px;font-size:24px">${escapeHtml(app.icon)}</span>
                        <div>
                            <h1 style="font-size:18px;font-weight:700">${escapeHtml(app.name)}</h1>
                            <p class="small muted" style="margin-top:4px;line-height:1.7">${escapeHtml(app.desc)}</p>
                        </div>
                    </div>
                    <div class="card-body">
                        <div class="row wrap" style="gap:6px">
                            ${app.tags.map((t) => `<a class="tag tag-brand" href="${url(`app/ai-apps.html?q=${encodeURIComponent(t)}`)}">#${escapeHtml(t)}</a>`).join('')}
                        </div>
                        <div class="divider"></div>
                        <div class="grid cols-3" style="gap:16px">
                            ${infoCell('计费', app.price > 0 ? `${app.price} 算力 / 次` : '免费', 'credit')}
                            ${infoCell('底层模型', app.model, 'cpu')}
                            ${infoCell('运行环境', workflow ? `${workflow.name} ${workflow.version}` : '内置推理链路', 'workflow')}
                        </div>
                    </div>
                </div>

                <div class="card">
                    <div class="card-head">
                        <div>
                            <div class="card-title">输入参数</div>
                            <div class="card-sub">运行时按此表单填写，必填项缺失会阻止提交</div>
                        </div>
                        <div class="spacer"></div>
                        <span class="badge">${app.inputs.length} 个参数</span>
                    </div>
                    <div class="card-body">
                        <div class="param-grid">
                            ${app.inputs.map(inputPreview).join('')}
                        </div>
                    </div>
                </div>

                <div class="card">
                    <div class="card-head">
                        <div class="card-title">运行记录</div>
                        <div class="spacer"></div>
                        <a class="small" href="${url('tasks.html?type=app')}" style="color:var(--brand)">任务中心 ${icon('chevron-right', 12)}</a>
                    </div>
                    <div class="card-body" style="padding-top:6px">
                        ${runs.length ? runs.map(runRow).join('') : '<div class="small muted" style="padding:14px 0">你还没有运行过这个应用，点击右上角「开始运行」试试。</div>'}
                    </div>
                </div>

                ${related.length ? `<div>
                    <div class="row between" style="margin-bottom:10px">
                        <h3 style="font-size:15px">同分类应用</h3>
                        <a class="small" href="${url('app/ai-apps.html')}" style="color:var(--brand)">查看全部</a>
                    </div>
                    <div class="related-grid">
                        ${related.map((a) => `<a class="related-item" href="${url('app/ai-app-detail.html')}?id=${a.id}">
                            <div class="row" style="gap:10px">
                                <span class="app-icon ${a.iconTone || ''}" style="width:34px;height:34px;font-size:15px">${escapeHtml(a.icon)}</span>
                                <div style="min-width:0">
                                    <p style="font-weight:600;color:var(--text)">${escapeHtml(a.name)}</p>
                                    <span class="small muted ellipsis" style="display:block">${escapeHtml(a.desc)}</span>
                                </div>
                            </div>
                        </a>`).join('')}
                    </div>
                </div>` : ''}
            </div>

            <aside class="detail-side">
                <div class="card">
                    <div class="card-head"><div class="card-title">创作者</div></div>
                    <div class="card-body">
                        <div class="row" style="gap:10px">
                            ${avatarTag(app.author)}
                            <div>
                                <div style="font-weight:600">${escapeHtml(app.author?.name || '匿名')}</div>
                                <div class="small muted">@${escapeHtml(app.author?.handle || 'user')}</div>
                            </div>
                        </div>
                        <div class="divider"></div>
                        <a class="btn btn-outline btn-block" href="${url(`profile.html?uid=${app.authorId}`)}">查看主页</a>
                    </div>
                </div>

                <div class="card">
                    <div class="card-head"><div class="card-title">计费说明</div></div>
                    <div class="card-body small" style="color:var(--text-2);line-height:1.9">
                        <div class="row between"><span>单次运行</span><b>${app.price > 0 ? `${app.price} 算力` : '免费'}</b></div>
                        <div class="row between"><span>失败自动退款</span><b>是</b></div>
                        <div class="row between"><span>结果保存</span><b>7 天</b></div>
                        <div class="divider"></div>
                        <p class="muted">运行结果会保留在任务中心与本次会话中，可一键转为资产继续迭代。</p>
                    </div>
                </div>

                ${workflow ? `<div class="card">
                    <div class="card-head"><div class="card-title">工作流链路</div></div>
                    <div class="card-body">
                        ${workflow.nodes.map((n, i) => `<div class="row" style="gap:8px;padding:6px 0">
                            <span class="badge">${i + 1}</span>
                            <span class="small">${escapeHtml(n.title)}</span>
                        </div>`).join('')}
                        <a class="btn btn-outline btn-block" style="margin-top:8px" href="${url(`ai-workflow-execute.html?id=${workflow.id}`)}">在工作流中打开</a>
                    </div>
                </div>` : ''}
            </aside>
        </div>`;

        host.querySelector('#favBtn')?.addEventListener('click', async () => {
            try {
                const res = await toggleAppFavorite(app.id);
                app.favorite = res.active;
                toast(res.active ? '已收藏应用' : '已取消收藏', 'success');
                draw();
            } catch (err) {
                toast(err.message, 'error');
            }
        });

        host.querySelector('#shareBtn')?.addEventListener('click', () => {
            copyText(`${location.origin}${location.pathname}?id=${app.id}`, '应用链接已复制');
        });
    }
}

function infoCell(label, value, iconName) {
    return `<div class="row" style="gap:8px;align-items:flex-start">
        <span style="color:var(--brand-600);margin-top:2px">${icon(iconName, 15)}</span>
        <div>
            <div class="small muted">${escapeHtml(label)}</div>
            <div style="font-weight:600;font-size:13px">${escapeHtml(String(value))}</div>
        </div>
    </div>`;
}

function inputPreview(field) {
    const typeLabel = { textarea: '长文本', text: '文本', select: '单选', range: '滑杆', switch: '开关', number: '数字' }[field.type] || '文本';
    return `<div class="field" style="margin-bottom:0">
        <label class="label">${escapeHtml(field.label)}
            ${field.required ? '<span class="req">*</span>' : ''}
            <span class="hint-inline">${typeLabel}</span>
        </label>
        <div class="input" style="color:var(--muted);font-size:12.5px;max-height:74px;overflow:hidden">
            ${escapeHtml(String(field.default ?? field.placeholder ?? '—')).slice(0, 80)}
        </div>
        ${field.help ? `<div class="hint">${escapeHtml(field.help)}</div>` : ''}
    </div>`;
}

function runRow(task) {
    const st = statusMeta(task.status);
    return `<a class="history-item" href="${url('tasks.html')}?id=${task.id}" style="display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
        <span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${st.label}</span>
        <div style="min-width:0;flex:1">
            <div class="small ellipsis" style="color:var(--text)">${escapeHtml(task.title)}</div>
            <div class="small muted">${timeAgo(task.createdAt)} · 消耗 ${task.cost} 算力</div>
        </div>
        <div style="width:110px">${progressBar(task.progress || 0, task.status === 'failed' ? 'danger' : '')}</div>
        <span class="small muted">${task.outputs?.length || 0} 个产物</span>
    </a>`;
}

function progressBar(value, tone) {
    return `<div class="progress ${tone} progress-sm"><i style="width:${Math.max(2, Math.min(100, value))}%"></i></div>`;
}
