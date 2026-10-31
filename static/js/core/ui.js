/**
 * 通用 UI 组件：图标、提示、弹窗、卡片、分页、空态等
 */
import { escapeHtml, num, timeAgo, placeholder, avatarFallback, fmtDuration } from './format.js';
import { kindMeta, statusMeta } from './constants.js';
import { artCover, POSTER_SECOND, useArtCover } from './cover.js';

/* ------------------------------ 图标 ------------------------------ */
const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
    sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"/><path d="M18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9L18 16Z"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    workflow: '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M9 6h4a2 2 0 0 1 2 2v7"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M10.5 20a2 2 0 0 0 3 0"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
    wallet: '<path d="M3 7a3 3 0 0 1 3-3h12v4"/><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M16 13h3"/>',
    receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-3-2V3Z"/><path d="M9 8h6M9 12h6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>',
    shield: '<path d="M12 3 4 6v6c0 5 4 8 8 9 4-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-left': '<path d="m15 6-6 6 6 6"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'arrow-left': '<path d="M20 12H4"/><path d="m10 6-6 6 6 6"/>',
    'arrow-right': '<path d="M4 12h16"/><path d="m14 6 6 6-6 6"/>',
    'arrow-up': '<path d="M12 20V4"/><path d="m6 10 6-6 6 6"/>',
    'arrow-down': '<path d="M12 4v16"/><path d="m6 14 6 6 6-6"/>',
    heart: '<path d="M12 20s-7-4.4-7-9.3A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7 3.7C19 15.6 12 20 12 20Z"/>',
    star: '<path d="m12 3 2.7 5.6 6.3.9-4.5 4.4 1 6.1-5.5-2.9-5.5 2.9 1-6.1L3 9.5l6.3-.9L12 3Z"/>',
    comment: '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>',
    download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
    play: '<path d="M8 5v14l11-7-11-7Z"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    edit: '<path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="m14 6 4 4"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    upload: '<path d="M12 20V8"/><path d="m7 12 5-5 5 5"/><path d="M4 4h16"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5L5 20"/>',
    video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
    box: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5"/><path d="M12 12v9"/>',
    map: '<path d="m9 4 6 2 6-2v14l-6 2-6-2-6 2V6l6-2Z"/><path d="M9 4v14M15 6v14"/>',
    eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    external: '<path d="M14 4h6v6"/><path d="m20 4-8 8"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    logout: '<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4"/><path d="m16 8 4 4-4 4"/><path d="M20 12H9"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1 2 2 0 1 1-4 0 1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4.6 15a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 11 4.6a2 2 0 1 1 4 0 1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7 2 2 0 1 1 0 4 1.6 1.6 0 0 0-1.5.9Z"/>',
    filter: '<path d="M4 5h16l-6 7v6l-4 2v-8L4 5Z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    zap: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>',
    credit: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5h3.8a1.7 1.7 0 0 1 0 3.4H9.5"/>',
    alert: '<path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v5M12 18h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 8h.01"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-5.5 6.5-5.5s6.5 1.9 6.5 5.5"/><path d="M16 5.2a3.5 3.5 0 0 1 0 5.6"/><path d="M18 14.5c2.2.6 3.5 2.1 3.5 4.5"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
    'trend-up': '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    'trend-down': '<path d="m3 7 6 6 4-4 8 8"/><path d="M15 17h6v-6"/>',
    'chevrons-left': '<path d="m11 6-6 6 6 6"/><path d="m18 6-6 6 6 6"/>',
    'chevrons-right': '<path d="m13 6 6 6-6 6"/><path d="m6 6 6 6-6 6"/>',
    gridView: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
    'eye-off': '<path d="M3 3l18 18"/><path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.4 3.9"/><path d="M6.6 8.2A16.6 16.6 0 0 0 2 12s3.6 6 10 6a9.6 9.6 0 0 0 4.2-.9"/><path d="M9.9 10.1a2.5 2.5 0 0 0 3.5 3.5"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
    database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    rocket: '<path d="M5 15c-1 2-1 5-1 5s3 0 5-1"/><path d="M9 15 5 11a9 9 0 0 1 9-8h5v5a9 9 0 0 1-8 9l-4-4Z"/><circle cx="15" cy="9" r="1.5"/>',
    flame: '<path d="M12 22c4 0 6-2.7 6-6 0-4.5-6-10-6-10S6 11.5 6 16c0 3.3 2 6 6 6Z"/><path d="M12 22c1.7 0 3-1.3 3-3 0-2-3-5-3-5s-3 3-3 5c0 1.7 1.3 3 3 3Z"/>',
    tag: '<path d="M3 12V4h8l9 9-8 8-9-9Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/>',
    pause: '<rect x="7" y="5" width="3" height="14" rx="1"/><rect x="14" y="5" width="3" height="14" rx="1"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    scroll: '<path d="M7 3h11a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5"/><path d="M6 5a2 2 0 0 0-3 2v9a2 2 0 0 1 2-2h1"/><path d="M11 8h6M11 12h6M11 16h3"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 12h18"/><path d="M3 8h4M3 16h4M17 8h4M17 16h4"/>',
    wand: '<path d="m15 4 5 5"/><path d="M4 20 15 9"/><path d="M14 3h.01M21 10h.01M19 18h.01M6 4h.01"/>'
};

export function icon(name, size = 16) {
    const inner = ICONS[name] || ICONS.info;
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

/* ------------------------------ 基础渲染 ------------------------------ */
const IMG_FALLBACK = "this.onerror=null;if(window.__coverFallback)this.src=window.__coverFallback(this.dataset.fbTitle,this.dataset.fbPrompt,this.dataset.fbKind)";
export function imgTag(src, alt = '', cls = '', extra = '') {
    const fallback = escapeHtml(alt || 'AIGC');
    // 空 src / 失效演示图床 → 直接确定性封面；否则先试真图，失败回退
    const effective = useArtCover(src) ? artCover({ title: alt || 'AIGC' }) : src;
    const safeSrc = escapeHtml(effective);
    return `<img src="${safeSrc}" alt="${escapeHtml(alt)}" class="${cls}" loading="lazy" data-fb-title="${fallback}" onerror="${IMG_FALLBACK}" ${extra}>`;
}

export function avatarTag(user, size = '', extraClass = '') {
    const name = user?.name || '匿名';
    // 失效演示图床的头像（所有人同一张占位图）降级为彩色首字母头像
    const src = user?.avatar && !useArtCover(user.avatar) ? user.avatar : avatarFallback(name);
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(name)}" class="avatar ${size} ${extraClass}" loading="lazy" onerror="this.onerror=null;this.src='${avatarFallback(name)}'">`;
}

export function statusBadge(status) {
    const meta = statusMeta(status);
    const map = { ok: 'badge-ok', warn: 'badge-warn', danger: 'badge-danger', brand: 'badge-brand' };
    const tone = status === 'running' ? 'badge-brand' : map[meta.tone] || '';
    return `<span class="badge ${tone}"><i class="dot-mark"></i>${escapeHtml(meta.label)}</span>`;
}

export function kindBadge(kind) {
    const meta = kindMeta(kind);
    return `<span class="badge badge-${meta.tone === 'brand' ? 'brand' : meta.tone}">${escapeHtml(meta.name)}</span>`;
}

export function progressBar(value, tone = '', striped = false) {
    const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    return `<div class="progress ${tone} ${striped ? 'progress-striped' : ''}"><i style="width:${v}%"></i></div>`;
}

export function metricCard({ label, value, sub, iconName = 'zap', trend = '' }) {
    return `<div class="metric">
        <div class="row between">
            <span class="metric-label">${icon(iconName, 15)} ${escapeHtml(label)}</span>
            ${trend ? `<span class="metric-trend ${trend.startsWith('-') ? 'down' : ''}">${icon(trend.startsWith('-') ? 'trend-down' : 'trend-up', 13)}${escapeHtml(trend)}</span>` : ''}
        </div>
        <div class="metric-value">${value}</div>
        ${sub ? `<div class="small muted">${escapeHtml(sub)}</div>` : ''}
    </div>`;
}

export function emptyState({ title = '暂无数据', desc = '', action = '' }) {
    return `<div class="empty">
        <div class="empty-icon">${icon('layers', 24)}</div>
        <h4>${escapeHtml(title)}</h4>
        ${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
        ${action}
    </div>`;
}

export function skeletonCards(count = 8, height = 170) {
    return Array.from({ length: count }, () => `
        <div class="skeleton-card">
            <div class="skeleton sk-media" style="height:${height}px"></div>
            <div class="sk-body">
                <div class="skeleton sk-line" style="width:70%"></div>
                <div class="skeleton sk-line" style="width:40%"></div>
            </div>
        </div>`).join('');
}

export function skeletonRows(count = 5) {
    return `<div class="card">${Array.from({ length: count }, () => `
        <div class="asset-row">
            <div class="skeleton" style="width:54px;height:42px;border-radius:8px"></div>
            <div style="flex:1">
                <div class="skeleton sk-line" style="width:40%;margin-bottom:8px"></div>
                <div class="skeleton sk-line" style="width:24%"></div>
            </div>
            <div class="skeleton" style="width:60px;height:22px;border-radius:11px"></div>
        </div>`).join('')}</div>`;
}

/* ------------------------------ 作品卡片 ------------------------------ */
/**
 * 媒体缩略图：
 * - 视频：用 seek 到第 3 秒的 <video> 真实帧（显示不需 CORS），未加载时先显示 poster=artCover；
 *   由 cover.js 的 IntersectionObserver 惰性接管。
 * - 图片：优先真图，失败回退 artCover。
 */
export function mediaThumb(work, cls = '') {
    const isVideo = (work.mediaType === 'video' || work.kind === 'video')
        && !!work.mediaUrl && /^https?:/i.test(work.mediaUrl);
    // 卡片媒体框为 4:3，封面同比例生成避免 object-fit:cover 裁掉标题
    const fb = artCover({
        title: work.title,
        prompt: work.prompt,
        kind: isVideo ? 'video' : 'image',
        second: isVideo ? POSTER_SECOND : null,
        width: 512,
        height: 384
    });
    if (isVideo) {
        return `<video class="vid-thumb ${cls}" muted playsinline preload="none" tabindex="-1" aria-hidden="true"
            poster="${escapeHtml(fb)}" data-thumb-src="${escapeHtml(work.mediaUrl)}" data-thumb-at="${POSTER_SECOND}"></video>`;
    }
    const cover = useArtCover(work.cover) ? fb : work.cover;
    return `<img src="${escapeHtml(cover)}" alt="${escapeHtml(work.title)}" class="${cls}" loading="lazy"
        data-fb-title="${escapeHtml(work.title)}" data-fb-prompt="${escapeHtml(work.prompt || '')}" data-fb-kind="image"
        onerror="${IMG_FALLBACK}">`;
}

/** 可播放的视频舞台：无有效封面时用 artCover 兑底，避免黑底 */
export function videoStage(output, opts = {}) {
    const src = output.url || output.mediaUrl || '';
    const poster = (output.poster && !/text_to_image/.test(output.poster))
        ? output.poster
        : artCover({ title: opts.title || output.title || '', prompt: opts.prompt || '', kind: 'video', second: POSTER_SECOND });
    return `<video controls preload="metadata" class="${opts.cls || ''}" poster="${escapeHtml(poster)}" src="${escapeHtml(src)}"
        ${opts.extra || 'style="width:100%;display:block"'}>您的浏览器不支持视频播放</video>`;
}

export function workCard(work, options = {}) {
    const { showStatus = false, showAuthor = true, showStats = true, actions = '' } = options;
    const meta = kindMeta(work.kind);
    const isVideo = work.kind === 'video';
    const statusHtml = showStatus && work.status !== 'published' ? statusBadge(work.status) : '';
    return `<article class="work-card" data-work-id="${escapeHtml(work.id)}">
        <div class="work-media">
            ${mediaThumb(work)}
            <div class="media-badges">
                <span class="media-badge">${icon(meta.icon, 11)} ${escapeHtml(meta.name)}</span>
                ${isVideo ? `<span class="media-badge">${fmtDuration(work.duration || 0)}</span>` : ''}
                ${statusHtml}
            </div>
            ${isVideo ? `<div class="media-play">${icon('play', 16)}</div>` : ''}
        </div>
        <div class="work-body">
            <div class="work-title clamp-2">${escapeHtml(work.title)}</div>
            <div class="work-sub ellipsis">${work.tags.slice(0, 3).map((t) => `#${escapeHtml(t)}`).join(' ') || escapeHtml(work.desc).slice(0, 24)}</div>
            <div class="work-foot">
                ${showAuthor ? `<div class="work-author">${avatarTag(work.author, 'avatar-sm')}<span>${escapeHtml(work.author?.name || '匿名')}</span></div>` : '<span class="small muted">' + timeAgo(work.updatedAt) + '</span>'}
                ${showStats ? `<div class="work-stats"><span>${icon('heart', 12)} ${num(work.stats.likes)}</span><span>${icon('eye', 12)} ${num(work.stats.views)}</span></div>` : ''}
            </div>
            ${actions ? `<div class="row" style="margin-top:6px">${actions}</div>` : ''}
        </div>
    </article>`;
}

/* ------------------------------ 分页 ------------------------------ */
export function renderPagination(host, { page = 1, pages = 1, total = 0, pageSize = 12, onChange }) {
    if (!host) return;
    if (pages <= 1) {
        host.innerHTML = `<div class="small muted">共 ${total} 条</div>`;
        return;
    }
    const start = Math.max(1, Math.min(page - 2, pages - 4));
    const items = [];
    items.push(`<button class="page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>${icon('chevron-left', 14)}</button>`);
    for (let i = start; i <= Math.min(pages, start + 4); i += 1) {
        items.push(`<button class="page-btn ${i === page ? 'active' : ''}" data-page="${i}">${i}</button>`);
    }
    items.push(`<button class="page-btn" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>${icon('chevron-right', 14)}</button>`);
    host.innerHTML = `<div class="small muted">共 ${total} 条 · 第 ${page}/${pages} 页</div><div class="pages">${items.join('')}</div>`;
    host.querySelectorAll('.page-btn[data-page]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const next = Number(btn.dataset.page);
            if (next >= 1 && next <= pages && next !== page) onChange(next);
        });
    });
}

/* ------------------------------ Toast ------------------------------ */
function toastHost() {
    let host = document.querySelector('.toast-root');
    if (!host) {
        host = document.createElement('div');
        host.className = 'toast-root';
        document.body.appendChild(host);
    }
    return host;
}

export function toast(message, type = 'info', duration = 2400) {
    const host = toastHost();
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    const marks = { success: '✓', error: '!', warn: '!', info: 'i' };
    el.innerHTML = `<span class="toast-icon">${marks[type] || 'i'}</span><span>${escapeHtml(message)}</span>`;
    host.appendChild(el);
    setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => el.remove(), 220);
    }, duration);
}

/* ------------------------------ 弹窗 ------------------------------ */
let modalHost = null;
let escBound = false;

function ensureModalHost() {
    if (!modalHost) {
        modalHost = document.getElementById('modal-root');
        if (!modalHost) {
            modalHost = document.createElement('div');
            modalHost.id = 'modal-root';
            modalHost.className = 'modal-root';
            document.body.appendChild(modalHost);
        }
    }
    return modalHost;
}

export function closeModal() {
    const host = ensureModalHost();
    host.classList.remove('open');
    host.innerHTML = '';
    document.body.style.overflow = '';
}

export function openModal({ title = '', body = '', footer = '', size = '', onMount }) {
    const host = ensureModalHost();
    host.classList.add('open');
    host.innerHTML = `<div class="modal-mask" data-close="1"></div>
        <div class="modal-card ${size}">
            ${title ? `<div class="modal-head"><h3>${escapeHtml(title)}</h3><button class="icon-btn" data-close="1" style="margin-left:auto">${icon('x', 16)}</button></div>` : ''}
            <div class="modal-body">${body}</div>
            ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
        </div>`;
    document.body.style.overflow = 'hidden';
    host.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
    if (!escBound) {
        escBound = true;
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && host.classList.contains('open')) closeModal();
        });
    }
    const card = host.querySelector('.modal-card');
    if (onMount) onMount(card, host);
    return { card, close: closeModal };
}

export function confirmDialog({ title = '确认操作', message = '', confirmText = '确认', cancelText = '取消', danger = false }) {
    return new Promise((resolve) => {
        const { card, close } = openModal({
            title,
            size: 'sm',
            body: `<p class="small" style="color:var(--text-2);line-height:1.7">${escapeHtml(message)}</p>`,
            footer: `<button class="btn btn-outline" data-act="cancel">${escapeHtml(cancelText)}</button>
                     <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${escapeHtml(confirmText)}</button>`
        });
        card.querySelector('[data-act="cancel"]').addEventListener('click', () => {
            close();
            resolve(false);
        });
        card.querySelector('[data-act="ok"]').addEventListener('click', () => {
            close();
            resolve(true);
        });
    });
}

/* ------------------------------ 表单 / 交互 ------------------------------ */
export function collectForm(form) {
    const data = new FormData(form);
    const obj = {};
    for (const [key, value] of data.entries()) {
        if (key in obj) {
            obj[key] = [].concat(obj[key], value);
        } else {
            obj[key] = value;
        }
    }
    form.querySelectorAll('.switch[data-name]').forEach((el) => {
        obj[el.dataset.name] = el.classList.contains('on');
    });
    return obj;
}

export function bindSwitch(root, onChange) {
    root.querySelectorAll('.switch[data-name]').forEach((el) => {
        el.addEventListener('click', () => {
            el.classList.toggle('on');
            if (onChange) onChange(el.dataset.name, el.classList.contains('on'));
        });
    });
}

export function bindTabs(root, selector, onChange) {
    const tabs = root.querySelectorAll(selector);
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            tabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            onChange(tab);
        });
    });
}

export function bindWorkCards(root, onOpen, onLike) {
    root.querySelectorAll('.work-card[data-work-id]').forEach((card) => {
        card.addEventListener('click', (e) => {
            const likeBtn = e.target.closest('[data-like]');
            if (likeBtn) {
                e.stopPropagation();
                if (onLike) onLike(likeBtn.dataset.like, likeBtn);
                return;
            }
            if (e.target.closest('button, a')) return;
            if (onOpen) onOpen(card.dataset.workId);
        });
    });
}

export function likeButton(work) {
    return `<button class="like-btn ${work.liked ? 'on' : ''}" data-like="${escapeHtml(work.id)}">
        ${icon('heart', 13)} <span>${num(work.stats.likes)}</span>
    </button>`;
}

/** 兼容路径：剪贴板 API 不可用（非安全上下文）或被拒（页面未获得焦点）时退回 execCommand */
function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const done = document.execCommand('copy');
    ta.remove();
    return done;
}

export async function copyText(text, successMessage = '已复制到剪贴板') {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else if (!legacyCopy(text)) {
            throw new Error('execCommand 被拒绝');
        }
        toast(successMessage, 'success');
    } catch (err) {
        // 页面失焦等原因导致 writeText 被拒，不等于不能复制，退回旧接口再试一次
        if (legacyCopy(text)) {
            toast(successMessage, 'success');
        } else {
            toast('复制失败，请手动选择文本', 'error');
        }
    }
}

export function readFileAsDataURL(file, maxKB = 300) {
    return new Promise((resolve, reject) => {
        if (!file.type.startsWith('image/')) {
            reject(new Error('请选择图片文件'));
            return;
        }
        if (file.size > maxKB * 1024) {
            resolve({ url: placeholder(file.name.slice(0, 8), 640, 480), name: file.name, size: file.size, simulated: true });
            return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve({ url: reader.result, name: file.name, size: file.size, simulated: false });
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsDataURL(file);
    });
}

export function go(url) {
    window.location.href = url;
}

export function debounceInput(input, handler, wait = 300) {
    let timer = null;
    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => handler(input.value), wait);
    });
}

export function tagList(tags, removable = false, cls = 'tag') {
    return tags.map((t) => `<span class="${cls}">${escapeHtml(t)}${removable ? `<button data-remove-tag="${escapeHtml(t)}" aria-label="移除">×</button>` : ''}</span>`).join('');
}

export function timeCell(iso) {
    return `<span title="${escapeHtml(iso)}">${timeAgo(iso)}</span>`;
}
