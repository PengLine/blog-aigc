/**
 * 封面服务
 * ------------------------------------------------------------------
 * 两类能力：
 * 1. artCover —— 由标题 / 提示词确定性生成一张「作品封面」（SVG dataURL），
 *    远端示意图不可用时用它兜底，保证列表与详情永远不会出现空封面。
 * 2. posterFromVideo —— 真实抽取视频第 N 秒（默认 3 秒）的帧，
 *    缩放到封面尺寸后转 JPEG dataURL，并写回作品 / 任务产物。
 *
 * 抽帧依赖源站返回 Access-Control-Allow-Origin，否则 canvas 会被判定污染、
 * toDataURL 抛 SecurityError；此时自动退回 artCover，功能不中断。
 */
import { escapeHtml } from './format.js';
import { setWorkCover, setOutputCover } from './db.js';
import { DEMO_IMG_HOST } from '../data/media.js';

/** 默认取第 3 秒作为封面帧 */
export const POSTER_SECOND = 3;

/** 封面输出尺寸：兼顾清晰度与 localStorage 体积（单张约 15–25KB） */
const COVER_W = 512;
const COVER_H = 288;
const TIMEOUT_MS = 7000;

const PALETTES = [
    ['#0b1c3d', '#1e3a8a', '#7dd3fc'],
    ['#241056', '#4c1d95', '#f0abfc'],
    ['#04343a', '#0e7490', '#a7f3d0'],
    ['#3a1d07', '#b45309', '#fde68a'],
    ['#3d0a24', '#9d174d', '#fbcfe8'],
    ['#0f172a', '#334155', '#a5b4fc'],
    ['#052e16', '#166534', '#bbf7d0'],
    ['#3b0d0d', '#991b1b', '#fecaca']
];

const hash = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i += 1) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
};

/** 按哈希选择构图语言，让不同提示词的封面明显区分开 */
function motif(variant, w, h, accent) {
    const horizon = h * 0.68;
    if (variant === 'ridge') {
        const layer = (offset, alpha) => `<path d="M0 ${horizon + offset} L${w * 0.18} ${horizon - 46 + offset}
            L${w * 0.34} ${horizon + 8 + offset} L${w * 0.52} ${horizon - 62 + offset} L${w * 0.7} ${horizon + 4 + offset}
            L${w * 0.86} ${horizon - 38 + offset} L${w} ${horizon + 12 + offset} L${w} ${h} L0 ${h} Z"
            fill="${accent}" opacity="${alpha}"/>`;
        return layer(34, 0.14) + layer(14, 0.2) + layer(0, 0.3);
    }
    if (variant === 'orbit') {
        const cx = w * 0.72;
        const cy = h * 0.34;
        return [0.3, 0.46, 0.62].map((r, i) => `<circle cx="${cx}" cy="${cy}" r="${h * r}" fill="none"
            stroke="${accent}" stroke-width="${1.6 - i * 0.4}" opacity="${0.42 - i * 0.1}" />`).join('')
            + `<circle cx="${cx}" cy="${cy}" r="${h * 0.11}" fill="${accent}" opacity=".5"/>`
            + `<circle cx="${cx - h * 0.34}" cy="${cy + h * 0.2}" r="5" fill="${accent}" opacity=".8"/>`;
    }
    if (variant === 'grid') {
        const lines = [];
        for (let i = 1; i <= 7; i += 1) {
            const y = horizon + Math.pow(i / 7, 1.9) * (h - horizon);
            lines.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${w}" y2="${y.toFixed(1)}" stroke="${accent}" stroke-width="1" opacity=".26"/>`);
        }
        for (let i = -4; i <= 4; i += 1) {
            lines.push(`<line x1="${w / 2 + i * 14}" y1="${horizon}" x2="${w / 2 + i * w * 0.34}" y2="${h}" stroke="${accent}" stroke-width="1" opacity=".2"/>`);
        }
        return `<line x1="0" y1="${horizon}" x2="${w}" y2="${horizon}" stroke="${accent}" stroke-width="2" opacity=".5"/>` + lines.join('');
    }
    if (variant === 'wave') {
        return [0, 1, 2, 3].map((k) => {
            const y = h * (0.42 + k * 0.13);
            const amp = 16 - k * 3;
            return `<path d="M0 ${y} Q ${w * 0.2} ${y - amp} ${w * 0.4} ${y} T ${w * 0.8} ${y} T ${w} ${y}"
                fill="none" stroke="${accent}" stroke-width="${2.2 - k * 0.4}" opacity="${0.44 - k * 0.09}"/>`;
        }).join('');
    }
    if (variant === 'city') {
        const bars = [];
        for (let i = 0; i < 13; i += 1) {
            const bw = w / 13;
            const bh = h * (0.16 + ((i * 37) % 50) / 100);
            bars.push(`<rect x="${(i * bw).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${bh.toFixed(1)}"
                fill="${accent}" opacity="${i % 3 === 0 ? 0.3 : 0.18}"/>`);
        }
        return bars.join('');
    }
    // 'bloom'：放射弧线，适合人像 / 花朵题材
    const cx = w * 0.5;
    const cy = h * 0.52;
    return Array.from({ length: 9 }, (_, i) => {
        const a = (Math.PI * 2 * i) / 9;
        const r = h * 0.42;
        return `<path d="M${cx} ${cy} Q ${(cx + Math.cos(a + 0.6) * r).toFixed(1)} ${(cy + Math.sin(a + 0.6) * r).toFixed(1)}
            ${(cx + Math.cos(a) * r).toFixed(1)} ${(cy + Math.sin(a) * r).toFixed(1)}"
            fill="none" stroke="${accent}" stroke-width="1.4" opacity=".34"/>`;
    }).join('') + `<circle cx="${cx}" cy="${cy}" r="${h * 0.09}" fill="${accent}" opacity=".42"/>`;
}

/**
 * 确定性作品封面：同一标题 / 提示词永远得到同一张图，避免刷新后封面跳动
 * @param {{title?: string, prompt?: string, kind?: string, width?: number, height?: number, second?: number|null}} options
 */
export function artCover(options = {}) {
    const { title = '', prompt = '', kind = 'image', width = COVER_W, height = COVER_H, second = null } = options;
    const seedText = `${title}|${prompt}`;
    const h = hash(seedText || 'aigc');
    const [c0, c1, accent] = PALETTES[h % PALETTES.length];
    const variant = ['ridge', 'orbit', 'grid', 'wave', 'city', 'bloom'][h % 6];
    const label = escapeHtml(String(title || prompt || 'AI 生成作品').slice(0, 16));
    const sub = escapeHtml(String(prompt || title || '').replace(/[,，]\s*/g, ' · ').slice(0, 34));
    const gx = 18 + (h % 40);
    const gy = 14 + ((h >> 3) % 30);
    const dots = Array.from({ length: 26 }, (_, i) => {
        const x = ((h * (i + 3) * 7919) % width);
        const y = ((h * (i + 5) * 104729) % height);
        return `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(0.8 + (i % 3) * 0.7).toFixed(1)}" fill="#fff" opacity=".1"/>`;
    }).join('');
    // 视频封面带播放徽标与取帧时间点，和真实缩略图习惯一致
    const badge = kind === 'video'
        ? `<g>
            <circle cx="${width - 44}" cy="40" r="17" fill="#0b1220" opacity=".58"/>
            <path d="M${width - 49} 32 L${width - 34} 40 L${width - 49} 48 Z" fill="#fff" opacity=".92"/>
           </g>
           <rect x="${width - 108}" y="${height - 40}" rx="10" width="72" height="24" fill="#0b1220" opacity=".62"/>
           <text x="${width - 72}" y="${height - 23}" fill="#fff" font-size="14" text-anchor="middle"
             font-family="system-ui,sans-serif">${second == null ? '' : `00:0${Math.round(second)}`}</text>`
        : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="${c0}"/><stop offset="55%" stop-color="${c1}"/><stop offset="100%" stop-color="${c0}"/>
            </linearGradient>
            <radialGradient id="glow" cx="${gx}%" cy="${gy}%" r="62%">
                <stop offset="0" stop-color="${accent}" stop-opacity=".5"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/>
            </radialGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#bg)"/>
        <rect width="100%" height="100%" fill="url(#glow)"/>
        ${motif(variant, width, height, accent)}
        ${dots}
        <text x="26" y="${height - 52}" fill="#fff" fill-opacity=".97" font-size="${Math.round(width / 26)}"
            font-weight="650" font-family="system-ui,sans-serif">${label}</text>
        ${sub ? `<text x="26" y="${height - 28}" fill="#fff" fill-opacity=".62" font-size="${Math.round(width / 40)}"
            font-family="system-ui,sans-serif">${sub}</text>` : ''}
        ${badge}
    </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/* ------------------------------ 视频抽帧 ------------------------------ */

/**
 * 是否应直接采用确定性封面而非发起图请求：
 * 空值 / data URL / 失效的演示图床（返回“生成中”占位图、不报错）都返回 true。
 * 真实后端图 URL（非该域）会返回 false，仍走原图。
 */
export function useArtCover(url) {
    if (!url) return true;
    const s = String(url);
    if (s.startsWith('data:')) return false; // 已是本地封面
    if (!/^https?:/i.test(s)) return true;
    return s.includes(DEMO_IMG_HOST);
}

const memory = new Map();
const pending = new Map();

function drawFrame(video, width, height) {
    const vw = video.videoWidth || width;
    const vh = video.videoHeight || height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const c2d = canvas.getContext('2d');
    // 等比裁切（object-fit: cover 语义），避免黑边
    const scale = Math.max(width / vw, height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    c2d.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh);
    return canvas.toDataURL('image/jpeg', 0.72);
}

/**
 * 抽取视频第 second 秒的画面作为封面 dataURL
 * @returns {Promise<string|null>} 失败（跨域、超时、解码错误）返回 null，由调用方兜底
 */
export function posterFromVideo(src, second = POSTER_SECOND, { width = COVER_W, height = COVER_H } = {}) {
    if (!src || src.startsWith('data:') || !/^https?:/i.test(src)) return Promise.resolve(null);
    const key = `${src}@@${second}`;
    if (memory.has(key)) return Promise.resolve(memory.get(key));
    if (pending.has(key)) return pending.get(key);

    const job = new Promise((resolve) => {
        const video = document.createElement('video');
        let done = false;
        let timer = null;
        const settle = (value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            video.onloadedmetadata = null;
            video.onloadeddata = null;
            video.onseeked = null;
            video.onerror = null;
            video.removeAttribute('src');
            video.load();
            if (value) memory.set(key, value);
            pending.delete(key);
            resolve(value);
        };
        const seekTo = (at) => {
            try {
                video.currentTime = at;
            } catch (err) {
                settle(null);
            }
        };
        video.crossOrigin = 'anonymous';
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        timer = setTimeout(() => settle(null), TIMEOUT_MS);
        video.onerror = () => settle(null);
        video.onseeked = () => {
            try {
                settle(drawFrame(video, width, height));
            } catch (err) {
                // canvas 被跨域资源污染时会抛 SecurityError
                settle(null);
            }
        };
        video.onloadeddata = () => {
            const dur = Number.isFinite(video.duration) ? video.duration : second + 1;
            seekTo(Math.max(0.05, Math.min(second, dur - 0.1)));
        };
        video.onloadedmetadata = () => {
            if (video.readyState >= 2) video.onloadeddata();
        };
        video.src = src;
        video.load();
    });

    pending.set(key, job);
    return job;
}

/** 抽帧失败时的兜底封面 */
const fallbackFor = (item, second) => artCover({
    title: item.title || item.name || '',
    prompt: item.prompt || '',
    kind: 'video',
    second
});

/**
 * 取得作品的可靠封面：视频优先抽第 3 秒真实帧，成功后写回数据库
 * @param {object} work 作品对象（需含 id / mediaUrl / cover）
 * @param {{second?: number}} [options]
 * @returns {Promise<string|null>} 返回可用于当前渲染的新封面；无需更新时返回 null
 */
export async function ensureWorkCover(work, options = {}) {
    const second = options.second ?? POSTER_SECOND;
    if (!work || !work.id) return null;
    if (work.kind !== 'video' && !work.mediaUrl) return null;
    if (work.cover && String(work.cover).startsWith('data:image/jpeg')) return null; // 已是抽帧结果
    if (!work.mediaUrl || !/^https?:/i.test(work.mediaUrl)) return null;

    const frame = await posterFromVideo(work.mediaUrl, second);
    if (!frame) return work.cover ? null : fallbackFor(work, second);
    setWorkCover(work.id, frame);
    return frame;
}

/** 补齐任务产物（视频）的封面 */
export async function ensureOutputCover(taskId, index, output, options = {}) {
    const second = options.second ?? POSTER_SECOND;
    if (!output || output.type !== 'video' || !output.url) return null;
    if (output.poster && String(output.poster).startsWith('data:image/jpeg')) return null;
    const frame = await posterFromVideo(output.url, second);
    if (!frame) return output.poster || null;
    setOutputCover(taskId, index, frame);
    return frame;
}

/**
 * 批量补齐封面：串行执行，避免一次并发拉取多个视频
 * @param {Array} items 作品列表
 * @param {(work: object, cover: string) => void} [onUpdate] 拿到新封面后的 DOM 回调
 */
export async function hydrateWorkCovers(items, onUpdate, options = {}) {
    const list = (items || [])
        .filter((w) => w && w.mediaUrl && !String(w.cover || '').startsWith('data:image/jpeg'))
        .slice(0, options.limit ?? 8);
    for (const work of list) {
        try {
            const cover = await ensureWorkCover(work, options);
            if (cover && onUpdate) onUpdate(work, cover);
        } catch (err) {
            console.debug('[cover] 抽帧失败，已保留原封面', work.id, err?.message || err);
        }
    }
    return list.length;
}

/* ------------------------------ 视频缩略图运行时 ------------------------------ */
/**
 * 视频卡片缩略图用「seek 到第 N 秒的 <video>」实现：
 * 显示解码帧不需要 CORS，规避 canvas toDataURL 被污染；
 * 进入视口才真正加载，列表里同时只拉取可见的少量视频。
 */
let io = null;
let watcher = null;

function getIO() {
    if (io || typeof IntersectionObserver === 'undefined') return io;
    io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.unobserve(entry.target);
            activateThumb(entry.target);
        }
    }, { rootMargin: '220px' });
    return io;
}

function activateThumb(video) {
    const src = video.getAttribute('data-thumb-src');
    const at = Number(video.getAttribute('data-thumb-at')) || POSTER_SECOND;
    if (!src || video.dataset.thumbBound !== '2') return;
    video.dataset.thumbBound = '3';
    video.preload = 'metadata';
    video.addEventListener('loadedmetadata', () => {
        try {
            const dur = Number.isFinite(video.duration) ? video.duration : at + 1;
            video.currentTime = Math.max(0.05, Math.min(at, dur - 0.05));
        } catch (err) {
            /* 保留 poster（artCover），不影响卡片 */
        }
    }, { once: true });
    video.addEventListener('seeked', () => video.classList.add('is-ready'), { once: true });
    video.src = src;
    video.load();
}

/** 登记容器内尚未绑定的缩略图 */
export function observeThumbs(root) {
    const el = root && (root.nodeType === 1 ? root : null);
    if (!el) return;
    const observer = getIO();
    const scope = el.classList && el.classList.contains('vid-thumb') ? [el] : Array.from(el.querySelectorAll('.vid-thumb[data-thumb-src]'));
    for (const node of scope) {
        if (node.dataset.thumbBound) continue;
        node.dataset.thumbBound = '2';
        // 无 IntersectionObserver 支持时直接激活，保证降级可用
        if (!observer) { activateThumb(node); continue; }
        observer.observe(node);
    }
}

/**
 * 启动缩略图监听：初始扫描一次，并用 MutationObserver 接管后续局部重渲染
 * （分页、筛选、相关推荐等异步插入的卡片无需各视图手动接线）
 */
export function startThumbWatcher(scope) {
    if (!scope || watcher) return;
    observeThumbs(scope);
    watcher = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType === 1) observeThumbs(node);
            }
        }
        observeThumbs(scope); // 兜底：捕获多层嵌套新增节点
    });
    watcher.observe(scope, { childList: true, subtree: true });
}

/* ------------------------------ 全局兜底注册 ------------------------------ */
// 供内联 onerror 使用：图片加载失败时按需生成确定性封面，避免把长 dataURL 内联进 HTML
if (typeof window !== 'undefined') {
    window.__coverFallback = (title, prompt, kind, second) => artCover({
        title: title || '',
        prompt: prompt || '',
        kind: kind === 'video' ? 'video' : 'image',
        second: kind === 'video' ? (second ?? POSTER_SECOND) : null
    });
}
