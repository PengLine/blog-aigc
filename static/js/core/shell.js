/**
 * 全局外壳：侧边导航 + 顶栏（搜索 / 通知 / 余额 / 账户）
 */
import { escapeHtml, num, timeAgo } from './format.js';
import { icon, avatarTag, toast, confirmDialog, openModal, closeModal } from './ui.js';
import { currentPublicUser, demoAccounts, loginAs, isOps } from './auth.js';
import { getAccount } from './db.js';
import { PLAN_MAP } from './constants.js';
import { getUnreadCount, listNotifications, markAllNotificationsRead } from './api.js';
import { on, EVENTS } from './bus.js';
import { resetDemo } from './api.js';

export const ROOT = document.documentElement.dataset.root || './';

export function url(path = '') {
    return `${ROOT}${path.replace(/^\.?\//, '')}`;
}

const NAV_ITEMS = [
    {
        title: '创作',
        items: [
            { key: 'gallery', label: '发现广场', href: 'index.html', icon: 'grid' },
            { key: 'create', label: '创作中心', href: 'assets/create-character.html', icon: 'plus' },
            { key: 'assets', label: '资产库', href: 'assets/my-assets.html', icon: 'layers' },
            { key: 'apps', label: 'AI 应用', href: 'app/ai-apps.html', icon: 'sparkles' }
        ]
    },
    {
        title: '算力',
        items: [
            { key: 'train', label: '模型训练', href: 'lora-train.html', icon: 'cpu' },
            { key: 'workflow', label: '工作流', href: 'ai-workflow-execute.html', icon: 'workflow' },
            { key: 'tasks', label: '任务中心', href: 'tasks.html', icon: 'clock', badge: 'running' }
        ]
    },
    {
        title: '账户',
        items: [
            { key: 'profile', label: '个人中心', href: 'profile.html', icon: 'user' },
            { key: 'wallet', label: '钱包与订阅', href: 'wallet.html', icon: 'wallet' },
            { key: 'notifications', label: '通知中心', href: 'notifications.html', icon: 'bell', badge: 'unread' },
            { key: 'admin', label: '平台管理', href: 'admin.html', icon: 'shield', opsOnly: true }
        ]
    }
];

function navHtml(active) {
    const user = currentPublicUser();
    const ops = isOps();
    return NAV_ITEMS.map((group) => {
        const items = group.items.filter((item) => !item.opsOnly || ops);
        if (!items.length) return '';
        return `<div class="nav-group">
            <div class="nav-group-title">${escapeHtml(group.title)}</div>
            ${items.map((item) => `<a class="nav-item ${active === item.key ? 'active' : ''}" href="${url(item.href)}" data-nav="${item.key}">
                <span class="nav-icon">${icon(item.icon, 18)}</span>
                <span>${escapeHtml(item.label)}</span>
                ${item.badge === 'unread' ? `<span class="nav-badge" data-unread hidden>0</span>` : ''}
                ${item.badge === 'running' ? `<span class="nav-badge" data-running hidden>0</span>` : ''}
            </a>`).join('')}
        </div>`;
    }).join('') + `<div class="nav-group">
        <a class="nav-item" href="https://pengline.cn" target="_blank" rel="sponsored nofollow noopener">
            <span class="nav-icon">${icon('link', 18)}</span><span>博客</span>
        </a>
    </div>`;
}

export function renderShell({ nav = 'gallery', title = '工作台' } = {}) {
    const app = document.getElementById('app');
    const user = currentPublicUser();
    // 外壳是同步渲染，账号余额直接读仓储，避免异步接口返回 Promise
    const account = getAccount(user.id);
    const plan = PLAN_MAP[account.plan] || PLAN_MAP.free;
    const quota = plan.credits || 3000;
    const unread = getUnreadCount();

    app.innerHTML = `
    <aside class="sidebar" id="sidebar">
        <a class="brand" href="${url('index.html')}">
            <span class="brand-logo">灵</span>
            <span>
                <span class="brand-name">灵犀 AIGC</span>
                <span class="brand-tag">Creative Studio</span>
            </span>
        </a>
        <nav>${navHtml(nav)}</nav>
        <div class="sidebar-foot">
            <div class="credit-card">
                <div class="row between">
                    <span class="credit-label">算力积分</span>
                    <a class="credit-link" href="${url('wallet.html')}">充值 ${icon('chevron-right', 12)}</a>
                </div>
                <div class="credit-value" data-credit-value>${num(account.credits)}</div>
                <div class="credit-bar"><i data-credit-bar style="width:${Math.min(100, Math.round((account.credits / quota) * 100))}%"></i></div>
                <div class="row between">
                    <span class="credit-label">${escapeHtml(plan.name)}</span>
                    <a class="credit-link" href="${url('wallet.html')}">管理</a>
                </div>
            </div>
        </div>
    </aside>
    <div class="scrim hidden" id="scrim"></div>
    <div class="main">
        <header class="topbar">
            <button class="icon-btn mobile-bar" id="menuBtn" aria-label="打开菜单">${icon('menu', 18)}</button>
            <div class="crumb"><span>灵犀</span><span>/</span><b id="crumbTitle">${escapeHtml(title)}</b></div>
            <div class="topbar-spacer"></div>
            <form class="search" id="globalSearch">
                <span class="search-icon">${icon('search', 15)}</span>
                <input type="search" name="q" placeholder="搜索作品、应用、创作者" autocomplete="off">
                <kbd>Ctrl K</kbd>
            </form>
            <a class="btn btn-primary btn-sm" href="${url('assets/create-character.html')}">${icon('plus', 15)}新建</a>
            <a class="balance-chip" href="${url('wallet.html')}" title="算力积分余额">
                ${icon('credit', 15)}<span data-credit-chip>${num(account.credits)}</span><span style="opacity:.7">算力</span>
            </a>
            <div class="dropdown">
                <button class="icon-btn" id="notifBtn" aria-label="通知">
                    ${icon('bell', 18)}
                    ${unread ? `<span class="dot" data-unread-dot>${unread > 99 ? '99+' : unread}</span>` : '<span class="dot" data-unread-dot hidden>0</span>'}
                </button>
                <div class="menu" id="notifMenu" hidden style="width:330px;padding:0">
                    <div class="row between" style="padding:12px 14px;border-bottom:1px solid var(--border)">
                        <b style="font-size:13px">通知</b>
                        <button class="small" style="color:var(--brand)" id="markAllRead">全部已读</button>
                    </div>
                    <div id="notifList" style="max-height:360px;overflow:auto"></div>
                    <a class="menu-item" href="${url('notifications.html')}" style="justify-content:center;color:var(--brand);font-size:12.5px">查看全部通知</a>
                </div>
            </div>
            <div class="dropdown">
                <button class="user-chip" id="userBtn">
                    ${avatarTag(user)}
                    <span class="meta" style="text-align:left">
                        <span class="name">${escapeHtml(user.name)}</span><br>
                        <span class="plan">${escapeHtml(plan.name)} · Lv.${user.level}</span>
                    </span>
                    ${icon('chevron-down', 14)}
                </button>
                <div class="menu" id="userMenu" hidden>
                    <div class="menu-head">${escapeHtml(user.name)} @${escapeHtml(user.handle)}</div>
                    <a class="menu-item" href="${url(`profile.html?uid=${user.id}`)}">${icon('user', 15)}个人主页</a>
                    <a class="menu-item" href="${url('wallet.html')}">${icon('wallet', 15)}钱包与订阅</a>
                    <a class="menu-item" href="${url('tasks.html')}">${icon('clock', 15)}我的任务</a>
                    <button class="menu-item" id="switchAccount">${icon('users', 15)}切换演示账号</button>
                    <div class="menu-sep"></div>
                    <button class="menu-item" id="resetDemo">${icon('refresh', 15)}重置演示数据</button>
                </div>
            </div>
        </header>
        <main class="page" id="page-content"></main>
    </div>`;

    bindShellEvents({ setTitle: (t) => setTitle(t) });

    on(EVENTS.credits, ({ credits }) => updateCredits(credits, quota));
    on(EVENTS.notify, () => refreshUnread());

    function setTitle(next) {
        const el = document.getElementById('crumbTitle');
        if (el) el.textContent = next;
        document.title = `${next} · 灵犀 AIGC`;
    }

    return { content: document.getElementById('page-content'), setTitle, app };
}

function updateCredits(credits, quota = 3000) {
    document.querySelectorAll('[data-credit-value], [data-credit-chip]').forEach((el) => {
        el.textContent = num(credits);
    });
    const bar = document.querySelector('[data-credit-bar]');
    if (bar) bar.style.width = `${Math.min(100, Math.round((credits / quota) * 100))}%`;
}

export async function refreshUnread() {
    const count = getUnreadCount();
    const dots = document.querySelectorAll('[data-unread-dot]');
    dots.forEach((dot) => {
        dot.textContent = count > 99 ? '99+' : count;
        dot.hidden = count === 0;
    });
    document.querySelectorAll('[data-unread]').forEach((el) => {
        el.textContent = count;
        el.hidden = count === 0;
    });
    return count;
}

async function renderNotifList() {
    const host = document.getElementById('notifList');
    if (!host) return;
    host.innerHTML = `<div class="empty" style="padding:24px">加载中…</div>`;
    const { items } = await listNotifications();
    if (!items.length) {
        host.innerHTML = `<div class="empty" style="padding:28px 16px"><p style="margin:0">暂无通知</p></div>`;
        return;
    }
    host.innerHTML = items.slice(0, 5).map((n) => `<a class="menu-item" href="${n.link ? url(n.link) : '#'}" style="align-items:flex-start;gap:9px;padding:10px 14px">
        <span style="color:var(--${n.tone || 'brand'});margin-top:2px">${icon(n.type === 'task' ? 'clock' : n.type === 'review' ? 'shield' : n.type === 'billing' ? 'wallet' : 'bell', 15)}</span>
        <span style="flex:1;min-width:0">
            <span style="display:block;font-size:12.5px;font-weight:600;color:var(--text)">${escapeHtml(n.title)}</span>
            <span style="display:block;font-size:11.5px;color:var(--muted);margin-top:2px" class="clamp-2">${escapeHtml(n.body)}</span>
            <span style="display:block;font-size:11px;color:var(--muted-2);margin-top:3px">${timeAgo(n.createdAt)}</span>
        </span>
        ${n.read ? '' : '<i style="width:6px;height:6px;border-radius:50%;background:var(--brand);margin-top:6px"></i>'}
    </a>`).join('');
}

function bindShellEvents({ setTitle }) {
    const sidebar = document.getElementById('sidebar');
    const scrim = document.getElementById('scrim');
    const menuBtn = document.getElementById('menuBtn');
    const openSidebar = (open) => {
        sidebar?.classList.toggle('open', open);
        scrim?.classList.toggle('hidden', !open);
    };
    menuBtn?.addEventListener('click', () => openSidebar(true));
    scrim?.addEventListener('click', () => openSidebar(false));

    document.getElementById('globalSearch')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const q = String(new FormData(e.target).get('q') || '').trim();
        window.location.href = `${url('index.html')}${q ? `?q=${encodeURIComponent(q)}` : ''}`;
    });

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            const input = document.querySelector('#globalSearch input');
            if (input) {
                input.focus();
                input.select();
            }
        }
    });

    const drop = (btnId, menuId) => {
        const btn = document.getElementById(btnId);
        const menu = document.getElementById(menuId);
        if (!btn || !menu) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = menu.hidden;
            document.querySelectorAll('.menu').forEach((m) => {
                m.hidden = true;
            });
            menu.hidden = !willOpen;
            if (willOpen && menuId === 'notifMenu') renderNotifList();
        });
    };
    drop('notifBtn', 'notifMenu');
    drop('userBtn', 'userMenu');
    document.addEventListener('click', () => {
        document.querySelectorAll('.menu').forEach((m) => {
            m.hidden = true;
        });
    });
    document.querySelectorAll('.menu').forEach((m) => m.addEventListener('click', (e) => e.stopPropagation()));

    document.getElementById('markAllRead')?.addEventListener('click', async () => {
        await markAllNotificationsRead();
        await refreshUnread();
        renderNotifList();
        toast('已全部标记为已读', 'success');
    });

    document.getElementById('switchAccount')?.addEventListener('click', () => {
        const accounts = demoAccounts();
        openModal({
            title: '切换演示账号',
            size: 'sm',
            body: `<div class="col" style="gap:8px">${accounts.map((u) => `<button class="asset-type-card" data-uid="${u.id}" style="width:100%;text-align:left">
                ${avatarTag(u)}
                <span style="flex:1">
                    <span class="at-name" style="display:block">${escapeHtml(u.name)} ${u.role === 'ops' ? '<span class="badge badge-violet">运营</span>' : ''}</span>
                    <span class="at-meta">@${escapeHtml(u.handle)} · ${u.role === 'ops' ? '内容审核与平台管理' : '创作者'}</span>
                </span>
                ${icon('chevron-right', 14)}
            </button>`).join('')}</div>
            <p class="hint mt-12">演示账号用于体验不同角色权限，切换后页面将刷新。</p>`,
            onMount(card) {
                card.querySelectorAll('[data-uid]').forEach((el) => {
                    el.addEventListener('click', () => {
                        loginAs(el.dataset.uid);
                        closeModal();
                        window.location.reload();
                    });
                });
            }
        });
    });

    document.getElementById('resetDemo')?.addEventListener('click', async () => {
        const ok = await confirmDialog({
            title: '重置演示数据',
            message: '将清空本地产生的全部创作、任务与积分记录，并恢复到初始演示数据。此操作不可撤销。',
            confirmText: '确认重置',
            danger: true
        });
        if (!ok) return;
        await resetDemo();
        toast('演示数据已重置', 'success');
        setTimeout(() => window.location.reload(), 400);
    });

    refreshUnread();
}

/** 页面内轻量刷新：视图可调用以更新顶栏标题 */
export function setPageTitle(title) {
    const el = document.getElementById('crumbTitle');
    if (el) el.textContent = title;
    document.title = `${title} · 灵犀 AIGC`;
}

export function pageHeader({ title, sub = '', actions = '', badge = '' }) {
    return `<div class="page-head">
        <div class="page-head-main">
            <h1 class="page-title">${escapeHtml(title)} ${badge}</h1>
            ${sub ? `<div class="page-sub">${escapeHtml(sub)}</div>` : ''}
        </div>
        ${actions ? `<div class="page-actions">${actions}</div>` : ''}
    </div>`;
}
