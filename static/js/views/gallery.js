import { listWorks, getOverview } from '../core/api.js';
import { KIND_LIST, SUBTYPES } from '../core/constants.js';
import { url, setPageTitle } from '../core/shell.js';
import { workCard, bindWorkCards, renderPagination, skeletonCards, emptyState, icon } from '../core/ui.js';
import { escapeHtml, num } from '../core/format.js';

const ASSET_KINDS = KIND_LIST.filter((k) => k.id !== 'app');

const SORTS = [
    { id: 'recommended', label: '推荐' },
    { id: 'latest', label: '最新' },
    { id: 'popular', label: '最热' },
    { id: 'likes', label: '最多点赞' }
];

export async function render(host, ctx) {
    setPageTitle('发现广场');
    const state = {
        kind: ctx.query.kind || 'all',
        subtype: ctx.query.subtype || 'all',
        sort: ctx.query.sort || 'recommended',
        q: ctx.query.q || '',
        page: 1,
        pageSize: 12
    };

    let overview = null;
    try {
        overview = await getOverview();
    } catch (err) {
        console.warn(err);
    }

    host.innerHTML = `
        ${heroHtml(overview)}
        <div class="card" style="padding:14px 16px;margin-bottom:14px">
            <div class="filter-bar" id="kindFilter">
                <button class="chip ${state.kind === 'all' ? 'active' : ''}" data-kind="all">全部</button>
                ${ASSET_KINDS.map((k) => `<button class="chip ${state.kind === k.id ? 'active' : ''}" data-kind="${k.id}">
                    ${icon(k.icon, 14)}${k.name}
                </button>`).join('')}
                <span class="spacer"></span>
                <select class="select input-sm" id="subtypeFilter" style="width:132px" aria-label="题材筛选">
                    <option value="all">全部题材</option>
                    ${SUBTYPES.map((s) => `<option value="${s.id}" ${state.subtype === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}
                </select>
                <div class="segmented" id="sortFilter">
                    ${SORTS.map((s) => `<button class="${state.sort === s.id ? 'active' : ''}" data-sort="${s.id}">${s.label}</button>`).join('')}
                </div>
            </div>
            ${state.q ? `<div class="row small" style="margin-top:10px;color:var(--muted)">
                <span>搜索「<b style="color:var(--text)">${escapeHtml(state.q)}</b>」</span>
                <button class="btn btn-sm btn-ghost" id="clearSearch">${icon('x', 13)}清除</button>
            </div>` : ''}
        </div>
        <div class="result-meta">
            <span id="resultCount">加载中…</span>
            <span class="spacer"></span>
            ${overview ? `<span>${icon('zap', 13)} 平台今日已生成 ${num(overview.platform.todayGenerated)} 个产物</span>` : ''}
        </div>
        <div class="work-grid" id="workGrid">${skeletonCards(8)}</div>
        <div class="pagination" id="pager"></div>`;

    const grid = host.querySelector('#workGrid');
    const pager = host.querySelector('#pager');
    const countEl = host.querySelector('#resultCount');

    async function load() {
        grid.innerHTML = skeletonCards(8);
        countEl.textContent = '加载中…';
        try {
            const res = await listWorks(state);
            countEl.textContent = `共 ${res.total} 个作品`;
            if (!res.items.length) {
                grid.innerHTML = `<div style="grid-column:1/-1">${emptyState({
                    title: '没有找到匹配的作品',
                    desc: '试试切换题材筛选，或换一个关键词。',
                    action: '<button class="btn btn-outline" id="resetFilter">重置筛选</button>'
                })}</div>`;
                grid.querySelector('#resetFilter')?.addEventListener('click', () => {
                    state.kind = 'all';
                    state.subtype = 'all';
                    state.q = '';
                    state.sort = 'recommended';
                    window.history.replaceState(null, '', url('index.html'));
                    location.reload();
                });
                pager.innerHTML = '';
                return;
            }
            grid.innerHTML = res.items.map((w) => workCard(w)).join('');
            bindWorkCards(grid, (id) => openWork(id, res.items));
            renderPagination(pager, {
                page: res.page,
                pages: res.pages,
                total: res.total,
                onChange: (page) => {
                    state.page = page;
                    load();
                    window.scrollTo({ top: 320, behavior: 'smooth' });
                }
            });
        } catch (err) {
            countEl.textContent = '加载失败';
            grid.innerHTML = `<div style="grid-column:1/-1">${emptyState({ title: '作品加载失败', desc: err.message, action: '<button class="btn btn-outline" onclick="location.reload()">重试</button>' })}</div>`;
        }
    }

    function openWork(id, list) {
        const target = list.find((w) => w.id === id);
        if (!target) return;
        const route = target.kind === 'app' ? 'app/ai-app-detail.html' : 'assets/detail.html';
        window.location.href = `${url(route)}?id=${encodeURIComponent(id)}`;
    }

    host.querySelector('#kindFilter')?.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-kind]');
        if (!chip) return;
        state.kind = chip.dataset.kind;
        state.page = 1;
        host.querySelectorAll('#kindFilter [data-kind]').forEach((el) => el.classList.toggle('active', el === chip));
        load();
    });

    host.querySelector('#subtypeFilter')?.addEventListener('change', (e) => {
        state.subtype = e.target.value;
        state.page = 1;
        load();
    });

    host.querySelector('#sortFilter')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-sort]');
        if (!btn) return;
        state.sort = btn.dataset.sort;
        host.querySelectorAll('#sortFilter button').forEach((el) => el.classList.toggle('active', el === btn));
        state.page = 1;
        load();
    });

    host.querySelector('#clearSearch')?.addEventListener('click', () => {
        state.q = '';
        window.location.href = url('index.html');
    });

    await load();
}

function heroHtml(overview) {
    const hour = new Date().getHours();
    const greeting = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
    const stats = [
        { label: '我的作品', value: overview ? overview.published : '-', sub: `草稿 ${overview?.drafts ?? 0}` },
        { label: '累计获赞', value: overview ? num(overview.likes) : '-', sub: `收藏 ${overview ? num(overview.favorites) : 0}` },
        { label: '进行中任务', value: overview ? overview.runningTasks : '-', sub: '任务中心查看进度' },
        { label: '算力余额', value: overview ? num(overview.credits) : '-', sub: '积分用于生成与训练' }
    ];
    return `<section class="hero">
        <div class="row between wrap" style="position:relative;z-index:1">
            <div>
                <h2>${greeting}，${escapeHtml(overview ? '欢迎回到灵犀创作台' : '欢迎来到灵犀 AIGC')}</h2>
                <p>角色、道具、场景、短剧与模型，一套资产贯穿整个创作流程。今天平台已生成 ${overview ? num(overview.platform.todayGenerated) : '—'} 个产物。</p>
            </div>
            ${trendHtml(overview)}
        </div>
        <div class="hero-actions">
            <a class="btn btn-primary" href="${url('assets/create-character.html')}">${icon('plus', 15)}开始创作</a>
            <a class="btn" href="${url('tasks.html')}">${icon('clock', 15)}任务中心</a>
            <a class="btn" href="${url('app/ai-apps.html')}">${icon('sparkles', 15)}AI 应用</a>
            <a class="btn" href="${url('lora-train.html')}">${icon('cpu', 15)}训练模型</a>
        </div>
        <div class="row wrap" style="margin-top:20px;gap:34px;position:relative;z-index:1">
            ${stats.map((s) => `<div>
                <div style="font-size:20px;font-weight:700">${typeof s.value === 'number' ? num(s.value) : s.value}</div>
                <div class="small" style="color:rgba(255,255,255,.66)">${s.label} · ${s.sub}</div>
            </div>`).join('')}
        </div>
    </section>
    <div class="quick-grid">
        ${ASSET_KINDS.map((k) => `<a class="quick-tile" href="${url(k.create)}">
            <span class="qt-icon">${icon(k.icon, 17)}</span>
            <span>
                <span class="qt-name">${k.name}</span><br>
                <span class="qt-desc">${k.desc.slice(0, 10)}</span>
            </span>
        </a>`).join('')}
    </div>`;
}

/** 近 7 天平台生成量柱状图（数据直接来自任务表，与后台统计同源） */
function trendHtml(overview) {
    const week = overview?.platform?.week || [];
    if (!week.length) return '';
    const max = Math.max(...week.map((d) => d.generated), 1);
    const total = week.reduce((s, d) => s + d.generated, 0);
    return `<div class="hero-trend">
        <div class="ht-head">
            <span>近 7 天平台生成</span>
            <b>${num(total)}</b>
        </div>
        <div class="ht-bars">
            ${week.map((d) => `<div class="ht-bar" title="${escapeHtml(d.label)}：${d.generated} 个产物 / ${d.tasks} 个任务">
                <i style="height:${Math.max(8, Math.round((d.generated / max) * 100))}%"></i>
                <span>${escapeHtml(d.label)}</span>
            </div>`).join('')}
        </div>
        <div class="ht-foot">今日 ${overview.platform.todayTasks} 个任务 · 消耗 ${num(overview.platform.todayCredits)} 算力</div>
    </div>`;
}
