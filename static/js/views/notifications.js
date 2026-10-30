import { listNotifications, markNotificationRead, markAllNotificationsRead } from '../core/api.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast, emptyState, confirmDialog } from '../core/ui.js';
import { escapeHtml, num, timeAgo } from '../core/format.js';

const TYPE_META = {
    review: { name: '审核', icon: 'shield' },
    task: { name: '任务', icon: 'cpu' },
    billing: { name: '计费', icon: 'wallet' },
    social: { name: '互动', icon: 'heart' },
    system: { name: '公告', icon: 'info' }
};

const FILTERS = [
    { id: 'all', name: '全部' },
    { id: 'unread', name: '未读' },
    { id: 'review', name: '审核' },
    { id: 'task', name: '任务' },
    { id: 'billing', name: '计费' },
    { id: 'social', name: '互动' },
    { id: 'system', name: '公告' }
];

export async function render(host, ctx) {
    setPageTitle('通知中心');
    const data = await listNotifications();
    const state = { filter: ctx.query.filter || 'all', items: data.items };

    host.innerHTML = `
        <div class="page-head">
            <div class="page-head-main">
                <h1 class="page-title">通知中心
                    <span class="badge badge-danger" id="unreadBadge" ${data.unread ? '' : 'hidden'}>${data.unread} 条未读</span></h1>
                <div class="page-sub">审核结论、任务完成、算力变动与互动消息都会汇总到这里</div>
            </div>
            <div class="page-actions">
                <button class="btn btn-outline" id="readAllBtn">${icon('check', 15)}全部标为已读</button>
            </div>
        </div>

        <div class="card" style="padding:12px 14px;margin-bottom:14px">
            <div class="chips" id="notifFilter">
                ${FILTERS.map((f) => `<button class="chip ${state.filter === f.id ? 'active' : ''}" data-filter="${f.id}">${f.name}
                    <span class="small" data-num="${f.id}"></span></button>`).join('')}
            </div>
        </div>

        <div class="card">
            <div class="card-body" id="notifList" style="padding:4px 16px"></div>
        </div>`;

    const listEl = host.querySelector('#notifList');

    function filtered() {
        if (state.filter === 'all') return state.items;
        if (state.filter === 'unread') return state.items.filter((n) => !n.read);
        return state.items.filter((n) => n.type === state.filter);
    }

    function paintCounts() {
        const counts = {
            all: state.items.length,
            unread: state.items.filter((n) => !n.read).length
        };
        Object.keys(TYPE_META).forEach((type) => {
            counts[type] = state.items.filter((n) => n.type === type).length;
        });
        host.querySelectorAll('[data-num]').forEach((el) => {
            const n = counts[el.dataset.num] || 0;
            el.textContent = n ? `· ${n}` : '';
        });
        const badge = host.querySelector('#unreadBadge');
        const unread = counts.unread;
        if (badge) {
            badge.hidden = unread === 0;
            badge.textContent = `${unread} 条未读`;
        }
    }

    function draw() {
        const list = filtered();
        paintCounts();
        if (!list.length) {
            listEl.innerHTML = emptyState({
                title: state.filter === 'unread' ? '没有未读通知' : '暂无通知',
                desc: state.filter === 'unread' ? '所有消息都已处理完毕。' : '发布作品、运行任务后，相关消息会出现在这里。'
            });
            return;
        }
        listEl.innerHTML = list.map((n) => {
            const meta = TYPE_META[n.type] || TYPE_META.system;
            return `<div class="notif-item ${n.read ? '' : 'unread'}" data-id="${n.id}">
                <span class="notif-icon ${n.tone || ''}">${icon(meta.icon, 15)}</span>
                <div class="notif-main">
                    <b>${escapeHtml(n.title)}</b>
                    <p>${escapeHtml(n.body)}</p>
                    <div class="row small muted" style="gap:10px;margin-top:4px">
                        <span>${meta.name}</span><span>${timeAgo(n.createdAt)}</span>
                        ${n.link ? '<span style="color:var(--brand)">点击查看详情</span>' : ''}
                    </div>
                </div>
                <div class="row" style="gap:6px">
                    ${n.read ? '' : `<button class="btn btn-sm btn-ghost" data-read="${n.id}">${icon('check', 13)}已读</button>`}
                </div>
            </div>`;
        }).join('');
    }

    listEl.addEventListener('click', async (e) => {
        const readBtn = e.target.closest('[data-read]');
        if (readBtn) {
            e.stopPropagation();
            await markNotificationRead(readBtn.dataset.read);
            const item = state.items.find((n) => n.id === readBtn.dataset.read);
            if (item) item.read = true;
            draw();
            return;
        }
        const row = e.target.closest('[data-id]');
        if (!row) return;
        const item = state.items.find((n) => n.id === row.dataset.id);
        if (!item) return;
        if (!item.read) {
            await markNotificationRead(item.id);
            item.read = true;
            draw();
        }
        if (item.link) {
            window.location.href = url(item.link);
        }
    });

    host.querySelector('#notifFilter')?.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-filter]');
        if (!chip) return;
        state.filter = chip.dataset.filter;
        host.querySelectorAll('#notifFilter .chip').forEach((el) => el.classList.toggle('active', el === chip));
        draw();
    });

    host.querySelector('#readAllBtn')?.addEventListener('click', async () => {
        if (!state.items.some((n) => !n.read)) {
            toast('没有未读通知');
            return;
        }
        const ok = await confirmDialog({
            title: '全部标为已读',
            message: `将把 ${state.items.filter((n) => !n.read).length} 条未读通知标记为已读。`,
            confirmText: '确认'
        });
        if (!ok) return;
        await markAllNotificationsRead();
        state.items.forEach((n) => {
            n.read = true;
        });
        toast('已全部标为已读', 'success');
        draw();
    });

    draw();
}
