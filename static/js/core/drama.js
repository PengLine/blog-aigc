/**
 * 长剧本短剧（>15 秒）领域逻辑
 * ------------------------------------------------------------------
 * 与 training.js 同构的「单一事实来源」模块：剧本解析规则、镜头计费、时长配平、
 * 一致性校验、解析与合成的过程计划全部集中在这里，供
 * api.js（建单校验与扣费）、engine.js（逐镜头与合成推进）、seed.js（历史数据）、
 * views/drama-studio.js（工作台与实时预估）四方共用。
 *
 * 目的：让「页面显示 12 个镜头 / 60 秒 / 468 算力」与「引擎实际下单、实际扣费、
 * 实际产出」完全一致，杜绝演示系统最常见的口径破绽。
 * 本模块为纯函数集合，不依赖任何其他 core 模块，可被 constants.js 与 Node 自检脚本直接引用。
 */

/** 超过该秒数必须走「剧本解析 → 分镜审核 → 片段生成 → 片段合成」流水线 */
export const LONG_FORM_MIN = 15;

/** 时长档位：前三档走单任务快速路径，后四档走分镜工作台 */
export const DURATION_OPTIONS = [5, 10, 15, 30, 60, 90, 180];

export const MIN_SHOTS = 3;
export const MAX_SHOTS = 24;

/** 单镜头时长下限（低于 2 秒的片段在真实剪辑里几乎不可用） */
export const SHOT_MIN_SEC = 2;

/** 视频模型档案：单镜头时长上限 + 计费口径（base + perSec × 秒，5 秒档与模型标价对齐） */
export const VIDEO_PROFILES = {
    'kling-v': { maxShot: 10, base: 15, perSec: 3, fps: 24, res: '1080p', etaPerSec: 0.8, note: '图生视频，主体一致性强' },
    'lingxi-v': { maxShot: 8, base: 13, perSec: 2.6, fps: 25, res: '720p', etaPerSec: 0.6, note: '文生视频，运镜控制丰富' }
};
const FALLBACK_PROFILE = { maxShot: 8, base: 13, perSec: 3, fps: 24, res: '720p', etaPerSec: 0.7, note: '通用视频模型' };

export const SHOT_TYPES = [
    { id: 'establish', name: '建立镜头', en: 'establishing wide shot' },
    { id: 'medium', name: '中景叙事', en: 'medium shot' },
    { id: 'close', name: '人物近景', en: 'character close up' },
    { id: 'detail', name: '特写情绪', en: 'extreme close up, emotional detail' },
    { id: 'action', name: '动作跟拍', en: 'action tracking shot' },
    { id: 'insert', name: '环境空镜', en: 'environmental insert shot' },
    { id: 'ots', name: '过肩对话', en: 'over the shoulder dialogue' },
    { id: 'crane', name: '俯拍转场', en: 'high angle crane shot' }
];

export const CAMERA_MOVES = [
    { id: 'static', name: '固定机位', en: 'locked off tripod' },
    { id: 'push', name: '缓慢推近', en: 'slow dolly in' },
    { id: 'pan', name: '横移跟随', en: 'lateral tracking' },
    { id: 'crane', name: '升降俯瞰', en: 'crane up' },
    { id: 'handheld', name: '手持微晃', en: 'handheld, subtle shake' },
    { id: 'orbit', name: '环绕半周', en: 'half orbit' }
];

export const TONES = [
    { id: 'cold', name: '冷蓝科幻', look: 'cold teal grade, blue rim light', light: '低照度冷光源' },
    { id: 'warm', name: '暖色胶片', look: 'warm film grain, golden hour light', light: '黄昏自然光' },
    { id: 'noir', name: '黑色电影', look: 'noir high contrast, hard shadows', light: '高反差硬光' },
    { id: 'ink', name: '国风水墨', look: 'ink wash painting mood, misty layers', light: '散射柔光' },
    { id: 'neon', name: '霓虹赛博', look: 'neon cyberpunk palette, wet reflections', light: '霓虹混色光' }
];

export const TONE_MAP = Object.fromEntries(TONES.map((t) => [t.id, t]));
const SHOT_TYPE_MAP = Object.fromEntries(SHOT_TYPES.map((s) => [s.id, s]));
const CAMERA_MAP = Object.fromEntries(CAMERA_MOVES.map((c) => [c.id, c]));

/** 节拍关键词 → 画面主体描述（命中则替换，未命中回落到中文原文） */
const KEYWORDS = [
    [/走廊|通道|舱门|空间站|太空站/, 'corridor inside a derelict space station'],
    [/醒来|苏醒|睁眼|沉睡/, 'waking up, eyes opening in slow motion'],
    [/记忆|全息|投影|数据/, 'holographic memory projection floating'],
    [/雨|暴雨|雨夜|湿/, 'heavy rain, soaked pavement'],
    [/霓虹|招牌|灯牌/, 'neon signage glowing through the haze'],
    [/街|巷|市集|人群/, 'crowded street, shallow depth of field'],
    [/追逐|奔跑|逃/, 'desperate chase, motion blur'],
    [/天台|楼顶|屋顶/, 'rooftop overlooking the city skyline'],
    [/对话|交谈|说|问/, 'two figures in tense conversation'],
    [/握|拳|手/, 'hand clenching, macro detail'],
    [/信|纸|照片|笔记/, 'a weathered letter held in hand, close detail'],
    [/窗|玻璃|倒影/, 'reflection on a rain-streaked window'],
    [/雪|雪山|冰/, 'snow covered ridge, frozen breath'],
    [/海|沙滩|浪/, 'waves breaking on a dark shore'],
    [/车|载具|摩托|悬浮/, 'vehicle drifting through the frame'],
    [/刀|剑|刃|武器/, 'blade drawn, metal edge glinting'],
    [/血|伤|倒下/, 'wounded figure collapsing'],
    [/门|入口|密室/, 'a heavy door slowly swinging open'],
    [/光|光束|灯/, 'a single shaft of light cutting the dark'],
    [/咖啡|食物|餐/, 'steaming cup on a scratched table'],
    [/猫|狗|鸟|兽/, 'animal reacting in the foreground'],
    [/城|废墟|塔/, 'ruined city skyline silhouette'],
    [/山|林|树/, 'forest ridgeline in soft mist'],
    [/夜|月|星/, 'night sky with faint moonlight'],
    [/笑|泪|眼|表情/, 'subtle facial expression, micro emotion']
];

export function profileFor(model) {
    return VIDEO_PROFILES[model] || FALLBACK_PROFILE;
}

export function isLongForm(duration) {
    return Number(duration) > LONG_FORM_MIN;
}

export function durationOptions() {
    return DURATION_OPTIONS.slice();
}

/** 单个镜头（或快速路径单条视频）的算力成本：base + perSec × 秒 */
export function videoCost(model, seconds) {
    const p = profileFor(model);
    const sec = Math.max(1, Math.min(30, Number(seconds) || p.maxShot));
    return Math.max(6, Math.round(p.base + p.perSec * sec));
}

export const shotCost = (model, seconds) => videoCost(model, seconds);

/** 剧本解析成本：按剧本规模与目标时长计费（真实平台按 token / 时长收） */
export function scriptCost(targetSec, chars = 0) {
    return Math.max(6, Math.round(5 + Number(targetSec || 0) * 0.12 + chars / 400));
}

/** 片段合成成本：转场拼接 + 音画对齐 + 抽帧封装，随总时长与镜头数增长 */
export function composeCost(totalSec, shotCount) {
    return Math.max(10, Math.round(8 + Number(totalSec || 0) * 0.2 + Number(shotCount || 0) * 1.5));
}

/** 单个镜头的预计耗时（分钟） */
export function shotEtaMin(model, seconds) {
    const p = profileFor(model);
    return Math.max(1, Math.round(Number(seconds) * p.etaPerSec));
}

/** 逐句切分剧本为叙事节拍；空文本时用画面骨架兜底，保证解析永远有产出 */
export function splitBeats(script) {
    const raw = String(script || '')
        .split(/[\n。！？；!?;]+/)
        .map((s) => s.replace(/^[\s\t　]*[\d一二三四五六七八九十]+[、.．)）]?\s*/, '').trim())
        .filter((s) => s.length >= 2);
    if (raw.length) return raw;
    return ['开场：主角进入场景，交代环境', '推进：出现第一个阻碍', '收束：留下悬念'];
}

/** 镜头数：既满足模型单镜头上限，也尽量与剧本节拍数一致 */
export function planShotCount(targetSec, beatCount, maxShot) {
    const target = Math.max(LONG_FORM_MIN + 1, Number(targetSec) || 30);
    const min = Math.max(MIN_SHOTS, Math.ceil(target / maxShot));
    const max = Math.min(MAX_SHOTS, Math.max(min, Math.round(target / SHOT_MIN_SEC)));
    return Math.max(min, Math.min(max, Number(beatCount) || min));
}

/**
 * 把目标时长精确配平成 n 段（每段 ≤ maxShot，合计 === 目标）。
 * 数学保证：n ≥ ceil(target / maxShot) 时 base ≤ maxShot，且 base === maxShot 时余数必为 0。
 */
export function distributeSeconds(targetSec, count, maxShot) {
    const target = Math.max(1, Math.round(Number(targetSec) || 0));
    let n = Math.max(1, Math.round(Number(count) || 1));
    while (Math.floor(target / n) > maxShot || (Math.floor(target / n) === maxShot && target % n !== 0)) n += 1;
    const base = Math.max(SHOT_MIN_SEC, Math.floor(target / n));
    const rest = target - base * n;
    const secs = Array.from({ length: n }, (_, i) => base);
    // 余数优先给中前段（节奏更紧），并逐段不超过模型上限
    for (let i = 0; i < rest; i += 1) {
        const idx = i % n;
        if (secs[idx] < maxShot) secs[idx] += 1;
        else {
            const alt = secs.findIndex((s) => s < maxShot);
            if (alt >= 0) secs[alt] += 1;
        }
    }
    return secs;
}

/** 把节拍按镜头数分桶：镜头数少于节拍数时合并不丢内容 */
function bucketBeats(beats, count) {
    const n = Math.max(1, count);
    const out = Array.from({ length: n }, () => []);
    beats.forEach((b, i) => out[Math.min(n - 1, Math.floor((i * n) / beats.length))].push(b));
    const texts = out.map((g) => g.join('，'));
    // 节拍数少于镜头数时（受模型上限约束被迫拆分），按骨架补齐
    const pads = ['节奏过渡：情绪短暂停顿', '环境反应镜头', '细节插入：关键道具特写', '视角切换：远景回望'];
    for (let i = 0; i < texts.length; i += 1) {
        if (!texts[i]) texts[i] = pads[i % pads.length];
    }
    return texts;
}

function subjectOf(beat, index) {
    for (const [re, en] of KEYWORDS) {
        if (re.test(beat)) return en;
    }
    const cn = String(beat).slice(0, 26);
    return `${cn}，scene ${String(index + 1).padStart(2, '0')}`;
}

/** 按节拍语义与序号指派景别：开场建立、对话过肩、动作跟拍、收尾空镜 */
function pickShotType(index, count, beat) {
    if (index === 0) return 'establish';
    if (index === count - 1) return count >= 6 ? 'insert' : 'crane';
    if (/追逐|奔跑|逃|冲|打|打鬥/.test(beat)) return 'action';
    if (/对话|交谈|说|问|回答/.test(beat)) return 'ots';
    if (/手|拳|眼|泪|笑|表情|信|照片|特写/.test(beat)) return 'detail';
    if (/雨|雪|海|山|城|夜空|环境|街/.test(beat)) return 'insert';
    return ['medium', 'close', 'medium', 'crane'][index % 4];
}

/** 运镜：避免与上一镜头完全相同（真实分镜最忌连续同景别同运镜） */
function pickCamera(index, typeId, prevId) {
    const preferred = { establish: 'crane', action: 'handheld', ots: 'static', detail: 'push', insert: 'pan', crane: 'crane', medium: 'push', close: 'orbit' };
    let id = preferred[typeId] || CAMERA_MOVES[index % CAMERA_MOVES.length].id;
    if (id === prevId) id = CAMERA_MOVES[(CAMERA_MOVES.findIndex((c) => c.id === id) + 1 + index) % CAMERA_MOVES.length].id;
    return id;
}

function pickRefs(index, list) {
    const arr = Array.isArray(list) ? list.filter(Boolean) : [];
    return arr.length ? [arr[index % arr.length]] : [];
}

/** 组装单镜头提示词：主体 + 景别 + 运镜 + 全局影调 + 资产引用 + 规格 */
export function buildShotPrompt({ beat, index, typeId, cameraId, toneId, refTitles, model, ratio }) {
    const t = SHOT_TYPE_MAP[typeId] || SHOT_TYPES[1];
    const c = CAMERA_MAP[cameraId] || CAMERA_MOVES[0];
    const tone = TONE_MAP[toneId] || TONES[0];
    const p = profileFor(model);
    const parts = [subjectOf(beat, index), t.en, c.en, tone.look];
    if (ratio) parts.push(`${ratio} composition`);
    if (refTitles && refTitles.length) parts.push(`consistent with ${refTitles.slice(0, 3).join(', ')}`);
    parts.push(`${p.res}, ${p.fps}fps, cinematic`);
    return parts.join(', ');
}

/**
 * 长剧本解析：输入剧本与项目参数，输出可直接下单的镜头数组（确定性，同一输入必得同一结果）。
 * 引擎与视图共用本函数，因此「看到的分镜表」与「实际生成的镜头」永远一致。
 */
export function parseScript(input = {}) {
    const target = Math.max(LONG_FORM_MIN + 1, Number(input.targetSec) || 30);
    const model = input.model || 'kling-v';
    const p = profileFor(model);
    const beats = splitBeats(input.script);
    const count = planShotCount(target, beats.length, p.maxShot);
    const texts = bucketBeats(beats, count);
    const secs = distributeSeconds(target, count, p.maxShot);
    const refs = input.assetRefs || {};
    const chars = refs.character || [];
    const props = refs.prop || [];
    const scenes = refs.scenic || [];
    const toneId = input.tone && TONE_MAP[input.tone] ? input.tone : (input.ratio === '9:16' ? 'cold' : 'warm');
    const shots = [];
    let prevCamera = '';
    for (let i = 0; i < count; i += 1) {
        const typeId = pickShotType(i, count, texts[i]);
        const cameraId = pickCamera(i, typeId, prevCamera);
        prevCamera = cameraId;
        // 主角默认贯穿全片，道具与场景按节拍轮换（真实项目会做实体对齐）
        const charRefs = chars.length ? [chars[i % chars.length]] : [];
        const refTitles = [
            ...(charRefs.length ? [`character ${(i % chars.length) + 1}`] : []),
            ...(props.length && i % 2 === 1 ? [`prop ${(i % props.length) + 1}`] : []),
            ...(scenes.length ? [`scene ${(i % scenes.length) + 1}`] : [])
        ];
        const seconds = secs[i];
        shots.push({
            id: `sh_${i + 1}`,
            no: i + 1,
            name: `${(SHOT_TYPE_MAP[typeId] || SHOT_TYPES[1]).name} · ${texts[i].slice(0, 12)}`,
            beat: texts[i],
            typeId,
            cameraId,
            seconds,
            prompt: buildShotPrompt({ beat: texts[i], index: i, typeId, cameraId, toneId, refTitles, model, ratio: input.ratio }),
            negative: input.negative || 'low quality, blurry, watermark, extra fingers, inconsistent face',
            refs: { character: charRefs, prop: props.length && i % 2 === 1 ? [props[i % props.length]] : [], scenic: scenes.length ? [scenes[i % scenes.length]] : [] },
            cost: videoCost(model, seconds),
            status: 'pending',
            taskId: '',
            output: null,
            error: null
        });
    }
    return renumber(shots);
}

export function renumber(shots) {
    (shots || []).forEach((s, i) => {
        s.no = i + 1;
        // 只有缺失才补号：id 是任务回调与镜头产物的关联键，增删排序后必须保持稳定
        if (!s.id) s.id = `sh_${i + 1}`;
    });
    return shots;
}

export function findShot(shots, shotId) {
    return (shots || []).find((s) => s.id === shotId || Number(s.id) === Number(shotId)) || null;
}

/** 在 index 之后插入一个新镜头：继承前一镜头的节拍主体，时长取相邻均值 */
export function insertShotAfter(shots, index, ctx = {}) {
    const src = shots[index];
    const p = profileFor(ctx.model);
    const neighbours = [shots[index], shots[index + 1]].filter(Boolean);
    const seconds = Math.min(p.maxShot, Math.max(SHOT_MIN_SEC, Math.round(neighbours.reduce((sum, s) => sum + s.seconds, 0) / neighbours.length)));
    const typeId = src.typeId === 'establish' ? 'medium' : 'insert';
    const cameraId = CAMERA_MOVES[(CAMERA_MOVES.findIndex((c) => c.id === src.cameraId) + 2) % CAMERA_MOVES.length].id;
    const beat = `过渡：${String(src.beat).slice(0, 16)}`;
    const shot = {
        id: `sh_x${Date.now().toString(36).slice(-4)}${Math.floor(Math.random() * 1e4).toString(36)}`,
        no: index + 2,
        name: `${SHOT_TYPE_MAP[typeId].name} · 新增镜头`,
        beat,
        typeId,
        cameraId,
        seconds,
        prompt: buildShotPrompt({ beat, index, typeId, cameraId, toneId: ctx.tone, refTitles: [], model: ctx.model, ratio: ctx.ratio }),
        negative: src.negative,
        refs: { character: [...(src.refs?.character || [])], prop: [], scenic: [...(src.refs?.scenic || [])] },
        cost: videoCost(ctx.model, seconds),
        status: 'pending',
        taskId: '',
        output: null,
        error: null
    };
    const next = shots.slice(0, index + 1).concat([shot], shots.slice(index + 1));
    return renumber(next);
}

export function moveShot(shots, from, to) {
    const list = (shots || []).slice();
    if (from < 0 || from >= list.length) return list;
    const target = Math.max(0, Math.min(list.length - 1, to));
    const [item] = list.splice(from, 1);
    list.splice(target, 0, item);
    return renumber(list);
}

/** 删除镜头（生成中的镜头由调用方先行拦截） */
export function removeShot(shots, index) {
    const list = (shots || []).slice();
    if (index < 0 || index >= list.length) return list;
    list.splice(index, 1);
    return renumber(list);
}

/** 一键配平：按当前镜头数重新均分目标时长，保留已生成镜头（其时长锁定） */
export function autoFit(shots, targetSec, model) {
    const p = profileFor(model);
    const locked = (shots || []).filter((s) => s.status === 'succeeded');
    const lockedSec = locked.reduce((sum, s) => sum + Number(s.seconds), 0);
    const rest = Math.max(0, Math.round(Number(targetSec) - lockedSec));
    const editable = (shots || []).filter((s) => s.status !== 'succeeded');
    const secs = distributeSeconds(rest, Math.max(1, editable.length), p.maxShot);
    editable.forEach((s, i) => {
        s.seconds = secs[Math.min(i, secs.length - 1)];
        s.cost = videoCost(model, s.seconds);
    });
    return shots;
}

/** 合计：镜头数 / 总时长 / 预估算力 / 预计耗时 / 与目标时长的偏差 */
export function summaryOf(shots = [], ctx = {}) {
    const p = profileFor(ctx.model);
    const totalSec = shots.reduce((sum, s) => sum + Number(s.seconds || 0), 0);
    const cost = shots.reduce((sum, s) => sum + Number(s.cost || videoCost(ctx.model, s.seconds)), 0);
    const etaPerShot = shots.reduce((sum, s) => sum + shotEtaMin(ctx.model, s.seconds), 0);
    return {
        count: shots.length,
        totalSec,
        cost,
        // 镜头并行下发（引擎对分镜任务单独放宽并发），按 3 路折算
        etaMin: Math.max(1, Math.ceil(etaPerShot / 3)),
        targetSec: Number(ctx.targetSec) || 0,
        delta: totalSec - (Number(ctx.targetSec) || 0),
        over: shots.filter((s) => Number(s.seconds) > p.maxShot).length,
        done: shots.filter((s) => s.status === 'succeeded').length,
        failed: shots.filter((s) => ['failed', 'canceled'].includes(s.status)).length,
        running: shots.filter((s) => ['queued', 'running'].includes(s.status)).length
    };
}

export const shotLabel = (shot) => `镜头 ${String(shot.no || 1).padStart(2, '0')} · ${shot.name || (SHOT_TYPE_MAP[shot.typeId] || {}).name || '分镜'}`;

export const shotTypeName = (id) => (SHOT_TYPE_MAP[id] || {}).name || '分镜';
export const cameraName = (id) => (CAMERA_MAP[id] || {}).name || '运镜';
export const toneName = (id) => (TONE_MAP[id] || TONES[0]).name;

/** 分镜表纯文本：任务产物与工作台「复制分镜表」共用同一份，避免两处描述不一致 */
export function formatStoryboard(drama = {}) {
    return (drama.shots || [])
        .map((s) => `镜头 ${String(s.no).padStart(2, '0')}｜${shotTypeName(s.typeId)}｜${cameraName(s.cameraId)}｜${s.seconds}s｜${String(s.beat || '').slice(0, 32)}`)
        .join('\n');
}

/**
 * 分镜表体检：error 阻断下单，warn 只提示。
 * 全部基于已落库的 shots 与项目参数复算，不依赖解析过程的中间态。
 */
export function checkDrama(drama = {}) {
    const shots = drama.shots || [];
    const ctx = { model: drama.model, targetSec: drama.targetSec };
    const p = profileFor(drama.model);
    const tone = TONE_MAP[drama.tone] || TONES[0];
    const sum = summaryOf(shots, ctx);
    const issues = [];
    if (!shots.length) {
        issues.push({ level: 'error', code: 'empty', msg: '还没有分镜，请先完成剧本解析' });
        return { issues, summary: sum };
    }
    shots.forEach((s) => {
        if (!String(s.prompt || '').trim()) issues.push({ level: 'error', code: 'no_prompt', shotId: s.id, msg: `${shotLabel(s)} 提示词为空，无法下单生成` });
        if (Number(s.seconds) > p.maxShot) issues.push({ level: 'error', code: 'over_max', shotId: s.id, msg: `${shotLabel(s)} ${s.seconds}s 超出模型单镜头上限 ${p.maxShot}s，请拆分为两个镜头` });
        if (Number(s.seconds) < SHOT_MIN_SEC) issues.push({ level: 'warn', code: 'too_short', shotId: s.id, msg: `${shotLabel(s)} 仅 ${s.seconds}s，转场会显得仓促` });
    });
    if (sum.over) issues.push({ level: 'error', code: 'over_count', msg: `${sum.over} 个镜头超过模型上限，已阻断生成` });
    if (shots.length > MAX_SHOTS) issues.push({ level: 'error', code: 'too_many', msg: `镜头数 ${shots.length} 超过单项目上限 ${MAX_SHOTS}` });
    if (sum.delta !== 0) issues.push({ level: Math.abs(sum.delta) > Math.max(2, sum.targetSec * 0.1) ? 'error' : 'warn', code: 'duration', msg: `分镜合计 ${sum.totalSec}s ${sum.delta > 0 ? '超出' : '少于'}目标 ${sum.targetSec}s（差 ${Math.abs(sum.delta)}s），可一键配平` });
    if (!shots.slice(0, 2).some((s) => s.typeId === 'establish')) issues.push({ level: 'warn', code: 'no_establish', msg: '缺少建立镜头，观众难以判断时空关系' });
    if (!shots.some((s) => ['insert', 'crane'].includes(s.typeId))) issues.push({ level: 'info', code: 'no_breath', msg: '全片没有空镜／转场镜头，节奏会比较紧' });
    for (let i = 1; i < shots.length; i += 1) {
        if (shots[i].typeId === shots[i - 1].typeId && shots[i].cameraId === shots[i - 1].cameraId) {
            issues.push({ level: 'warn', code: 'same_grammar', shotId: shots[i].id, msg: `${shotLabel(shots[i - 1])} → ${shotLabel(shots[i])} 景别与运镜完全相同，剪辑点会跳` });
        }
    }
    // 跨镜头一致性：全局影调必须写进每个镜头提示词，否则同一角色在不同镜头里会变色
    const offTone = shots.filter((s) => s.prompt && !String(s.prompt).includes(tone.look));
    if (offTone.length) issues.push({ level: 'warn', code: 'tone', msg: `${shotNamesOf(offTone)} 未继承全局影调「${tone.name}」，跨镜头色彩可能不一致` });
    // 项目引用的角色资产必须至少出场一次，否则一致性约束形同虚设
    const chars = drama.assetRefs?.character || [];
    const used = new Set(shots.reduce((acc, s) => acc.concat(s.refs?.character || []), []));
    const absent = chars.filter((id) => !used.has(id));
    if (absent.length) issues.push({ level: 'warn', code: 'absent', msg: `已关联的角色中有 ${absent.length} 个未被任何镜头引用，形象一致性约束不会生效` });
    return { issues, summary: sum };
}

function shotNamesOf(shots) {
    return shots.slice(0, 3).map((s) => `镜头 ${String(s.no).padStart(2, '0')}`).join('、') + (shots.length > 3 ? ` 等 ${shots.length} 个` : '');
}

export function hasBlocker(result) {
    return (result?.issues || []).some((i) => i.level === 'error');
}

/** 剧本解析的过程计划：引擎按进度逐条落日志，前端流程清单同源复用 */
export function buildParsePlan(drama = {}) {
    const beats = splitBeats(drama.script);
    const p = profileFor(drama.model);
    const target = Number(drama.targetSec) || 30;
    const count = planShotCount(target, beats.length, p.maxShot);
    const chars = drama.assetRefs?.character?.length || 0;
    const props = drama.assetRefs?.prop?.length || 0;
    const scenes = drama.assetRefs?.scenic?.length || 0;
    const chars2 = String(drama.script || '').replace(/\s/g, '').length;
    const merged = Math.max(0, beats.length - count);
    const tone = TONE_MAP[drama.tone] || TONES[0];
    return [
        { at: 4, msg: `读取剧本：${chars2} 字 / ${beats.length} 个句读单元，目标成片 ${target}s` },
        { at: 16, msg: `实体抽取：角色 ${chars} · 道具 ${props} · 场景 ${scenes}（已与资产库关联，用于跨镜头一致性约束）` },
        { at: 30, msg: `节拍切分：识别 ${beats.length} 个叙事节拍${merged ? `，合并 ${merged} 个弱动作节拍` : ''}，判定场景转换 ${Math.max(1, Math.round(beats.length / 4))} 处` },
        { at: 44, msg: `镜头分配：模型 ${drama.model} 单镜头上限 ${p.maxShot}s → ${count} 个镜头（不少于 ${Math.ceil(target / p.maxShot)} 个）` },
        { at: 58, msg: `景别与运镜：逐节拍指派，避免相邻镜头同景别同机位` },
        { at: 72, msg: `提示词装配：注入全局影调「${tone.name} · ${tone.look}」与 ${p.fps}fps / ${p.res} 规格` },
        { at: 86, msg: `时长配平：${count} 段合计 ${target}s，误差 0s` },
        { at: 96, msg: '分镜表生成完成，等待人工审核修改' }
    ];
}

/** 片段合成的过程计划 */
export function buildComposePlan(drama = {}) {
    const shots = drama.shots || [];
    const p = profileFor(drama.model);
    const sum = summaryOf(shots, { model: drama.model });
    const tone = TONE_MAP[drama.tone] || TONES[0];
    const at3 = shots.find((s) => s.seconds >= 3) || shots[0] || {};
    const plan = [
        { at: 3, msg: `收集片段：${shots.length} 个镜头 / ${sum.totalSec}s，逐段校验 ${p.res} · ${p.fps}fps` },
        { at: 14, msg: `转场拼接：${Math.max(0, shots.length - 1)} 个剪辑点，交叉溶解 0.5s` },
        { at: 30, msg: `音画对齐：按 ${p.fps}fps 重采样时间轴，累计漂移 0.0s` },
        { at: 46, msg: `字幕与配音轨：生成 ${shots.length} 条节拍字幕，响度归一 -14 LUFS` },
        { at: 60, msg: `色彩一致性：全片套用「${tone.name}」LUT，角色肤色跨镜头校正` },
        { at: 76, msg: `补帧与稳定：${p.fps}fps 光流插帧，处理 ${Math.max(0, sum.over)} 段超限素材` },
        { at: 88, msg: `抽帧封面：默认取第 3 秒（${at3.name ? shotLabel(at3) : '开场镜头'}）` },
        { at: 97, msg: `封装 MP4：H.264 / ${p.res} / ${sum.totalSec}s，写入产物目录` }
    ];
    return plan;
}

/** 单个镜头的生成过程计划：引擎逐条落日志，工作台的镜头卡片与任务中心同源 */
export function buildShotPlan(shot = {}, model, toneId) {
    const p = profileFor(model);
    const frames = Math.round((Number(shot.seconds) || 0) * p.fps);
    const no = String(shot.no || 1).padStart(2, '0');
    const hasChar = (shot.refs?.character || []).length > 0;
    return [
        { at: 8, msg: `镜头 ${no}：装配 ${SHOT_TYPE_MAP[shot.typeId]?.name || '分镜'} + ${CAMERA_MAP[shot.cameraId]?.name || '运镜'}${hasChar ? '，注入角色一致性嵌入' : ''}` },
        { at: 24, msg: `镜头 ${no}：按 ${p.fps}fps 生成 ${shot.seconds}s 时序潜变量（共 ${frames} 帧）` },
        { at: 48, msg: `镜头 ${no}：运动幅度校验通过，未检出主体形变与手指崩坏` },
        { at: 70, msg: `镜头 ${no}：光流插帧与色彩一致性校正（${(TONE_MAP[toneId] || TONES[0]).look}）` },
        { at: 90, msg: `镜头 ${no}：封装 clip_${no}.mp4 · ${p.res}` }
    ];
}

/** 依据进度取出合成计划已完成的条目（与训练 plan/emitted 指针同构） */
export function planReached(plan, progress) {
    const p = Math.max(0, Math.min(100, Number(progress) || 0));
    return (plan || []).filter((i) => i.at <= p);
}

/** 找到成片第 N 秒落在哪个镜头（封面抽帧用） */
export function shotAtSecond(shots, second = 3) {
    let acc = 0;
    for (const s of shots || []) {
        acc += Number(s.seconds) || 0;
        if (second <= acc) return s;
    }
    return (shots || [])[0] || null;
}

export const DRAMA_STEPS = [
    { id: 1, name: '剧本解析', desc: '长剧本 → 逐镜头分镜表' },
    { id: 2, name: '分镜审核', desc: '修改、排序、增删与体检' },
    { id: 3, name: '片段生成', desc: '逐镜头下单，可单独重试' },
    { id: 4, name: '片段合成', desc: '拼接成片并抽取封面' }
];

export function dramaStepOf(drama = {}) {
    if (drama.status === 'done') return 4;
    if (drama.status === 'composing' || drama.status === 'ready') return 4;
    if (drama.status === 'generating') return 3;
    if (drama.status === 'storyboard' || drama.status === 'review') return 2;
    if (drama.status === 'parsing') return 1;
    return drama.step || 1;
}

/** 镜头全部完成后才能合成；其余状态由镜头与任务进度反推 */
function deriveShotStatus(drama) {
    const shots = drama.shots || [];
    if (shots.some((s) => ['queued', 'running'].includes(s.status))) return 'generating';
    if (shots.length && shots.every((s) => s.status === 'succeeded')) return 'ready';
    return drama.confirmedAt ? 'generating' : 'storyboard';
}

/**
 * 任务结果回写项目（纯领域状态机）。
 * api.js 的取消路径与 engine.js 的完成 / 失败路径共用本函数，
 * 保证「取消一个镜头」「镜头失败」「合成中断」三条路径对状态的解释完全一致。
 */
export function applyTaskResult(drama, task, status) {
    if (!drama || !task) return drama;
    const reason = task.error || (status === 'canceled' ? '任务已取消，可按需重新下单' : null);
    if (task.type === 'script') {
        drama.status = status === 'succeeded' ? 'storyboard' : 'draft';
        drama.parseError = status === 'succeeded' ? null : reason;
    } else if (task.type === 'compose') {
        drama.status = status === 'succeeded' ? 'done' : 'ready';
        if (status !== 'succeeded') {
            drama.composeTaskId = '';
            drama.composeError = reason;
        }
    } else {
        const shot = (drama.shots || []).find((s) => s.id === task.payload?.shotId);
        if (shot) {
            shot.status = status;
            shot.error = status === 'succeeded' ? null : reason;
            if (status !== 'succeeded') shot.output = null;
        }
        drama.status = deriveShotStatus(drama);
    }
    drama.updatedAt = new Date().toISOString();
    return drama;
}

export const DRAMA_STATUS = {
    parsing: { label: '解析中', tone: 'brand' },
    storyboard: { label: '待审核分镜', tone: 'warn' },
    generating: { label: '镜头生成中', tone: 'brand' },
    ready: { label: '待合成', tone: 'ok' },
    composing: { label: '合成中', tone: 'brand' },
    done: { label: '已出成片', tone: 'ok' }
};

/** 新建项目入参归一化（api 与视图共用，保证校验口径一致） */
export function normalizeDramaInput(input = {}) {
    const target = Math.max(LONG_FORM_MIN + 1, Math.min(DURATION_OPTIONS[DURATION_OPTIONS.length - 1], Number(input.targetSec) || 30));
    const model = VIDEO_PROFILES[input.model] ? input.model : 'kling-v';
    const tone = TONE_MAP[input.tone] ? input.tone : 'cold';
    const ratio = input.ratio || '9:16';
    return {
        title: String(input.title || '').trim().slice(0, 40),
        script: String(input.script || '').slice(0, 4000),
        targetSec: target,
        model,
        tone,
        ratio,
        negative: String(input.negative || '').slice(0, 300),
        assetRefs: {
            character: (input.assetRefs?.character || []).slice(0, 8),
            prop: (input.assetRefs?.prop || []).slice(0, 8),
            scenic: (input.assetRefs?.scenic || []).slice(0, 8)
        }
    };
}
