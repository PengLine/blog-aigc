/**
 * 格式化与通用工具
 */

export function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function num(value) {
    const n = Number(value) || 0;
    if (n >= 100000000) return `${(n / 100000000).toFixed(1).replace(/\.0$/, '')}亿`;
    if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万`;
    if (n >= 1000) return n.toLocaleString('zh-CN');
    return String(n);
}

export function timeAgo(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(diff)) return '';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return '刚刚';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟前`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小时前`;
    const day = Math.floor(hour / 24);
    if (day < 30) return `${day} 天前`;
    const month = Math.floor(day / 30);
    if (month < 12) return `${month} 个月前`;
    return `${Math.floor(month / 12)} 年前`;
}

export function fmtDate(iso, withTime = false) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    const pad = (n) => String(n).padStart(2, '0');
    const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (!withTime) return base;
    return `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return `${m}:${String(rest).padStart(2, '0')}`;
}

export function pct(part, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}

export function debounce(fn, wait = 260) {
    let timer = null;
    return function debounced(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), wait);
    };
}

export function throttle(fn, wait = 500) {
    let last = 0;
    return function throttled(...args) {
        const now = Date.now();
        if (now - last < wait) return;
        last = now;
        fn.apply(this, args);
    };
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

export function byId(list, id) {
    return (list || []).find((item) => item.id === id) || null;
}

export function fileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function queryParams(search = window.location.search) {
    return Object.fromEntries(new URLSearchParams(search || ''));
}

/** 生成本地占位图（网络图片不可用时的兜底） */
export function placeholder(text = 'AIGC', w = 640, h = 480) {
    const label = escapeHtml(String(text).slice(0, 12));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#7c3aed"/>
        </linearGradient></defs>
        <rect width="100%" height="100%" fill="url(#g)"/>
        <text x="50%" y="50%" fill="rgba(255,255,255,.92)" font-family="sans-serif" font-size="${Math.round(w / 14)}"
            text-anchor="middle" dominant-baseline="middle">${label}</text>
    </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * 首字母头像的配色（图床不可用时的本地兜底）。
 * 24 色均为中深调，保证白字对比度；旧版只有 6 色且只按首字取模，
 * 「沈知夏 / 陆见山」这类首字编码同余的用户会撞成同一底色。
 * 现改为：整串名字 FNV 哈希取底色，另取一个错开的哈希频段作斜角副色，
 * 即使两人名撞中同一底色，双色组合仍然不同，视觉上不再混淆。
 */
const AVATAR_COLORS = [
    '#1d4ed8', '#3730a3', '#4c1d95', '#6d28d9',
    '#7e22ce', '#a21caf', '#86198f', '#be185d',
    '#9d174d', '#be123c', '#9f1239', '#b91c1c',
    '#c2410c', '#9a3412', '#b45309', '#854d0e',
    '#4d7c0f', '#3f6212', '#15803d', '#047857',
    '#0f766e', '#0e7490', '#0369a1', '#334155'
];

export function avatarFallback(name = 'U') {
    const label = String(name).trim();
    const ch = label.charAt(0) || 'U';
    // FNV-1a：名字长度与后续字都进入哈希，不同用户同首字也不会再同底色
    let h = 2166136261;
    for (let i = 0; i < label.length; i += 1) {
        h ^= label.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    const n = AVATAR_COLORS.length;
    const color = AVATAR_COLORS[Math.abs(h) % n];
    // 错开 11 位并用另一段位域，使副色与底色统计独立
    let accent = AVATAR_COLORS[(Math.abs(h >>> 7) + 11) % n];
    // 副色与底色重合时斜角会隐形，退化成纯色；顺移 5 位保证始终双色
    if (accent === color) accent = AVATAR_COLORS[(AVATAR_COLORS.indexOf(color) + 5) % n];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
        <rect width="100%" height="100%" fill="${color}"/>
        <path d="M0 0 L96 0 L0 96 Z" fill="${accent}" opacity=".5"/>
        <path d="M96 0 L96 96 L0 96 Z" fill="#000" opacity=".1"/>
        <text x="50%" y="54%" fill="#fff" font-family="sans-serif" font-size="42"
            text-anchor="middle" dominant-baseline="middle">${escapeHtml(ch)}</text>
    </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
