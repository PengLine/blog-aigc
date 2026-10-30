import { listApps, toggleAppFavorite } from '../core/api.js';
import { APP_CATEGORIES } from '../core/constants.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast, emptyState, renderPagination, skeletonCards, metricCard } from '../core/ui.js';
import { escapeHtml, num } from '../core/format.js';

const SORTS = [
    { id: 'popular', name: '最常使用' },
    { id: 'latest', name: '最新上架' },
    { id: 'rating', name: '评分最高' },
    { id: 'price', name: '价格最低' }
];

export async function render(host, ctx) {
    const mineOnly = !!ctx.query.mine;
    setPageTitle(mineOnly ? '我的应用' : 'AI 应用');
    const state = {
        category: ctx.query.category || 'all',
        sort: ctx.query.sort || 'popular',
        q: ctx.query.q || '',
        page: 1,
        pageSize: 9,
        mine: mineOnly
    };

    const mine = await listApps({ pageSize: 100, mine: true }).catch(() => ({ items: [] }));

    host.innerHTML = `
        <div class="page-head">
            <div class="page-head-main">
                <h1 class="page-title">${mineOnly ? '我的应用' : 'AI 应用'}</h1>
                <div class="page-sub">把模型与工作流封装成开箱即用的能力，输入参数即可产出可交付内容</div>
            </div>
            <div class="page-actions">
                <a class="btn btn-outline" href="${url('ai-workflow-execute.html')}">${icon('workflow', 15)}工作流编排</a>
                <a class="btn btn-primary" href="${url('app/ai-app-create.html')}">${icon('plus', 15)}创建应用</a>
            </div>
        </div>

        <div class="grid cols-3" style="margin-bottom:16px">
            ${metricCard({ label: '上架应用', value: num(100 + (mine.items.length || 0)), sub: '覆盖图像、视频、文案与设计', iconName: 'sparkles' })}
            ${metricCard({ label: '我创建的应用', value: String(mine.items.filter((a) => a.isMine).length), sub: '可在创建页继续迭代版本', iconName: 'layers' })}
            ${metricCard({ label: '今日运行量', value: num(8642), sub: '平台全量统计', iconName: 'zap' })}
        </div>

        <div class="card" style="padding:12px 14px;margin-bottom:14px">
            <div class="asset-toolbar">
                <div class="chips" id="catFilter">
                    <a class="chip ${!mineOnly ? 'active' : ''}" href="${url('app/ai-apps.html')}">全部应用</a>
                    <a class="chip ${mineOnly ? 'active' : ''}" href="${url('assets/my-assets-app.html')}">我创建的</a>
                    <span style="width:1px;height:20px;background:var(--border);margin:0 4px"></span>
                    ${APP_CATEGORIES.filter((c) => c.id !== 'all').map((c) => `<button class="chip ${state.category === c.id ? 'active' : ''}" data-cat="${c.id}">${c.name}</button>`).join('')}
                </div>
                <span class="spacer"></span>
                <div class="search" style="max-width:220px">
                    <span class="search-icon">${icon('search', 15)}</span>
                    <input id="appSearch" placeholder="搜索应用" value="${escapeHtml(state.q)}">
                </div>
                <select class="select input-sm" id="appSort" style="width:126px" aria-label="排序">
                    ${SORTS.map((s) => `<option value="${s.id}" ${state.sort === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}
                </select>
            </div>
        </div>

        <div id="appBody">${skeletonCards(6, 150)}</div>
        <div class="pagination" id="appPager" style="margin-top:16px"></div>`;

    const bodyEl = host.querySelector('#appBody');
    const pagerEl = host.querySelector('#appPager');

    async function load() {
        bodyEl.innerHTML = skeletonCards(6, 150);
        try {
            const res = await listApps(state);
            if (!res.items.length) {
                bodyEl.innerHTML = emptyState({
                    title: '没有找到匹配的应用',
                    desc: '换个关键词或切换分类看看，也可以自己创建一个应用。',
                    action: `<a class="btn btn-primary" href="${url('app/ai-app-create.html')}">${icon('plus', 14)}创建应用</a>`
                });
                pagerEl.innerHTML = '';
                return;
            }
            bodyEl.innerHTML = `<div class="grid cols-3" style="gap:14px">${res.items.map(appCard).join('')}</div>`;
            bindCards();
            renderPagination(pagerEl, {
                page: res.page,
                pages: res.pages,
                total: res.total,
                pageSize: res.pageSize,
                onChange: (page) => {
                    state.page = page;
                    load();
                    window.scrollTo({ top: 240, behavior: 'smooth' });
                }
            });
        } catch (err) {
            bodyEl.innerHTML = emptyState({ title: '应用加载失败', desc: err.message, action: '<button class="btn btn-outline" data-retry>重试</button>' });
        }
    }

    function appCard(app) {
        return `<article class="app-card" data-app="${app.id}">
            <div class="row between" style="align-items:flex-start">
                <span class="app-icon ${app.iconTone || ''}">${escapeHtml(app.icon)}</span>
                <button class="icon-btn" data-fav="${app.id}" title="${app.favorite ? '取消收藏' : '收藏'}" style="color:${app.favorite ? 'var(--warn)' : 'var(--muted)'}">
                    ${icon('star', 16)}
                </button>
            </div>
            <h4>${escapeHtml(app.name)}${app.isMine ? '<span class="badge badge-brand" style="margin-left:6px">我的</span>' : ''}</h4>
            <p class="desc">${escapeHtml(app.desc)}</p>
            <div class="row wrap" style="gap:4px;margin-bottom:8px">
                ${app.tags.slice(0, 3).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
            </div>
            <div class="foot">
                <span class="rating">${icon('star', 12)} ${app.rating.toFixed(1)}</span>
                <span class="muted small">${num(app.runs)} 次</span>
                <span class="spacer"></span>
                <span class="tag tag-brand">${app.price > 0 ? `${app.price} 算力` : '免费'}</span>
            </div>
        </article>`;
    }

    function bindCards() {
        bodyEl.querySelectorAll('.app-card').forEach((card) => {
            card.addEventListener('click', (e) => {
                const fav = e.target.closest('[data-fav]');
                if (fav) {
                    e.stopPropagation();
                    toggleAppFavorite(fav.dataset.fav).then((res) => {
                        toast(res.active ? '已收藏' : '已取消收藏', 'success');
                        load();
                    }).catch((err) => toast(err.message, 'error'));
                    return;
                }
                window.location.href = `${url('app/ai-app-detail.html')}?id=${encodeURIComponent(card.dataset.app)}`;
            });
        });
    }

    host.querySelector('#catFilter')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cat]');
        if (!btn) return;
        state.category = btn.dataset.cat;
        state.page = 1;
        host.querySelectorAll('#catFilter .chip').forEach((el) => el.classList.toggle('active', el === btn));
        load();
    });

    host.querySelector('#appSort')?.addEventListener('change', (e) => {
        state.sort = e.target.value;
        state.page = 1;
        load();
    });

    let timer = null;
    host.querySelector('#appSearch')?.addEventListener('input', (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            state.q = e.target.value.trim();
            state.page = 1;
            load();
        }, 300);
    });

    bodyEl.addEventListener('click', (e) => {
        if (e.target.closest('[data-retry]')) load();
    });

    await load();
}
