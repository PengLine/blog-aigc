import {
    listAssets,
    assetSummary,
    submitWork,
    unpublishWork,
    deleteWork,
    bulkWorkAction
} from '../core/api.js';
import { KINDS, KIND_LIST, SUBTYPE_MAP, statusMeta } from '../core/constants.js';
import { url, setPageTitle } from '../core/shell.js';
import {
    icon,
    toast,
    confirmDialog,
    emptyState,
    renderPagination,
    workCard,
    bindWorkCards,
    imgTag,
    skeletonRows,
    skeletonCards
} from '../core/ui.js';
import { escapeHtml, num, timeAgo } from '../core/format.js';

const STATUS_FILTERS = [
    { id: 'all', name: '全部' },
    { id: 'published', name: '已发布' },
    { id: 'pending', name: '审核中' },
    { id: 'draft', name: '草稿' },
    { id: 'rejected', name: '未通过' },
    { id: 'private', name: '仅自己' }
];

const SORTS = [
    { id: 'updated', name: '最近更新' },
    { id: 'created', name: '创建时间' },
    { id: 'views', name: '浏览最多' },
    { id: 'likes', name: '点赞最多' }
];

export async function render(host, ctx) {
    const kind = ctx.params.kind || ctx.query.kind || 'all';
    const kindInfo = kind === 'all' ? { name: '资产库', plural: '资产' } : KINDS[kind] || KINDS.character;
    setPageTitle(kind === 'all' ? '资产库' : `我的${kindInfo.plural}`);

    const state = {
        kind,
        status: ctx.query.status || 'all',
        sort: ctx.query.sort || 'updated',
        q: ctx.query.q || '',
        page: 1,
        pageSize: 10,
        view: 'list',
        selected: new Set()
    };

    let summary = await assetSummary();

    host.innerHTML = `
        <div class="page-head">
            <div class="page-head-main">
                <h1 class="page-title">${kind === 'all' ? '资产库' : `我的${kindInfo.plural}`}
                    <span class="badge badge-brand">${summary.total} 个资产</span></h1>
                <div class="page-sub">统一管理角色、道具、景点、短剧与模型，发布状态与授权都在这里维护</div>
            </div>
            <div class="page-actions">
                <a class="btn btn-outline" href="${url('lora-train.html')}">${icon('cpu', 15)}训练模型</a>
                <a class="btn btn-primary" href="${url(KINDS[kind === 'all' ? 'character' : kind].create)}">${icon('plus', 15)}新建${kind === 'all' ? '资产' : kindInfo.name}</a>
            </div>
        </div>

        <div class="grid cols-4" style="margin-bottom:16px">
            ${metric('总资产', summary.total, `已发布 ${summary.published}`, 'layers')}
            ${metric('累计浏览', num(summary.views), `点赞 ${num(summary.likes)}`, 'eye')}
            ${metric('待处理', summary.draft + summary.pending + summary.rejected, `草稿 ${summary.draft} · 审核 ${summary.pending + summary.rejected}`, 'clock')}
            ${metric('规格上限', '无限', '专业版及以上不限资产数', 'zap')}
        </div>

        <div class="row wrap" style="gap:10px;margin-bottom:16px">
            <a class="asset-type-card ${kind === 'all' ? 'active' : ''}" href="${url('assets/my-assets.html')}" style="padding:14px;min-width:150px;flex:1">
                <span class="at-icon" style="background:var(--brand-50);color:var(--brand-600)">${icon('grid', 17)}</span>
                <div>
                    <div class="at-name">全部资产</div>
                    <div class="at-meta">${summary.total} 个 · ${summary.published} 已发布</div>
                </div>
            </a>
            ${KIND_LIST.filter((k) => k.id !== 'app').map((k) => {
                const stat = summary.byKind[k.id] || { total: 0, published: 0 };
                return `<a class="asset-type-card ${kind === k.id ? 'active' : ''}" href="${url(k.mine)}" style="padding:14px;min-width:150px;flex:1">
                    <span class="at-icon tone-${k.tone}">${icon(k.icon, 17)}</span>
                    <div>
                        <div class="at-name">${k.name}</div>
                        <div class="at-meta">${stat.total} 个 · ${stat.published} 已发布</div>
                    </div>
                </a>`;
            }).join('')}
        </div>

        <div class="card" style="padding:12px 14px;margin-bottom:14px">
            <div class="asset-toolbar">
                <div class="search" style="max-width:260px;flex:1">
                    <span class="search-icon">${icon('search', 15)}</span>
                    <input id="assetSearch" placeholder="搜索名称 / 标签 / 描述" value="${escapeHtml(state.q)}">
                </div>
                <div class="segmented" id="statusFilter">
                    ${STATUS_FILTERS.map((s) => `<button class="${state.status === s.id ? 'active' : ''}" data-status="${s.id}">${s.name}</button>`).join('')}
                </div>
                <span class="spacer"></span>
                <select class="select input-sm" id="sortFilter" style="width:130px" aria-label="排序">
                    ${SORTS.map((s) => `<option value="${s.id}" ${state.sort === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}
                </select>
                <div class="segmented" id="viewFilter">
                    <button class="${state.view === 'list' ? 'active' : ''}" data-view="list" title="列表管理">${icon('list', 14)}</button>
                    <button class="${state.view === 'grid' ? 'active' : ''}" data-view="grid" title="卡片浏览">${icon('grid', 14)}</button>
                </div>
            </div>
        </div>

        <div id="assetBody">${skeletonRows(5)}</div>
        <div class="pagination" id="assetPager" style="margin-top:16px"></div>
        <div class="bulk-bar" id="bulkBar" hidden></div>`;

    const bodyEl = host.querySelector('#assetBody');
    const pagerEl = host.querySelector('#assetPager');
    const bulkEl = host.querySelector('#bulkBar');
    let lastItems = [];

    async function load() {
        state.selected.clear();
        renderBulk();
        bodyEl.innerHTML = state.view === 'grid' ? skeletonCards(8) : skeletonRows(5);
        try {
            const res = await listAssets({ ...state, pageSize: state.view === 'grid' ? 12 : 10 });
            lastItems = res.items;
            if (!res.items.length) {
                bodyEl.innerHTML = emptyState({
                    title: state.q || state.status !== 'all' ? '没有匹配的资产' : '还没有资产',
                    desc: state.q || state.status !== 'all' ? '试试清空搜索条件或切换状态筛选。' : '从角色、道具或场景开始，创建你的第一个可复用资产。',
                    action: `<a class="btn btn-primary" href="${url(KINDS[kind === 'all' ? 'character' : kind].create)}">${icon('plus', 14)}立即创建</a>`
                });
                pagerEl.innerHTML = '<div class="small muted">共 0 条，可尝试切换状态或清空搜索。</div>';
                return;
            }
            if (state.view === 'grid') {
                bodyEl.innerHTML = `<div class="work-grid">${res.items.map((w) => workCard(w, { showStatus: true, showAuthor: false })).join('')}</div>`;
                bindWorkCards(bodyEl, (id) => openDetail(id, res.items));
            } else {
                bodyEl.innerHTML = `<div class="card" style="padding:6px 8px">
                    ${res.items.map((w) => rowHtml(w)).join('')}
                </div>`;
            }
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
            bodyEl.innerHTML = emptyState({ title: '资产加载失败', desc: err.message, action: '<button class="btn btn-outline" data-retry>重试</button>' });
        }
    }

    function rowHtml(work) {
        const meta = KINDS[work.kind] || KINDS.character;
        const st = statusMeta(work.status);
        return `<div class="asset-row" data-row="${work.id}">
            <label class="checkbox" title="选择">
                <input type="checkbox" data-pick="${work.id}">
            </label>
            <div class="thumb">${imgTag(work.cover, work.title)}</div>
            <div class="info">
                <b>${escapeHtml(work.title)}</b>
                <span>${meta.name} · ${escapeHtml(SUBTYPE_MAP[work.subtype] || '其他')} · 更新于 ${timeAgo(work.updatedAt)}</span>
            </div>
            <div style="width:92px"><span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${st.label}</span></div>
            <div class="small muted" style="width:110px;text-align:right">${icon('eye', 12)} ${num(work.stats.views)} · ${icon('heart', 12)} ${num(work.stats.likes)}</div>
            <div class="row" style="gap:4px">
                ${rowActions(work)}
            </div>
        </div>`;
    }

    function rowActions(work) {
        const meta = KINDS[work.kind] || KINDS.character;
        const canSubmit = ['draft', 'rejected', 'private'].includes(work.status);
        return `<button class="btn btn-sm btn-ghost" data-act="open" data-id="${work.id}" title="查看">${icon('eye', 14)}</button>
            <a class="btn btn-sm btn-ghost" href="${url(`${meta.create}?edit=${work.id}`)}" title="编辑">${icon('edit', 14)}</a>
            ${canSubmit ? `<button class="btn btn-sm btn-ghost" data-act="submit" data-id="${work.id}" title="提交审核">${icon('upload', 14)}</button>` : ''}
            ${work.status === 'published' ? `<button class="btn btn-sm btn-ghost" data-act="unpublish" data-id="${work.id}" title="下架">${icon('eye-off', 14)}</button>` : ''}
            <button class="btn btn-sm btn-ghost" data-act="delete" data-id="${work.id}" title="删除">${icon('trash', 14)}</button>`;
    }

    function openDetail(id, list) {
        const target = list.find((w) => w.id === id);
        if (!target) return;
        const meta = KINDS[target.kind] || KINDS.character;
        window.location.href = `${url(meta.detail)}?id=${encodeURIComponent(id)}`;
    }

    function renderBulk() {
        const count = state.selected.size;
        if (!count) {
            bulkEl.hidden = true;
            bulkEl.innerHTML = '';
            return;
        }
        bulkEl.hidden = false;
        bulkEl.innerHTML = `<div class="row" style="gap:10px;width:100%">
            <span class="small">已选择 <b>${count}</b> 项</span>
            <span class="spacer"></span>
            <button class="btn btn-sm btn-primary" data-bulk="submit">${icon('upload', 13)}批量提交审核</button>
            <button class="btn btn-sm btn-outline" data-bulk="private">${icon('eye-off', 13)}设为仅自己</button>
            <button class="btn btn-sm btn-danger-soft" data-bulk="delete">${icon('trash', 13)}批量删除</button>
            <button class="btn btn-sm btn-ghost" data-bulk="clear">取消选择</button>
        </div>`;
    }

    function patchSummary() {
        // 操作后刷新统计数字，保持页面信息一致
        assetSummary().then((next) => {
            summary = next;
            const nums = host.querySelectorAll('.metric-value');
            if (nums[0]) nums[0].firstChild.textContent = String(next.total);
            if (nums[1]) nums[1].firstChild.textContent = num(next.views);
            if (nums[2]) nums[2].firstChild.textContent = String(next.draft + next.pending + next.rejected);
        }).catch(() => {});
    }

    bodyEl.addEventListener('click', async (e) => {
        const retry = e.target.closest('[data-retry]');
        if (retry) {
            load();
            return;
        }
        const actBtn = e.target.closest('[data-act]');
        if (actBtn) {
            const { act, id } = actBtn.dataset;
            if (act === 'open') {
                const meta = KINDS[kind === 'all' ? 'character' : kind];
                window.location.href = `${url(meta.detail)}?id=${encodeURIComponent(id)}`;
                return;
            }
            await runAction(act, [id]);
            return;
        }
        const row = e.target.closest('.asset-row');
        if (row && !e.target.closest('button, a, input, label')) {
            const target = lastItems.find((w) => w.id === row.dataset.row);
            if (target) window.location.href = `${url((KINDS[target.kind] || KINDS.character).detail)}?id=${encodeURIComponent(target.id)}`;
        }
    });

    bodyEl.addEventListener('change', (e) => {
        const pick = e.target.closest('[data-pick]');
        if (!pick) return;
        if (pick.checked) state.selected.add(pick.dataset.pick);
        else state.selected.delete(pick.dataset.pick);
        renderBulk();
    });

    bulkEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-bulk]');
        if (!btn) return;
        const action = btn.dataset.bulk;
        if (action === 'clear') {
            state.selected.clear();
            bodyEl.querySelectorAll('[data-pick]').forEach((el) => {
                el.checked = false;
            });
            renderBulk();
            return;
        }
        if (action === 'delete') {
            const ok = await confirmDialog({
                title: '批量删除资产',
                message: `将永久删除 ${state.selected.size} 个资产及其评论、点赞记录，操作不可撤销。`,
                confirmText: '删除',
                danger: true
            });
            if (!ok) return;
        }
        try {
            const res = await bulkWorkAction([...state.selected], action);
            toast(`已处理 ${res.count} 个资产`, 'success');
            patchSummary();
            load();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    host.querySelector('#statusFilter')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-status]');
        if (!btn) return;
        state.status = btn.dataset.status;
        state.page = 1;
        host.querySelectorAll('#statusFilter button').forEach((el) => el.classList.toggle('active', el === btn));
        load();
    });

    host.querySelector('#viewFilter')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-view]');
        if (!btn) return;
        state.view = btn.dataset.view;
        state.page = 1;
        host.querySelectorAll('#viewFilter button').forEach((el) => el.classList.toggle('active', el === btn));
        load();
    });

    host.querySelector('#sortFilter')?.addEventListener('change', (e) => {
        state.sort = e.target.value;
        state.page = 1;
        load();
    });

    let timer = null;
    host.querySelector('#assetSearch')?.addEventListener('input', (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            state.q = e.target.value.trim();
            state.page = 1;
            load();
        }, 300);
    });

    async function runAction(act, ids) {
        try {
            if (act === 'submit') {
                for (const id of ids) await submitWork(id);
                toast('已提交审核，可在任务中心查看进度', 'success');
            } else if (act === 'unpublish') {
                for (const id of ids) await unpublishWork(id);
                toast('已下架，仅自己可见', 'success');
            } else if (act === 'delete') {
                const ok = await confirmDialog({
                    title: '删除资产',
                    message: '删除后不可恢复，关联的评论与点赞也会一并清除。',
                    confirmText: '删除',
                    danger: true
                });
                if (!ok) return;
                for (const id of ids) await deleteWork(id);
                toast('已删除', 'success');
            }
            patchSummary();
            load();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    await load();
}

function metric(label, value, sub, iconName) {
    return `<div class="metric">
        <div class="row" style="gap:8px">
            <span class="at-icon" style="width:28px;height:28px;border-radius:8px;background:var(--brand-50);color:var(--brand-600);display:inline-flex;align-items:center;justify-content:center">${icon(iconName, 14)}</span>
            <span class="metric-label">${escapeHtml(label)}</span>
        </div>
        <div class="metric-value">${typeof value === 'number' ? num(value) : escapeHtml(String(value))}</div>
        <div class="metric-trend">${escapeHtml(sub)}</div>
    </div>`;
}
