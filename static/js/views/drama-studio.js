/**
 * 长剧本短剧工作台（>15 秒）
 * ------------------------------------------------------------------
 * 四步流水线：① 剧本解析 → ② 分镜审核 → ③ 片段生成 → ④ 片段合成。
 * 解析规则、镜头计费与一致性校验全部来自 core/drama.js，与引擎、任务中心、钱包流水同源：
 * 这里显示的镜头数、秒数与算力，就是引擎实际下单、实际扣费、实际产出的数字。
 * 项目状态全部落库，刷新或离开页面后可从「我的项目」继续。
 */
import {
    getDrama, startDrama, saveDrama, reparseDrama, confirmShots, retryShot, composeDrama,
    deleteDrama, listDramas, listAssets, getAccount, retryTask, cancelTask, submitWork, getWork
} from '../core/api.js';
import { MODELS, RATIOS } from '../core/constants.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast, progressBar, emptyState, copyText, confirmDialog, videoStage, imgTag, openModal, closeModal } from '../core/ui.js';
import { escapeHtml, num, timeAgo, fmtDuration } from '../core/format.js';
import { on, EVENTS } from '../core/bus.js';
import {
    LONG_FORM_MIN, MIN_SHOTS, MAX_SHOTS, SHOT_MIN_SEC, DURATION_OPTIONS,
    SHOT_TYPES, CAMERA_MOVES, TONES, DRAMA_STEPS, DRAMA_STATUS,
    profileFor, videoCost, scriptCost, composeCost, shotEtaMin,
    splitBeats, planShotCount, distributeSeconds, buildShotPrompt, suggestDuration,
    summaryOf, checkDrama, hasBlocker, autoFit, insertShotAfter, moveShot, removeShot,
    shotLabel, shotTypeName, cameraName, toneName, formatStoryboard,
    buildParsePlan, buildComposePlan, planReached, dramaStepOf
} from '../core/drama.js';

const POLL_MS = 1200;
const ACTIVE = ['queued', 'running'];
/** 只有超过快速路径上限的档位才走工作台，≤15 秒仍用 create.js 单任务快速生成 */
const LONG_DURATIONS = DURATION_OPTIONS.filter((d) => d > LONG_FORM_MIN);
const VIDEO_MODELS = MODELS.filter((m) => m.kind === 'video');
const DEFAULT_NEGATIVE = 'low quality, blurry, watermark, extra fingers, inconsistent face';
const SHOT_STATUS = {
    pending: { label: '未下单', cls: '' },
    queued: { label: '排队中', cls: 'badge-warn' },
    running: { label: '生成中', cls: 'badge-brand' },
    succeeded: { label: '片段就绪', cls: 'badge-ok' },
    failed: { label: '生成失败', cls: 'badge-danger' },
    canceled: { label: '已取消', cls: '' }
};
const SAMPLE_SCRIPT =`1. 清晨六点，老城巷口的第一缕光落在青石板上。
2. 早点铺的蒸笼揭开，白雾漫过老板娘的手背。
3. 她抬头望向巷口，像在等一个不会来的人。
4. 少年背着画板冲进巷子，雨水顺着屋檐滴落。
5. 他把一张速写递给她——画上的人，正在这条巷子年轻时的模样。
6. 老板娘怔住，指尖摩挲着纸角褪色的墨迹。
7. 镜头拉远，整条巷子在晨光里苏醒，叫卖声重新响起。`;

const pad = (n) => String(n).padStart(2, '0');

export async function render(host, ctx) {
    setPageTitle('短剧分镜工作台');
    const state = {
        id: String(ctx.query.drama || ''),
        drama: null,
        step: 1,
        pinned: false,
        draft: null,
        edit: { tone: 'cold', targetSec: 30 },
        dirty: false,
        pool: { character: [], prop: [], scenic: [] },
        newRefs: { character: [], prop: [], scenic: [] },
        projects: [],
        credits: 0,
        work: null,
        dragFrom: null,
        timer: null
    };

    const account = await getAccount().catch(() => ({ credits: 0 }));
    state.credits = account.credits || 0;
    state.projects = (await listDramas().catch(() => ({ dramas: [] }))).dramas;
    const assets = await listAssets({ pageSize: 100, kind: 'all' }).catch(() => ({ items: [] }));
    ['character', 'prop', 'scenic'].forEach((k) => {
        state.pool[k] = assets.items.filter((a) => a.kind === k);
    });

    if (state.id) {
        try {
            state.drama = (await getDrama(state.id)).drama;
        } catch (err) {
            toast(err.message || '项目不存在，已为你打开新建面板', 'warn');
            state.id = '';
        }
    }
    if (state.drama) syncFromDrama();

    host.innerHTML = `
        <div class="page-head">
            <div class="page-head-main">
                <h1 class="page-title">${state.drama ? escapeHtml(state.drama.title) : '短剧分镜工作台'}
                    <span id="dStatus">${state.drama ? dramaBadge(state.drama) : ''}</span></h1>
                <div class="page-sub">超过 ${LONG_FORM_MIN} 秒的短剧拆成镜头逐段生成：长剧本解析 → 人工审核修改 → 逐镜头下单 → 片段合成</div>
            </div>
            <div class="page-actions">
                <span class="balance-chip">${icon('credit', 14)} <b id="dCredits">${num(state.credits)}</b></span>
                <a class="btn btn-outline" href="${url('assets/my-assets-video.html')}">${icon('video', 15)}我的短剧</a>
                ${state.drama ? `<button class="btn btn-outline" data-act="new">${icon('plus', 15)}新建项目</button>` : ''}
            </div>
        </div>
        <div class="d-steps" id="dSteps"></div>
        <div id="dPanel"></div>`;

    const panel = host.querySelector('#dPanel');
    const stepsEl = host.querySelector('#dSteps');

    /* ---------------- 状态与重绘 ---------------- */
    function syncFromDrama() {
        const d = state.drama;
        state.edit = { tone: d.tone, targetSec: d.targetSec };
        state.draft = (d.shots || []).map((s) => JSON.parse(JSON.stringify(s)));
        state.dirty = false;
        if (!state.pinned) state.step = dramaStepOf(d);
    }

    function isActive() {
        return Boolean(state.drama) && ['parsing', 'generating', 'composing'].includes(state.drama.status);
    }

    function canEditStoryboard() {
        return Boolean(state.drama) && !['generating', 'composing', 'done'].includes(state.drama.status);
    }

    /** 审核步骤的本地草稿视图：未保存的影调 / 时长也参与实时校验与预估 */
    function draftDrama() {
        const d = state.drama;
        return { ...d, tone: state.edit.tone, targetSec: state.edit.targetSec, shots: state.draft || d.shots || [] };
    }

    function draw() {
        drawSteps();
        drawPanel();
        armPolling();
    }

    function drawSteps() {
        const reach = reachable();
        stepsEl.innerHTML = DRAMA_STEPS.map((s, i) => {
            const step = s.id;
            const cur = state.step === step;
            const st = stepState(step);
            const disabled = !reach[step];
            return `${i ? '<span class="d-steps-sep"></span>' : ''}
                <button class="d-step ${st} ${cur ? 'cur' : ''}" data-step="${step}" ${disabled ? 'disabled' : ''}>
                    <span class="d-step-no">${st === 'done' ? icon('check', 13) : step}</span>
                    <span class="d-step-txt">
                        <b>${s.name}</b>
                        <em>${cur ? stepHint(step) : s.desc}</em>
                    </span>
                </button>`;
        }).join('');
    }

    function stepHint(step) {
        const d = state.drama;
        if (!d) return step === 1 ? '填写剧本并解析分镜' : '完成上一步后可进入';
        if (step === 1) return d.status === 'parsing' ? '解析任务进行中' : `已拆出 ${(d.shots || []).length} 个镜头`;
        if (step === 2) {
            const n = (state.draft || d.shots || []).length;
            // 已确认的项目再回来看这一步，不该继续提示「待审核」
            return d.confirmedAt ? `已确认 ${n} 个镜头` : `${n} 个镜头待审核`;
        }
        if (step === 3) return `${summaryOf(d.shots, { model: d.model }).done}/${(d.shots || []).length} 个片段就绪`;
        return d.status === 'done' ? '成片已生成' : '等待镜头全部完成';
    }

    function stepState(step) {
        const d = state.drama;
        if (!d) return step === 1 ? 'active' : 'todo';
        const cur = dramaStepOf(d);
        if (step < cur) return 'done';
        if (step > cur) return 'todo';
        const bad = d.status === 'draft' || (step === 3 && (d.shots || []).some((s) => ['failed', 'canceled'].includes(s.status)));
        return bad ? 'bad' : 'active';
    }

    function reachable() {
        const d = state.drama;
        if (!d) return { 1: true, 2: false, 3: false, 4: false };
        const shots = d.shots || [];
        return {
            1: true,
            2: shots.length > 0,
            3: Boolean(d.confirmedAt) || shots.some((s) => s.status !== 'pending'),
            4: ['ready', 'composing', 'done'].includes(d.status)
        };
    }

    function drawPanel() {
        if (!state.drama) return drawNew();
        if (state.step === 2) return drawReview();
        if (state.step === 3) return drawGenerate();
        if (state.step === 4) return drawCompose();
        return drawParse();
    }

    async function gotoStep(step) {
        if (!reachable()[step]) {
            toast('请先完成上一步', 'warn', 1600);
            return;
        }
        if (state.dirty && step !== 2) {
            const ok = await confirmDialog({
                title: '分镜改动未保存',
                message: '离开审核步骤会丢失未保存的镜头改动，确定继续？',
                confirmText: '放弃改动',
                cancelText: '留在审核'
            });
            if (!ok) return;
            state.dirty = false;
            state.draft = (state.drama.shots || []).map((s) => JSON.parse(JSON.stringify(s)));
        }
        state.pinned = step !== dramaStepOf(state.drama);
        state.step = step;
        draw();
    }

    /** 作品记录是异步补取的：到手后若正停在第 4 步要重画一次，否则发布状态会一直停在「草稿」 */
    function fetchFilmWork(workId) {
        if (!workId || state.work) return;
        getWork(workId).then((r) => {
            if (state.drama?.workId !== workId) return;
            state.work = r.work;
            if (state.step === 4) draw();
        }).catch(() => {});
    }

    async function reload({ follow = true } = {}) {
        if (!state.id) return;
        try {
            const res = await getDrama(state.id);
            state.drama = res.drama;
            fetchFilmWork(state.drama.workId);
            if (isActive() || !state.dirty) {
                state.draft = (state.drama.shots || []).map((s) => JSON.parse(JSON.stringify(s)));
                state.dirty = false;
            }
            if (follow && !state.pinned) state.step = dramaStepOf(state.drama);
            host.querySelector('#dStatus').innerHTML = dramaBadge(state.drama);
            draw();
        } catch (err) {
            stopPolling();
        }
    }

    function armPolling() {
        stopPolling();
        if (!isActive()) return;
        state.timer = setInterval(() => reload(), POLL_MS);
    }

    function stopPolling() {
        if (state.timer) {
            clearInterval(state.timer);
            state.timer = null;
        }
    }

    /* ---------------- 第一步 · 新建项目 ---------------- */
    function drawNew() {
        panel.innerHTML = `
            <div class="d-cols">
                <div class="card">
                    <div class="card-head">
                        <div>
                            <div class="card-title">新建长剧本项目</div>
                            <div class="card-sub">写完整剧本（或分场大纲），解析任务会按句读节拍拆出逐镜头分镜表</div>
                        </div>
                        <div class="spacer"></div>
                        <span class="cost-pill" id="nParseCost">${icon('credit', 13)} 解析 ${scriptCost(30, 0)} 算力</span>
                    </div>
                    <div class="card-body">
                        <div class="form-grid">
                            <div class="field span-2">
                                <label class="label" for="nTitle">短剧名称 <span class="req">*</span>
                                    <span class="hint-inline">成片标题，可随时修改</span></label>
                                <input class="input" id="nTitle" maxlength="40" placeholder="例如：霓虹夜行 · 第三班地铁">
                            </div>
                            <div class="field">
                                <label class="label" for="nDuration">成片目标时长 <span class="req">*</span>
                                    <span class="hint-inline" id="nDurHint">≤15 秒请走快速生成</span></label>
                                <select class="select" id="nDuration" data-field="duration">
                                    <option value="auto" selected>自动 · 按剧本推算</option>
                                    ${LONG_DURATIONS.map((d) => `<option value="${d}">${d} 秒（约 ${planShotCount(d, 8, 10)} 个镜头）</option>`).join('')}
                                </select>
                            </div>
                            <div class="field">
                                <label class="label" for="nModel">视频模型</label>
                                <select class="select" id="nModel" data-field="model">
                                    ${VIDEO_MODELS.map((m) => `<option value="${m.id}">${m.name} · 单镜头 ≤ ${profileFor(m.id).maxShot}s</option>`).join('')}
                                </select>
                            </div>
                            <div class="field">
                                <label class="label" for="nTone">全局影调 <span class="hint-inline">写进每个镜头提示词，保证跨镜头一致</span></label>
                                <select class="select" id="nTone">${TONES.map((t) => `<option value="${t.id}">${t.name} · ${t.look}</option>`).join('')}</select>
                            </div>
                            <div class="field">
                                <label class="label" for="nRatio">画幅比例</label>
                                <select class="select" id="nRatio">${RATIOS.map((r) => `<option value="${r.id}" ${r.id === '9:16' ? 'selected' : ''}>${r.label}（${r.w}×${r.h}）</option>`).join('')}</select>
                            </div>
                            <div class="field span-2">
                                <label class="label" for="nNegative">全局负面提示词</label>
                                <input class="input" id="nNegative" value="${escapeHtml(DEFAULT_NEGATIVE)}">
                            </div>
                        </div>

                        <div class="field" style="margin-top:14px">
                            <label class="label" for="nScript">剧本 / 分场大纲 <span class="req">*</span>
                                <span class="hint-inline">按 。！？；换行 切分节拍，一句通常落成一个镜头</span>
                                <span class="hint-inline" id="nCount" style="margin-left:auto">0 字 / 0 个节拍</span></label>
                            <textarea class="textarea d-script" id="nScript" data-field="script" maxlength="4000"
                                rows="9" placeholder="1. 开场：&#10;2. 推进：&#10;3. 转折：&#10;4. 收束：">${escapeHtml(SAMPLE_SCRIPT)}</textarea>
                            <div class="row mt-8" style="gap:8px">
                                <button class="btn btn-sm btn-ghost" data-act="sample">${icon('scroll', 13)}载入示例剧本</button>
                                <button class="btn btn-sm btn-ghost" data-act="clear-script">${icon('x', 13)}清空</button>
                            </div>
                        </div>

                        ${refGroupsHtml('n', state.newRefs)}

                        <div class="train-estimate" id="nEstimate"></div>
                        <div id="nIssues" class="d-issues"></div>

                        <div class="divider"></div>
                        <div class="row" style="gap:10px">
                            <button class="btn btn-primary" data-act="parse" id="nParseBtn">${icon('wand', 15)}解析剧本 · 生成分镜表</button>
                            <span class="small muted">解析只收第一步算力，镜头按确认后单独下单，可分步取消</span>
                        </div>
                    </div>
                </div>
                <aside class="d-side">
                    ${sideFlowHtml()}
                    <div class="card">
                        <div class="card-head"><div class="card-title">我的项目</div>
                            <div class="spacer"></div><span class="small muted">${state.projects.length}</span></div>
                        <div class="card-body col" style="gap:8px" id="nProjects">${projectsHtml()}</div>
                    </div>
                </aside>
            </div>`;
        refreshNewEstimate();
    }

    function sideFlowHtml() {
        return `<div class="card">
            <div class="card-head"><div class="card-title">流程与计费</div></div>
            <div class="card-body col" style="gap:10px">
                ${DRAMA_STEPS.map((s) => `<div class="row" style="gap:8px;align-items:flex-start">
                    <span class="d-step-no sm">${s.id}</span>
                    <div><b class="small">${s.name}</b><div class="small muted">${s.desc}</div></div>
                </div>`).join('')}
                <div class="divider"></div>
                <div class="est-note">${icon('info', 13)}<span>解析按剧本规模与目标时长计费；镜头按模型单价 × 秒数逐条计费；合成按总时长与镜头数计费。中断或失败的镜头按全额退还，已完成的片段保留。</span></div>
            </div>
        </div>`;
    }

    function refGroupsHtml(prefix, refs) {
        return `<div class="field" style="margin-top:14px">
            <label class="label">关联资产 <span class="hint-inline">角色贯穿全片，道具与场景按节拍轮换</span></label>
            ${['character', 'prop', 'scenic'].map((k) => `<div class="d-refgroup">
                <span class="d-refkind">${{ character: '角色', prop: '道具', scenic: '场景' }[k]}</span>
                <div class="chips">
                    ${state.pool[k].length ? state.pool[k].map((a) => `<button class="chip ${refs[k]?.includes(a.id) ? 'active' : ''}" data-act="ref" data-kind="${k}" data-id="${a.id}" data-prefix="${prefix}">${escapeHtml(a.title)}</button>`).join('') : '<span class="small muted">资产库暂无</span>'}
                </div>
            </div>`).join('')}
        </div>`;
    }

    function newInput() {
        const script = panel.querySelector('#nScript')?.value || '';
        const model = panel.querySelector('#nModel')?.value || 'kling-v';
        return {
            title: (panel.querySelector('#nTitle')?.value || '').trim(),
            script,
            targetSec: resolveNewDuration(script, model),
            model,
            tone: panel.querySelector('#nTone')?.value || 'cold',
            ratio: panel.querySelector('#nRatio')?.value || '9:16',
            negative: (panel.querySelector('#nNegative')?.value || '').trim(),
            assetRefs: state.newRefs
        };
    }

    /** 目标时长下拉的取值 → 实际秒数：自动档按剧本节拍推算，并抬到快速路径上限之上 */
    function resolveNewDuration(script, model) {
        if ((panel.querySelector('#nDuration')?.value || 'auto') !== 'auto') {
            return Number(panel.querySelector('#nDuration').value) || LONG_DURATIONS[0];
        }
        return suggestDuration(script, model, { minSec: LONG_FORM_MIN + 1 }).seconds || LONG_DURATIONS[0];
    }

    function refreshNewEstimate() {
        const v = newInput();
        const auto = (panel.querySelector('#nDuration')?.value || 'auto') === 'auto';
        const sug = auto ? suggestDuration(v.script, v.model, { minSec: LONG_FORM_MIN + 1 }) : null;
        const beats = v.script.trim() ? splitBeats(v.script).length : 0;
        const p = profileFor(v.model);
        const count = planShotCount(v.targetSec, beats || Math.max(MIN_SHOTS, Math.ceil(v.targetSec / p.maxShot)), p.maxShot);
        const secs = distributeSeconds(v.targetSec, count, p.maxShot);
        const shotCostTotal = secs.reduce((sum, s) => sum + videoCost(v.model, s), 0);
        const parse = scriptCost(v.targetSec, v.script.length);
        const compose = composeCost(v.targetSec, count);
        const total = parse + shotCostTotal + compose;
        const eta = Math.max(1, Math.ceil(secs.reduce((sum, s) => sum + shotEtaMin(v.model, s), 0) / 3));
        panel.querySelector('#nCount').textContent = `${v.script.length} 字 / ${beats} 个节拍`;
        panel.querySelector('#nDurHint').textContent = auto
            ? (sug.seconds ? `自动推算 · ${v.targetSec} 秒` : '写满 10 字后自动推算')
            : '≤15 秒请走快速生成';
        panel.querySelector('#nParseCost').innerHTML = `${icon('credit', 13)} 解析 ${parse} 算力`;
        panel.querySelector('#nEstimate').innerHTML = [
            estTile('scroll', '预计镜头', `${count} 个`, `${p.maxShot}s/镜上限 · ${secs.slice(0, 4).join(' + ')}${secs.length > 4 ? ' + …' : ''} 秒`),
            estTile('clock', '成片时长', `${secs.reduce((a, b) => a + b, 0)}s`, sug ? `自动推算：${sug.reason}` : `目标 ${v.targetSec}s · 配平误差 0s`),
            estTile('credit', '三步合计', `${total} 算力`, `解析 ${parse} + 片段 ${shotCostTotal} + 合成 ${compose}`, total > state.credits),
            estTile('zap', '镜头耗时', `约 ${eta} 分钟`, `${v.model} · 3 路并行出片`),
            estTile('film', '生成规格', `${p.res} / ${p.fps}fps`, `${v.ratio} · ${toneName(v.tone)}`)
        ].join('');
        const issues = [];
        if (!v.title) issues.push({ level: 'warn', msg: '还没填写短剧名称' });
        if (v.script.trim().length < 20) issues.push({ level: 'error', msg: '剧本至少 20 个字才能切出可用节拍' });
        else if (beats < MIN_SHOTS) issues.push({ level: 'warn', msg: `只识别到 ${beats} 个节拍，系统会按叙事骨架补齐镜头` });
        if (count > MAX_SHOTS) issues.push({ level: 'error', msg: `镜头数 ${count} 超过单项目上限 ${MAX_SHOTS}，请缩短时长或改用更长镜头` });
        if (total > state.credits) issues.push({ level: 'error', msg: `余额 ${state.credits} 算力不足，全流程预估需要 ${total} 算力，可先充值或减少镜头` });
        panel.querySelector('#nIssues').innerHTML = issues.length ? issues.map(issueHtml).join('')
            : `<div class="est-note">${icon('check', 13)}<span>参数校验通过：解析完成后会进入审核步骤，可逐镜头修改、排序与增删。</span></div>`;
        panel.querySelector('#nParseBtn').disabled = issues.some((i) => i.level === 'error');
    }

    /* ---------------- 第一步 · 解析进行中 ---------------- */
    function drawParse() {
        const d = state.drama;
        const task = d.parseTask;
        const progress = Math.max(0, Math.min(100, Math.round(task?.progress || 0)));
        const running = task && ACTIVE.includes(task.status);
        const plan = buildParsePlan(d);
        const p = profileFor(d.model);
        panel.innerHTML = `
            <div class="d-cols">
                <div class="card live-card">
                    <div class="card-head">
                        <div>
                            <div class="card-title">长剧本解析</div>
                            <div class="card-sub">${d.script.length} 字 · 目标 ${d.targetSec}s · ${d.model}（单镜头 ≤ ${p.maxShot}s）· 已消耗 ${d.parseCost} 算力</div>
                        </div>
                        <div class="spacer"></div>
                        ${running ? `<button class="btn btn-sm btn-outline" data-act="cancel-parse">${icon('stop', 13)}取消解析</button>` : ''}
                        ${task && !running ? `<button class="btn btn-sm btn-outline" data-act="reparse">${icon('refresh', 13)}重新解析</button>` : ''}
                    </div>
                    <div class="card-body">
                        <div class="row wrap" style="gap:6px;margin-bottom:12px">
                            <span class="plan-pill">${toneName(d.tone)}</span>
                            <span class="plan-pill">${d.ratio}</span>
                            <span class="plan-pill">${(d.assetRefs?.character || []).length} 角色 / ${(d.assetRefs?.prop || []).length} 道具 / ${(d.assetRefs?.scenic || []).length} 场景</span>
                            ${task ? `<a class="plan-pill" href="${url('tasks.html')}" target="self">任务 ${task.id} ${icon('external', 11)}</a>` : ''}
                        </div>
                        <div id="dParseBody">${parseBody(task, progress, plan, running)}</div>
                        <div class="divider"></div>
                        <div class="row" style="gap:10px;flex-wrap:wrap">
                            <button class="btn btn-primary" data-act="reparse">${icon('refresh', 15)}按当前剧本重新解析</button>
                            ${(d.shots || []).length ? `<button class="btn btn-outline" data-act="goto" data-to="2">${icon('edit', 15)}直接审核已有分镜</button>` : ''}
                            <span class="small muted">解析失败或取消都会退还算力，可反复调整剧本重做。</span>
                        </div>
                    </div>
                </div>
                <aside class="d-side">
                    <div class="card">
                        <div class="card-head"><div class="card-title">剧本</div>
                            <div class="spacer"></div><span class="small muted" id="dScriptCount">${d.script.length} 字</span></div>
                        <div class="card-body">
                            <textarea class="textarea d-script" data-field="script" rows="12" ${running ? 'disabled' : ''}>${escapeHtml(d.script)}</textarea>
                            <div class="small muted mt-8">改完点「重新解析」按新剧本重下单；旧分镜与已生成片段会被清空。</div>
                        </div>
                    </div>
                    <div class="card">
                        <div class="card-head"><div class="card-title">我的项目</div></div>
                        <div class="card-body col" style="gap:8px">${projectsHtml()}</div>
                    </div>
                </aside>
            </div>`;
    }

    function parseBody(task, progress, plan, running) {
        if (!task) return emptyState({ title: '还没有解析任务', desc: '点下方按钮按当前剧本下单解析。' });
        if (task.status === 'canceled' || task.status === 'failed') {
            return `<div class="est-note ${task.status === 'failed' ? 'bad' : 'warn'}">${icon('alert', 13)}
                <span>${escapeHtml(task.error || '解析任务已取消')}，${task.refund ? `已退还 ${task.refund} 算力` : '本次未产生消耗'}。修改剧本后可重新解析。</span></div>
                <div class="log-panel mt-12">${logLines(task.logs)}</div>`;
        }
        return `${flowList(plan, progress)}
            <div style="margin:12px 0 6px">${progressBar(progress, '', running)}</div>
            <div class="row between small muted"><span>${task.status === 'succeeded' ? '解析完成' : running ? '解析进行中' : '排队中'}</span>
                <span>${progress}%</span></div>
            <div class="log-panel mt-12">${logLines(task.logs)}</div>
            ${task.status === 'succeeded' ? `<div class="est-note mt-12">${icon('check', 13)}<span>已拆出 ${(state.drama.shots || []).length} 个镜头，进入审核步骤逐条修改。</span></div>
                <button class="btn btn-primary btn-block mt-8" data-act="goto" data-to="2">${icon('edit', 15)}去审核分镜</button>` : ''}`;
    }

    /* ---------------- 第二步 · 分镜审核 ---------------- */
    function drawReview() {
        const dd = draftDrama();
        const locked = !canEditStoryboard();
        const check = checkDrama(dd);
        const blocked = hasBlocker(check);
        const pending = dd.shots.filter((s) => !ACTIVE.includes(s.status) && s.status !== 'succeeded');
        const pendingCost = pending.reduce((sum, s) => sum + videoCost(dd.model, s.seconds), 0);
        panel.innerHTML = `
            <div class="d-cols">
                <div class="card">
                    <div class="card-head">
                        <div>
                            <div class="card-title">分镜审核与修改</div>
                            <div class="card-sub">${locked ? '任务进行中，分镜表已锁定；可切换到片段生成查看进度' : '拖动左侧手柄排序 · 改动需保存后才会下单 · 体检不通过会阻断生成'}</div>
                        </div>
                        <div class="spacer"></div>
                        <button class="btn btn-sm btn-ghost" data-act="copy-sb">${icon('copy', 13)}复制分镜表</button>
                        <button class="btn btn-sm btn-ghost" data-act="fit" ${locked ? 'disabled' : ''}>${icon('sliders', 13)}一键配平</button>
                    </div>
                    <div class="card-body">
                        <div class="train-estimate" id="dSummary"></div>
                        <div class="d-issues" id="dIssues"></div>
                        <div class="label" style="margin:14px 0 6px">时间轴
                            <span class="hint-inline">段宽 = 镜头时长，虚线 = 目标时长，刻度 = 封面抽帧点（第 3 秒）</span></div>
                        <div id="dTimeline"></div>
                        <div class="d-shots" id="dShots">${dd.shots.map((s, i) => shotCard(s, i, locked, dd)).join('')}</div>
                        <div class="d-bar">
                            <button class="btn btn-outline btn-sm" data-act="add-shot" ${locked || dd.shots.length >= MAX_SHOTS ? 'disabled' : ''}>${icon('plus', 14)}新增镜头</button>
                            <span class="small muted" id="dBarNote"></span>
                            <div class="spacer"></div>
                            ${pending.length ? `<button class="btn btn-primary" data-act="confirm" ${blocked || locked ? 'disabled' : ''}>
                                    ${icon('zap', 15)}确认并生成 ${pending.length} 个片段 · ${pendingCost} 算力</button>`
                                : `<button class="btn btn-primary" data-act="goto" data-to="3">${icon('film', 15)}查看片段进度</button>`}
                        </div>
                    </div>
                </div>
                <aside class="d-side">
                    <div class="card">
                        <div class="card-head"><div class="card-title">项目参数</div></div>
                        <div class="card-body col" style="gap:12px">
                            <div class="field"><label class="label" for="rTarget">目标成片时长 <span class="hint-inline">改完请配平</span></label>
                                <input class="input" type="number" id="rTarget" min="${LONG_FORM_MIN + 1}" max="180" step="1"
                                    data-field="targetSec" value="${dd.targetSec}" ${locked ? 'disabled' : ''}>
                                <button class="btn btn-sm btn-ghost mt-8" data-act="auto-target" ${locked ? 'disabled' : ''}>
                                    ${icon('wand', 13)}不确定多长？按剧本推算</button></div>
                            <div class="field"><label class="label" for="rTone">全局影调</label>
                                <select class="select" id="rTone" data-field="tone" ${locked ? 'disabled' : ''}>
                                    ${TONES.map((t) => `<option value="${t.id}" ${t.id === state.edit.tone ? 'selected' : ''}>${t.name} · ${t.look}</option>`).join('')}
                                </select></div>
                            <div class="form-grid">
                                <div class="field"><label class="label">视频模型</label><div class="d-readonly">${d_modelName(dd.model)} · 单镜头 ≤ ${profileFor(dd.model).maxShot}s</div></div>
                                <div class="field"><label class="label">画幅</label><div class="d-readonly">${escapeHtml(dd.ratio)}</div></div>
                            </div>
                            <div class="small muted">模型与画幅在解析后固定，需要更换请回第一步重新解析。</div>
                        </div>
                    </div>
                    <div class="card">
                        <div class="card-head"><div class="card-title">一致性约束</div></div>
                        <div class="card-body col" style="gap:8px">
                            ${consistencyHtml(dd)}
                        </div>
                    </div>
                    <div class="card">
                        <div class="card-head"><div class="card-title">分镜表（纯文本）</div>
                            <div class="spacer"></div><button class="btn btn-sm btn-ghost" data-act="copy-sb">${icon('copy', 12)}</button></div>
                        <div class="card-body"><pre class="d-toml">${escapeHtml(formatStoryboard(dd))}</pre></div>
                    </div>
                </aside>
            </div>`;
        refreshLive();
    }

    function d_modelName(id) {
        return MODELS.find((m) => m.id === id)?.name || id;
    }

    function consistencyHtml(dd) {
        const tone = TONES.find((t) => t.id === dd.tone) || TONES[0];
        const withTone = dd.shots.filter((s) => String(s.prompt || '').includes(tone.look)).length;
        const chars = dd.assetRefs?.character || [];
        const used = new Set(dd.shots.reduce((acc, s) => acc.concat(s.refs?.character || []), []));
        const cams = new Set(dd.shots.map((s) => `${s.typeId}/${s.cameraId}`));
        return `
            <div class="row between small"><span class="muted">影调注入</span><b>${withTone}/${dd.shots.length} 个镜头</b></div>
            <div class="row between small"><span class="muted">角色出场覆盖</span><b>${chars.length ? `${used.size}/${chars.length} 个` : '未关联'}</b></div>
            <div class="row between small"><span class="muted">镜头语言组合</span><b>${cams.size} 种</b></div>
            <div class="est-note">${icon('info', 13)}<span>全局影调「${tone.name}」是跨镜头色彩统一的唯一保证；提示词里删掉 ${tone.look} 会让同一角色在不同镜头里变色。</span></div>`;
    }

    function shotCard(s, i, locked, dd) {
        const st = SHOT_STATUS[s.status] || SHOT_STATUS.pending;
        const p = profileFor(dd.model);
        const done = s.status === 'succeeded';
        const busy = ACTIVE.includes(s.status);
        const off = locked || busy;
        return `<article class="d-shot st-${s.status}" data-index="${i}" id="shot-${s.id}">
            <div class="d-shot-head">
                <span class="d-handle" draggable="${locked ? 'false' : 'true'}" data-drag="${i}" title="拖动排序">${icon('menu', 14)}</span>
                <span class="d-no">${pad(s.no)}</span>
                <input class="input d-name" data-field="name" data-index="${i}" value="${escapeHtml(s.name)}" maxlength="40" ${locked ? 'disabled' : ''}>
                <span class="badge ${st.cls}">${st.label}</span>
                <div class="spacer"></div>
                <span class="d-cost" data-cost="${i}">${videoCost(dd.model, s.seconds)} 算力</span>
                <button class="icon-btn" data-act="insert" data-index="${i}" title="在此镜头后插入" ${locked || dd.shots.length >= MAX_SHOTS ? 'disabled' : ''}>${icon('plus', 14)}</button>
                <button class="icon-btn" data-act="remove" data-index="${i}" title="删除镜头" ${off || done ? 'disabled' : ''}>${icon('trash', 14)}</button>
            </div>
            <div class="d-shot-body">
                <div class="d-params">
                    <label class="d-mini"><span>景别</span>
                        <select class="select" data-field="typeId" data-index="${i}" ${off ? 'disabled' : ''}>
                            ${SHOT_TYPES.map((t) => `<option value="${t.id}" ${t.id === s.typeId ? 'selected' : ''}>${t.name}</option>`).join('')}
                        </select></label>
                    <label class="d-mini"><span>运镜</span>
                        <select class="select" data-field="cameraId" data-index="${i}" ${off ? 'disabled' : ''}>
                            ${CAMERA_MOVES.map((c) => `<option value="${c.id}" ${c.id === s.cameraId ? 'selected' : ''}>${c.name}</option>`).join('')}
                        </select></label>
                    <label class="d-mini"><span>时长（上限 ${p.maxShot}s）</span>
                        <input class="input" type="number" min="${SHOT_MIN_SEC}" max="${p.maxShot}" step="1"
                            data-field="seconds" data-index="${i}" value="${s.seconds}" ${off || done ? 'disabled' : ''}></label>
                    <label class="d-mini"><span>预计耗时</span><b class="mono d-mini-val">${shotEtaMin(dd.model, s.seconds)} 分钟</b></label>
                </div>
                <div class="d-beat">${icon('scroll', 12)}<span>${escapeHtml(s.beat || '—')}</span></div>
                <textarea class="textarea d-prompt" data-field="prompt" data-index="${i}" rows="3" maxlength="600" ${off ? 'disabled' : ''}>${escapeHtml(s.prompt)}</textarea>
                <div class="row" style="gap:8px;margin-top:6px">
                    <input class="input" data-field="negative" data-index="${i}" value="${escapeHtml(s.negative || '')}" placeholder="本镜头负面词" ${off ? 'disabled' : ''}>
                    <button class="btn btn-sm btn-ghost" data-act="reprompt" data-index="${i}" ${off ? 'disabled' : ''} title="按节拍 / 景别 / 运镜 / 影调重新装配">${icon('wand', 13)}重建提示词</button>
                </div>
                ${refsEditorHtml(i, s, off)}
                ${done ? `<div class="d-shot-out">
                    ${imgTag(s.output?.poster || '', `${shotLabel(s)} 封面`, 'd-shot-thumb')}
                    <div class="min-w-0">
                        <b class="small">${escapeHtml(shotLabel(s))} 片段已生成</b>
                        <div class="small muted">${s.output?.seconds || s.seconds}s · 实付 ${s.cost || videoCost(dd.model, s.seconds)} 算力 · 时长已锁定</div>
                        <div class="row wrap" style="gap:6px;margin-top:6px">
                            <button class="btn btn-sm btn-outline" data-act="preview" data-id="${s.id}">${icon('play', 13)}预览片段</button>
                            <button class="btn btn-sm btn-ghost" data-act="retry-shot" data-id="${s.id}">${icon('refresh', 13)}重做这一镜</button>
                            <a class="btn btn-sm btn-ghost" href="${url('tasks.html')}" target="self">${icon('list', 13)}查看任务</a>
                        </div>
                    </div>
                </div>` : ''}
                ${busy ? `<div class="d-shot-run">${progressBar(s.task?.progress || 0, '', true)}
                    <span class="small muted">${escapeHtml(s.task?.msg || '排队中…')}</span>
                    <button class="btn btn-sm btn-ghost" data-act="cancel-shot" data-id="${s.taskId}">${icon('stop', 13)}取消该镜头</button></div>` : ''}
                ${['failed', 'canceled'].includes(s.status) ? `<div class="est-note bad" style="margin-top:8px">${icon('alert', 13)}
                    <span>${escapeHtml(s.error || '镜头未生成')}${s.task?.refund ? ` · 已退还 ${s.task.refund} 算力` : ''}</span>
                    <div class="spacer"></div>
                    <button class="btn btn-sm btn-outline" data-act="retry-shot" data-id="${s.id}">${icon('refresh', 13)}单独重试</button></div>` : ''}
            </div>
        </article>`;
    }

    function refsEditorHtml(i, s, off) {
        return `<div class="d-refs">${['character', 'prop', 'scenic'].map((k) => {
            const pool = state.pool[k];
            if (!pool.length) return '';
            const picked = s.refs?.[k] || [];
            return `<div class="d-refrow">
                <span class="d-refkind">${{ character: '角色', prop: '道具', scenic: '场景' }[k]}</span>
                ${pool.map((a) => `<button class="d-refchip ${picked.includes(a.id) ? 'on' : ''}" data-act="shot-ref" data-index="${i}" data-kind="${k}" data-id="${a.id}" ${off ? 'disabled' : ''}>${escapeHtml(a.title)}</button>`).join('')}
            </div>`;
        }).join('')}</div>`;
    }

    function refreshLive() {
        if (state.step !== 2 || !state.drama) return;
        const dd = draftDrama();
        const sum = summaryOf(dd.shots, { model: dd.model, targetSec: dd.targetSec });
        const check = checkDrama(dd);
        // 体检结果是底部提示条与确认按钮共用的判定，必须在函数顶层就算好
        const blocked = hasBlocker(check);
        const setHtml = (sel, html) => {
            const el = panel.querySelector(sel);
            if (el) el.innerHTML = html;
        };
        setHtml('#dSummary', [
            estTile('film', '镜头数', `${sum.count} 个`, `${MIN_SHOTS} - ${MAX_SHOTS} 个可调`, sum.count > MAX_SHOTS || sum.count < MIN_SHOTS),
            estTile('clock', '分镜合计', `${sum.totalSec}s`, sum.delta === 0 ? `与目标 ${sum.targetSec}s 完全配平` : `目标 ${sum.targetSec}s，差 ${sum.delta > 0 ? '+' : ''}${sum.delta}s`, sum.delta !== 0),
            estTile('credit', '片段生成', `${sum.cost} 算力`, `${dd.model} · base + 单价 × 秒`, false),
            estTile('zap', '生成耗时', `约 ${sum.etaMin} 分钟`, '3 路并行，逐镜头独立队列'),
            estTile('layers', '已完成', `${sum.done}/${sum.count}`, sum.failed ? `${sum.failed} 个失败可单独重试` : '全部片段就绪', sum.failed > 0)
        ].join(''));
        setHtml('#dIssues', check.issues.length ? check.issues.map(issueHtml).join('')
            : `<div class="est-note">${icon('check', 13)}<span>分镜体检通过：时长配平、景别不重复、影调已注入每个镜头，可以直接下单生成。</span></div>`);
        setHtml('#dTimeline', timelineHtml(dd, sum));
        dd.shots.forEach((s, i) => {
            const costEl = panel.querySelector(`[data-cost="${i}"]`);
            if (costEl) costEl.textContent = `${videoCost(dd.model, s.seconds)} 算力`;
            const etaEl = panel.querySelectorAll('.d-mini-val')[i];
            if (etaEl) etaEl.textContent = `${shotEtaMin(dd.model, s.seconds)} 分钟`;
        });
        const note = panel.querySelector('#dBarNote');
        if (note) {
            note.innerHTML = state.dirty
                ? `<span style="color:var(--warn)">${icon('alert', 13)} 有 ${dd.shots.length} 个镜头待保存</span>`
                : blocked ? `<span style="color:var(--danger)">${icon('alert', 13)} 体检未通过，需先修正阻断项</span>`
                    : `<span class="muted">合计 ${sum.totalSec}s · ${sum.cost} 算力 · ${toneName(dd.tone)}</span>`;
        }
        const confirmBtn = panel.querySelector('[data-act="confirm"]');
        if (confirmBtn) {
            const pending = dd.shots.filter((s) => !ACTIVE.includes(s.status) && s.status !== 'succeeded');
            const cost = pending.reduce((a, s) => a + videoCost(dd.model, s.seconds), 0);
            confirmBtn.disabled = blocked || pending.length === 0 || cost > state.credits;
            confirmBtn.innerHTML = `${icon('zap', 15)}确认并生成 ${pending.length} 个片段 · ${cost} 算力`;
        }
    }

    function timelineHtml(dd, sum) {
        const scale = Math.max(sum.totalSec, dd.targetSec, 1);
        return `<div class="d-timeline">
            ${dd.shots.map((s, i) => `<button class="d-seg st-${s.status}" data-act="jump" data-index="${i}"
                style="flex-grow:${Math.max(0.4, s.seconds)}" title="${escapeHtml(`${shotLabel(s)} · ${s.seconds}s · ${shotTypeName(s.typeId)} / ${cameraName(s.cameraId)}`)}">
                <span>${pad(s.no)}</span></button>`).join('')}
            <span class="d-target" style="left:${(dd.targetSec / scale) * 100}%" title="目标 ${dd.targetSec}s"></span>
            <span class="d-covermark" style="left:${Math.min(100, (3 / scale) * 100)}%" title="封面抽帧：成片第 3 秒"></span>
        </div>
        <div class="row between small muted" style="margin-top:4px">
            <span>0s</span><span>刻度 ${scale}s · 合计 ${sum.totalSec}s</span><span>封面 = 第 3 秒</span>
        </div>`;
    }

    function issueHtml(issue) {
        const tone = issue.level === 'error' ? 'bad' : issue.level === 'warn' ? 'warn' : '';
        const label = issue.level === 'error' ? '阻断' : issue.level === 'warn' ? '建议' : '提示';
        return `<div class="d-issue ${tone}" ${issue.shotId ? `data-act="jump-shot" data-id="${issue.shotId}"` : ''}>
            ${icon(issue.level === 'info' ? 'info' : 'alert', 13)}
            <span>${escapeHtml(issue.msg)}</span>
            ${issue.code === 'duration' ? `<button class="btn btn-sm btn-ghost" data-act="fit">一键配平</button>` : ''}
            <span class="spacer"></span><em>${label}</em>
        </div>`;
    }

    /* ---------------- 第三步 · 片段生成 ---------------- */
    function drawGenerate() {
        const d = state.drama;
        const sum = summaryOf(d.shots, { model: d.model, targetSec: d.targetSec });
        const pct = sum.count ? Math.round((sum.done / sum.count) * 100) : 0;
        const spent = d.shots.filter((s) => s.status === 'succeeded').reduce((a, s) => a + Number(s.cost || 0), 0);
        const queued = sum.running;
        panel.innerHTML = `
            <div class="d-cols">
                <div class="card live-card">
                    <div class="card-head">
                        <div>
                            <div class="card-title">逐镜头片段生成</div>
                            <div class="card-sub">${sum.count} 条独立任务，单独计费、单独重试；失败与取消全额退还算力</div>
                        </div>
                        <div class="spacer"></div>
                        <a class="btn btn-sm btn-outline" href="${url('tasks.html')}" target="self">${icon('list', 13)}任务中心</a>
                    </div>
                    <div class="card-body">
                        <div class="row between small muted"><span>${sum.done}/${sum.count} 个片段完成</span><span>${pct}%</span></div>
                        <div style="margin:6px 0 4px">${progressBar(pct, sum.failed ? 'danger' : '', queued > 0)}</div>
                        <div class="live-grid">
                            ${liveCell('排队 / 生成中', `${queued}`, queued ? '3 路并行推进' : '队列已清空')}
                            ${liveCell('已完成', `${sum.done}`, `实付 ${spent} 算力`)}
                            ${liveCell('失败 / 取消', `${sum.failed}`, sum.failed ? '已全额退还，可单独重试' : '无')}
                            ${liveCell('剩余耗时', `约 ${sum.etaMin} 分钟`, `${d.model} · ${profileFor(d.model).res}`)}
                            ${liveCell('分镜合计', `${sum.totalSec}s`, `目标 ${d.targetSec}s`)}
                            ${liveCell('合成预算', `${composeCost(sum.totalSec, sum.count)} 算力`, '下一步扣费')}
                        </div>
                        <div class="d-grid">${d.shots.map((s) => shotCell(s, d)).join('')}</div>
                        ${sum.failed ? `<div class="est-note bad mt-12">${icon('alert', 13)}<span>${sum.failed} 个镜头未生成，算力已全额退还。</span>
                            <div class="spacer"></div><button class="btn btn-sm btn-outline" data-act="retry-all">${icon('refresh', 13)}重试全部失败镜头</button></div>` : ''}
                        <div class="divider"></div>
                        <div class="row" style="gap:10px;flex-wrap:wrap">
                            ${sum.done === sum.count ? `<button class="btn btn-primary" data-act="goto" data-to="4">${icon('film', 15)}进入片段合成</button>`
                                : `<button class="btn btn-outline" data-act="goto" data-to="2" ${canEditStoryboard() ? '' : 'disabled'}>${icon('edit', 15)}返回修改分镜</button>
                                   <span class="small muted">全部片段就绪后才能合成。</span>`}
                        </div>
                    </div>
                </div>
                <aside class="d-side">
                    <div class="card">
                        <div class="card-head"><div class="card-title">最新镜头日志</div></div>
                        <div class="card-body"><div class="log-panel" id="dShotLog">${logLines(latestLogs(d))}</div></div>
                    </div>
                    <div class="card">
                        <div class="card-head"><div class="card-title">我的项目</div></div>
                        <div class="card-body col" style="gap:8px">${projectsHtml()}</div>
                    </div>
                </aside>
            </div>`;
    }

    function shotCell(s, d) {
        const st = SHOT_STATUS[s.status] || SHOT_STATUS.pending;
        const busy = ACTIVE.includes(s.status);
        return `<div class="d-cell st-${s.status}" data-id="${s.id}">
            ${s.output?.poster ? imgTag(s.output.poster, `${shotLabel(s)} 封面`, 'd-cell-thumb')
                : busy ? `<div class="d-cell-thumb d-cell-live">${progressBar(s.task?.progress || 0, '', true)}<b>${Math.round(s.task?.progress || 0)}%</b></div>`
                    : `<div class="d-cell-thumb d-cell-empty">${icon('film', 20)}<span>${s.seconds}s</span></div>`}
            <div class="d-cell-body">
                <div class="row" style="gap:6px"><b class="d-cell-no">${pad(s.no)}</b>
                    <span class="badge ${st.cls}">${st.label}</span></div>
                <div class="small ellipsis" title="${escapeHtml(s.name)}">${escapeHtml(shotTypeName(s.typeId))} · ${escapeHtml(cameraName(s.cameraId))}</div>
                <div class="small muted">${s.seconds}s · ${s.cost || videoCost(d.model, s.seconds)} 算力</div>
                <div class="row wrap mt-8" style="gap:5px">
                    ${s.status === 'succeeded' ? `<button class="btn btn-sm btn-outline" data-act="preview" data-id="${s.id}">${icon('play', 12)}预览</button>
                        <button class="btn btn-sm btn-ghost" data-act="retry-shot" data-id="${s.id}">${icon('refresh', 12)}重做</button>` : ''}
                    ${busy ? `<button class="btn btn-sm btn-ghost" data-act="cancel-shot" data-id="${s.taskId}">${icon('stop', 12)}取消</button>` : ''}
                    ${['failed', 'canceled'].includes(s.status) ? `<button class="btn btn-sm btn-outline" data-act="retry-shot" data-id="${s.id}">${icon('refresh', 12)}重试</button>` : ''}
                    ${s.status === 'pending' ? `<span class="small muted">未下单</span>` : ''}
                </div>
            </div>
        </div>`;
    }

    function latestLogs(d) {
        const rows = [];
        (d.shots || []).forEach((s) => {
            if (s.task?.msg) rows.push({ t: '', level: s.status === 'failed' ? 'err' : 'info', msg: `${shotLabel(s)}：${s.task.msg}` });
        });
        return rows.slice(-18);
    }

    /* ---------------- 第四步 · 片段合成 ---------------- */
    async function drawCompose() {
        const d = state.drama;
        const sum = summaryOf(d.shots, { model: d.model, targetSec: d.targetSec });
        const task = d.composeTask;
        const running = task && ACTIVE.includes(task.status);
        const plan = buildComposePlan(d);
        const progress = Math.round(task?.progress || 0);
        const cost = composeCost(sum.totalSec, sum.count);
        const ready = sum.count > 0 && sum.done === sum.count;
        const coverShot = d.shots.length ? shotAtSecondOf(d.shots, 3) : null;
        const shotSpend = d.shots.filter((s) => s.status === 'succeeded').reduce((a, s) => a + Number(s.cost || 0), 0);
        const totalSpend = d.parseCost + shotSpend + (d.status === 'done' ? (task?.cost || 0) : cost);
        const body = d.status === 'done' ? filmHtml(d, task, sum) : composeBodyHtml(d, task, sum, { plan, progress, running, ready, cost, coverShot, totalSpend });
        panel.innerHTML = `
            <div class="d-cols">
                <div class="card ${d.status === 'done' ? '' : 'live-card'}">
                    <div class="card-head">
                        <div>
                            <div class="card-title">${d.status === 'done' ? '成片与发布' : '片段合成'}</div>
                            <div class="card-sub">${d.status === 'done' ? `${sum.totalSec}s · ${sum.count} 个镜头拼接，封面取成片第 3 秒` : '把所有镜头片段拼接为成片，并做色彩一致性与音画对齐'}</div>
                        </div>
                        <div class="spacer"></div>
                        ${running ? `<button class="btn btn-sm btn-outline" data-act="cancel-compose">${icon('stop', 13)}取消合成</button>` : ''}
                    </div>
                    <div class="card-body">${body}</div>
                </div>
                <aside class="d-side">
                    <div class="card">
                        <div class="card-head"><div class="card-title">合成过程</div></div>
                        <div class="card-body col" style="gap:7px">
                            ${plan.map((i) => `<div class="row small" style="gap:7px;align-items:flex-start">
                                <span class="d-flow-pct mono">${i.at}%</span><span class="muted">${escapeHtml(i.msg)}</span></div>`).join('')}
                        </div>
                    </div>
                    <div class="card">
                        <div class="card-head"><div class="card-title">我的项目</div></div>
                        <div class="card-body col" style="gap:8px">${projectsHtml()}</div>
                    </div>
                </aside>
            </div>`;
    }

    /** 合成步的中间区内容：拆成独立函数避免模板字符串多层嵌套 */
    function composeBodyHtml(d, task, sum, ctx) {
        const { plan, progress, running, ready, cost, coverShot, totalSpend } = ctx;
        const tiles = `<div class="train-estimate">
            ${estTile('film', '待拼接片段', `${sum.done}/${sum.count}`, ready ? '全部就绪' : `还差 ${sum.count - sum.done} 个镜头`, !ready)}
            ${estTile('clock', '成片时长', `${sum.totalSec}s`, `目标 ${d.targetSec}s`)}
            ${estTile('credit', '合成费用', `${cost} 算力`, `转场 ${Math.max(0, sum.count - 1)} 处 + 音画对齐`, cost > state.credits)}
            ${estTile('image', '封面抽帧', coverShot ? `镜头 ${pad(coverShot.no)}` : '—', '默认取第 3 秒所在镜头')}
            ${estTile('layers', '全流程消耗', `${totalSpend} 算力`, '解析 + 片段 + 合成')}
        </div>`;
        const lacking = (!ready && !running && d.status !== 'composing') ? `<div class="est-note warn mt-12">${icon('alert', 13)}
            <span>还有 ${sum.count - sum.done} 个镜头没有可用片段。失败或取消的镜头可回第三步单独重试，费用不会重复收取。</span>
            <div class="spacer"></div><button class="btn btn-sm btn-outline" data-act="goto" data-to="3">去处理</button></div>` : '';
        const live = (running || d.status === 'composing') ? `${flowList(plan, progress)}
            <div style="margin:12px 0 6px">${progressBar(progress, '', true)}</div>
            <div class="row between small muted"><span>${task?.status === 'queued' ? '排队中' : '合成进行中'}</span><span>${progress}%</span></div>
            <div class="log-panel mt-12">${logLines(task?.logs || [])}</div>` : '';
        const idle = (!running && d.status !== 'composing') ? `<div class="row mt-12" style="gap:10px;flex-wrap:wrap">
            <button class="btn btn-primary" data-act="compose" ${ready && cost <= state.credits ? '' : 'disabled'}>${icon('film', 15)}开始合成 · ${cost} 算力</button>
            ${(task && ['failed', 'canceled'].includes(task.status)) ? `<button class="btn btn-outline" data-act="retry-compose">${icon('refresh', 15)}重新合成</button>
                <span class="small" style="color:var(--danger)">${escapeHtml(task.error || '合成已中断')}，已退还 ${task.refund || task.cost} 算力</span>` : ''}
        </div>` : '';
        return tiles + lacking + live + idle;
    }

    function filmHtml(d, task, sum) {
        const out = (task?.outputs || []).find((o) => o.type === 'video');
        const work = state.work;
        const workStatus = work?.status || 'draft';
        return `${out ? `<div class="d-film">${videoStage(out, { title: d.title, prompt: d.script, extra: 'style="width:100%;display:block;max-height:420px;background:#000;border-radius:12px"' })}</div>` : ''}
            <div class="d-film-meta">
                <div><em>成片时长</em><b>${sum.totalSec}s</b></div>
                <div><em>镜头数</em><b>${sum.count}</b></div>
                <div><em>全局影调</em><b>${toneName(d.tone)}</b></div>
                <div><em>封面</em><b>第 3 秒</b></div>
                <div><em>发布状态</em><b>${escapeHtml(workStatus === 'published' ? '已发布' : workStatus === 'pending' ? '审核中' : workStatus === 'rejected' ? '未通过' : '草稿')}</b></div>
            </div>
            <div class="divider"></div>
            <div class="label" style="margin-bottom:8px">分镜表<span class="hint-inline">${shotAtSecondLabel(d.shots)}</span></div>
            <pre class="d-toml">${escapeHtml(formatStoryboard(d))}</pre>
            <div class="row mt-12" style="gap:8px;flex-wrap:wrap">
                ${work && ['draft', 'private', 'rejected'].includes(workStatus) ? `<button class="btn btn-primary" data-act="publish">${icon('upload', 15)}提交发布</button>` : ''}
                ${d.workId ? `<a class="btn btn-outline" href="${url(`assets/video-detail.html`)}?id=${d.workId}" target="self">${icon('eye', 15)}查看成片</a>` : ''}
                <button class="btn btn-ghost" data-act="new">${icon('plus', 15)}再建一部</button>
                <span class="spacer"></span>
                <a class="btn btn-ghost" href="${url('assets/my-assets-video.html')}" target="self">${icon('video', 15)}我的短剧</a>
            </div>
            ${workStatus === 'pending' ? `<div class="est-note mt-12">${icon('clock', 13)}<span>成片已进入内容审核队列，通常 1 分钟内完成；通过后会出现在作品广场。</span></div>` : ''}
            ${workStatus === 'rejected' ? `<div class="est-note bad mt-12">${icon('alert', 13)}<span>${escapeHtml(work?.review?.note || '内容审核未通过，修改标题与描述后可重新提交')}</span></div>` : ''}`;
    }

    function shotAtSecondLabel(shots) {
        const s = shotAtSecondOf(shots, 3);
        return s ? `封面来自${shotLabel(s)}（第 3 秒落在该镜头）` : '';
    }

    function shotAtSecondOf(shots, second) {
        let acc = 0;
        for (const s of shots || []) {
            acc += Number(s.seconds) || 0;
            if (second <= acc) return s;
        }
        return (shots || [])[0] || null;
    }

    /* ---------------- 通用片段 ---------------- */
    function dramaBadge(d) {
        const st = DRAMA_STATUS[d.status] || { label: d.status, tone: '' };
        return `<span class="badge ${st.tone ? `badge-${st.tone}` : ''}"><i class="dot-mark"></i>${escapeHtml(st.label)}</span>`;
    }

    function estTile(ico, label, value, sub, bad = false) {
        return `<div class="est-tile ${bad ? 'bad' : ''}"><span class="est-ico">${icon(ico, 14)}</span>
            <div><b>${escapeHtml(String(value))}</b><span>${escapeHtml(label)}</span>${sub ? `<em>${escapeHtml(sub)}</em>` : ''}</div></div>`;
    }

    function liveCell(label, value, sub) {
        return `<div class="live-cell"><em>${escapeHtml(label)}</em><b class="mono">${escapeHtml(String(value ?? '—'))}</b><span class="small muted">${escapeHtml(sub || '')}</span></div>`;
    }

    function flowList(plan, progress) {
        const reached = planReached(plan, progress);
        return `<ol class="d-flow">${plan.map((item, i) => {
            const done = item.at <= progress;
            const active = !done && i === reached.length;
            return `<li class="${done ? 'done' : active ? 'active' : ''}">
                <span class="d-flow-dot">${done ? icon('check', 11) : ''}</span>
                <span class="d-flow-txt">${escapeHtml(item.msg)}</span>
                <em class="d-flow-pct mono">${item.at}%</em></li>`;
        }).join('')}</ol>`;
    }

    function logLines(logs = []) {
        return (logs || []).slice(-20).map((l) => `<div class="log-line ${l.level === 'ok' ? 'ok' : l.level === 'warn' ? 'warn' : l.level === 'err' || l.level === 'error' ? 'err' : ''}">
            <span class="t">${escapeHtml(l.t || '')}</span><span class="m">${escapeHtml(l.msg || '')}</span></div>`).join('') || '<div class="log-line"><span class="m">暂无日志</span></div>';
    }

    function projectsHtml() {
        if (!state.projects.length) return `<div class="small muted">还没有长剧本项目。</div>`;
        return state.projects.map((p) => {
            const st = DRAMA_STATUS[p.status] || { label: p.status, tone: '' };
            return `<div class="d-proj ${p.id === state.id ? 'on' : ''}" data-act="open" data-id="${p.id}" role="button" tabindex="0">
                ${p.cover ? imgTag(p.cover, p.title, 'd-proj-cover') : `<span class="d-proj-cover d-cell-empty">${icon('film', 16)}</span>`}
                <span class="d-proj-main">
                    <b class="ellipsis">${escapeHtml(p.title)}</b>
                    <span class="small muted">${p.shotCount} 镜头 · ${p.totalSec}/${p.targetSec}s · ${p.cost} 算力</span>
                </span>
                <span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${escapeHtml(st.label)}</span>
                <button class="icon-btn" data-act="drop" data-id="${p.id}" title="删除项目">${icon('trash', 13)}</button>
            </div>`;
        }).join('');
    }

    /* ---------------- 事件 ---------------- */
    async function withBtn(el, fn) {
        el.classList.add('loading');
        try {
            await fn();
        } catch (err) {
            toast(err.message || '操作失败', 'error');
        } finally {
            el.classList.remove('loading');
        }
    }

    async function refreshCredits() {
        const acc = await getAccount().catch(() => null);
        if (!acc) return;
        state.credits = acc.credits || 0;
        const el = host.querySelector('#dCredits');
        if (el) el.textContent = num(state.credits);
    }

    host.addEventListener('click', async (e) => {
        const stepBtn = e.target.closest('[data-step]');
        if (stepBtn && !stepBtn.disabled) return gotoStep(Number(stepBtn.dataset.step));
        const el = e.target.closest('[data-act]');
        if (!el || el.disabled) return;
        e.preventDefault();
        const act = el.dataset.act;
        const index = el.dataset.index !== undefined ? Number(el.dataset.index) : -1;
        const shotId = el.dataset.id;
        if (act === 'sample') {
            panel.querySelector('#nScript').value = SAMPLE_SCRIPT;
            return refreshNewEstimate();
        }
        if (act === 'clear-script') {
            panel.querySelector('#nScript').value = '';
            return refreshNewEstimate();
        }
        if (act === 'ref') {
            const { kind, id, prefix } = el.dataset;
            const bag = prefix === 'n' ? state.newRefs : state.newRefs;
            const list = bag[kind] || (bag[kind] = []);
            const at = list.indexOf(id);
            if (at >= 0) list.splice(at, 1);
            else list.push(id);
            el.classList.toggle('on', at < 0);
            return el.classList.toggle('active', at < 0);
        }
        if (act === 'parse') {
            const v = newInput();
            return withBtn(el, async () => {
                const res = await startDrama(v);
                state.id = res.drama.id;
                state.pinned = false;
                state.step = 1;
                window.history.replaceState({}, '', `${window.location.pathname}?drama=${res.drama.id}&long=1`);
                await openProject(res.drama.id);
                toast(`解析任务已创建，消耗 ${res.task.cost} 算力`, 'success');
            });
        }
        if (act === 'open') return openProject(shotId);
        if (act === 'drop') {
            return withBtn(el, async () => {
                const target = state.projects.find((p) => p.id === shotId);
                const ok = await confirmDialog({
                    title: '删除项目',
                    message: `「${target?.title || shotId}」的分镜与项目记录会被删除，已下单的任务与流水保留可审计。确定删除？`,
                    confirmText: '删除项目',
                    danger: true
                });
                if (!ok) return;
                await deleteDrama(shotId);
                state.projects = (await listDramas()).dramas;
                if (state.id === shotId) return resetToNew();
                draw();
            });
        }
        if (act === 'new') return resetToNew();
        if (act === 'goto') return gotoStep(Number(el.dataset.to || 1));
        if (act === 'cancel-parse') {
            return withBtn(el, async () => {
                await cancelTask(state.drama.parseTaskId);
                stopPolling();
                await reload();
                await refreshCredits();
                toast('解析已取消，算力已退还', 'success');
            });
        }
        if (act === 'reparse') {
            return withBtn(el, async () => {
                const script = panel.querySelector('[data-field="script"]')?.value;
                const res = await reparseDrama(state.id, { script, tone: state.drama.tone });
                state.pinned = false;
                state.step = 1;
                await reload({ follow: false });
                await refreshCredits();
                toast(`重新解析已下单，消耗 ${res.task.cost} 算力`, 'success');
            });
        }
        if (act === 'jump' || act === 'jump-shot') {
            const i = act === 'jump' ? index : (state.drama.shots || []).findIndex((s) => s.id === shotId);
            const card = panel.querySelector(`#dShots [data-index="${i === -1 ? '' : i}"]`)?.closest('.d-shot') || panel.querySelector('.d-shot');
            if (!card) return;
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('flash');
            setTimeout(() => card.classList.remove('flash'), 1200);
            return;
        }
        if (act === 'auto-target') {
            // 沿用领域层的推算入口径，与新建面板、创建页、引擎拆镜头用的是同一个函数
            const sug = suggestDuration(state.drama.script, state.drama.model, { minSec: LONG_FORM_MIN + 1 });
            if (!sug.seconds) return toast('剧本太短，暂时推算不出时长，请再写几句', 'warn');
            state.edit.targetSec = sug.seconds;
            panel.querySelector('#rTarget').value = sug.seconds;
            autoFit(state.draft, sug.seconds, state.drama.model);
            state.dirty = true;
            redrawShots();
            refreshLive();
            return toast(`已按 ${sug.beats} 个节拍推算为 ${sug.seconds} 秒，镜头时长一并配平`, 'success');
        }
        if (act === 'fit') {
            autoFit(state.draft, state.edit.targetSec, state.drama.model);
            state.dirty = true;
            return redrawShots();
        }
        if (act === 'add-shot' || act === 'insert') {
            const at = act === 'add-shot' ? state.draft.length - 1 : index;
            if (state.draft.length >= MAX_SHOTS) return toast(`单项目上限 ${MAX_SHOTS} 个镜头`, 'warn');
            state.draft = insertShotAfter(state.draft, Math.max(0, at), { model: state.drama.model, tone: state.edit.tone, ratio: state.drama.ratio });
            state.dirty = true;
            redrawShots();
            const card = panel.querySelectorAll('.d-shot')[Math.max(0, at) + 1];
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        if (act === 'remove') {
            const shot = state.draft[index];
            const ok = await confirmDialog({
                title: '删除镜头',
                message: `删除「${shotLabel(shot)}」后其余镜头会自动重新编号${shot.status === 'succeeded' ? '，已生成的片段一并从成片移除（费用不退还）' : ''}。确定删除？`,
                confirmText: '删除',
                danger: true
            });
            if (!ok) return;
            state.draft = removeShot(state.draft, index);
            state.dirty = true;
            return redrawShots();
        }
        if (act === 'reprompt') {
            const s = state.draft[index];
            s.prompt = buildShotPrompt({
                beat: s.beat, index, typeId: s.typeId, cameraId: s.cameraId,
                toneId: state.edit.tone, refTitles: refTitlesOf(s), model: state.drama.model, ratio: state.drama.ratio
            });
            state.dirty = true;
            const ta = panel.querySelectorAll('.d-prompt')[index];
            if (ta) ta.value = s.prompt;
            return refreshLive();
        }
        if (act === 'shot-ref') {
            const s = state.draft[index];
            const { kind, id } = el.dataset;
            const refs = s.refs || (s.refs = { character: [], prop: [], scenic: [] });
            const list = refs[kind] || (refs[kind] = []);
            const at = list.indexOf(id);
            if (at >= 0) list.splice(at, 1);
            else list.push(id);
            state.dirty = true;
            el.classList.toggle('on', at < 0);
            return refreshLive();
        }
        if (act === 'copy-sb') return copyText(formatStoryboard(draftDrama()), '分镜表已复制');
        if (act === 'save') return withBtn(el, saveDraft);
        if (act === 'confirm') {
            return withBtn(el, async () => {
                await saveDraft({ silent: true });
                const res = await confirmShots(state.id);
                await refreshCredits();
                state.pinned = false;
                state.step = 3;
                await reload({ follow: false });
                toast(`${res.tasks.length} 个镜头已下单，共 ${res.total} 算力`, 'success');
            });
        }
        if (act === 'retry-shot') {
            return withBtn(el, async () => {
                const shot = (state.draft || state.drama.shots || []).find((s) => s.id === shotId);
                if (shot?.status === 'succeeded') {
                    const ok = await confirmDialog({
                        title: '重做已生成的镜头',
                        message: `将按当前提示词重新下单${shotLabel(shot)}，旧片段会被替换，重新收取 ${videoCost(state.drama.model, shot.seconds)} 算力。`,
                        confirmText: '重新下单'
                    });
                    if (!ok) return;
                }
                await retryShot(state.id, shotId);
                await refreshCredits();
                state.pinned = false;
                if (state.step === 2) state.step = 3;
                await reload({ follow: false });
                toast('镜头已重新下单', 'success');
            });
        }
        if (act === 'retry-all') {
            return withBtn(el, async () => {
                const bad = (state.drama.shots || []).filter((s) => ['failed', 'canceled'].includes(s.status));
                for (let i = 0; i < bad.length; i += 1) await retryShot(state.id, bad[i].id);
                await refreshCredits();
                await reload({ follow: false });
                toast(`${bad.length} 个镜头已重新下单`, 'success');
            });
        }
        if (act === 'cancel-shot') {
            return withBtn(el, async () => {
                await cancelTask(shotId);
                await refreshCredits();
                await reload({ follow: false });
                toast('镜头已取消，算力已退还', 'success');
            });
        }
        if (act === 'preview') {
            const s = (state.drama.shots || []).find((x) => x.id === shotId);
            if (!s?.output?.url) return toast('该镜头还没有可用片段', 'warn');
            openModal({
                title: shotLabel(s),
                size: 'lg',
                body: `${videoStage(s.output, { title: s.name, prompt: s.prompt, extra: 'style="width:100%;display:block;background:#000"' })}
                    <div class="small muted mt-8">${s.seconds}s · ${shotTypeName(s.typeId)} / ${cameraName(s.cameraId)} · ${escapeHtml(s.beat || '')}</div>
                    <pre class="d-toml mt-8">${escapeHtml(s.prompt)}</pre>`,
                footer: `<button class="btn btn-outline" data-close="1">关闭</button>`
            });
            return;
        }
        if (act === 'compose') {
            return withBtn(el, async () => {
                const res = await composeDrama(state.id);
                await refreshCredits();
                state.pinned = false;
                await reload({ follow: false });
                toast(`合成已下单，消耗 ${res.task.cost} 算力`, 'success');
            });
        }
        if (act === 'retry-compose') {
            return withBtn(el, async () => {
                await retryTask(state.drama.composeTaskId);
                await refreshCredits();
                await reload({ follow: false });
                toast('合成任务已重新下单', 'success');
            });
        }
        if (act === 'cancel-compose') {
            return withBtn(el, async () => {
                await cancelTask(state.drama.composeTaskId);
                await refreshCredits();
                await reload({ follow: false });
                toast('合成已取消，算力已退还', 'success');
            });
        }
        if (act === 'publish') {
            return withBtn(el, async () => {
                const res = await submitWork(state.drama.workId);
                state.work = res.work;
                await reload({ follow: false });
                toast('成片已提交审核，通常 1 分钟内完成', 'success');
            });
        }
    });

    function refTitlesOf(s) {
        const out = [];
        ['character', 'prop', 'scenic'].forEach((k) => {
            (s.refs?.[k] || []).forEach((id) => {
                const a = state.pool[k].find((x) => x.id === id);
                if (a) out.push(a.title);
            });
        });
        return out;
    }

    function onField(el) {
        const field = el.dataset.field;
        if (!state.drama) {
            if (['script', 'duration', 'model', 'tone'].includes(field)) refreshNewEstimate();
            return;
        }
        if (state.step === 1) {
            if (field === 'script') panel.querySelector('#dScriptCount').textContent = `${el.value.length} 字`;
            return;
        }
        if (state.step !== 2) return;
        if (el.dataset.index === undefined) {
            if (field === 'tone') state.edit.tone = el.value;
            if (field === 'targetSec') state.edit.targetSec = Math.max(LONG_FORM_MIN + 1, Math.min(180, Number(el.value) || state.edit.targetSec));
            state.dirty = true;
            return refreshLive();
        }
        const i = Number(el.dataset.index);
        const shot = state.draft[i];
        if (!shot) return;
        if (field === 'seconds') {
            const p = profileFor(state.drama.model);
            shot.seconds = Math.max(SHOT_MIN_SEC, Math.min(30, Math.round(Number(el.value) || p.maxShot)));
            shot.cost = videoCost(state.drama.model, shot.seconds);
        } else if (field === 'name') shot.name = el.value;
        else if (field === 'prompt') shot.prompt = el.value;
        else if (field === 'negative') shot.negative = el.value;
        else if (field === 'typeId') shot.typeId = el.value;
        else if (field === 'cameraId') shot.cameraId = el.value;
        state.dirty = true;
        if (field === 'name') shot.name = el.value;
        refreshLive();
    }

    host.addEventListener('input', (e) => {
        const el = e.target.closest('[data-field]');
        if (el) onField(el);
    });
    host.addEventListener('change', (e) => {
        const el = e.target.closest('[data-field]');
        if (el && (el.tagName === 'SELECT' || el.type === 'number')) onField(el);
    });

    function redrawShots() {
        const dd = draftDrama();
        const box = panel.querySelector('#dShots');
        if (box) box.innerHTML = dd.shots.map((s, i) => shotCard(s, i, !canEditStoryboard(), dd)).join('');
        refreshLive();
    }

    async function saveDraft({ silent = false } = {}) {
        const dd = draftDrama();
        const res = await saveDrama(state.id, {
            shots: dd.shots, tone: dd.tone, targetSec: dd.targetSec, negative: dd.negative
        });
        state.drama = res;
        state.draft = (res.shots || []).map((s) => JSON.parse(JSON.stringify(s)));
        state.edit = { tone: res.tone, targetSec: res.targetSec };
        state.dirty = false;
        state.projects = (await listDramas()).dramas;
        refreshLive();
        const note = panel.querySelector('#dBarNote');
        if (note && !note.querySelector('span')) note.innerHTML = `<span class="muted">分镜已保存：${res.shots.length} 个镜头 / ${summaryOf(res.shots, { model: res.model, targetSec: res.targetSec }).totalSec}s</span>`;
        if (!silent) toast('分镜修改已保存', 'success', 1400);
    }

    async function openProject(id) {
        stopPolling();
        state.id = id;
        state.pinned = false;
        state.work = null;
        const res = await getDrama(id);
        state.drama = res.drama;
        fetchFilmWork(state.drama.workId);
        syncFromDrama();
        host.querySelector('#dStatus').innerHTML = dramaBadge(state.drama);
        host.querySelector('.page-title').childNodes[0].nodeValue = `${state.drama.title} `;
        draw();
    }

    function resetToNew() {
        stopPolling();
        state.id = '';
        state.drama = null;
        state.draft = null;
        state.step = 1;
        state.pinned = false;
        state.dirty = false;
        state.work = null;
        window.history.replaceState({}, '', `${window.location.pathname}?long=1`);
        host.querySelector('#dStatus').innerHTML = '';
        host.querySelector('.page-title').childNodes[0].nodeValue = '短剧分镜工作台 ';
        draw();
    }

    /* ---------------- 拖拽排序 ---------------- */
    host.addEventListener('dragstart', (e) => {
        const handle = e.target.closest('[data-drag]');
        if (!handle || handle.getAttribute('draggable') === 'false') {
            if (e.target.closest('.d-shot')) e.preventDefault();
            return;
        }
        state.dragFrom = Number(handle.dataset.drag);
        const card = handle.closest('.d-shot');
        if (card) card.classList.add('dragging');
        try {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(state.dragFrom));
        } catch (err) { /* 部分浏览器在 dragstart 限制写入 */ }
    });

    host.addEventListener('dragover', (e) => {
        if (state.dragFrom === null) return;
        const card = e.target.closest('.d-shot');
        if (!card) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        card.classList.add('drop-over');
    });

    host.addEventListener('dragleave', (e) => {
        const card = e.target.closest('.d-shot');
        if (card) card.classList.remove('drop-over');
    });

    host.addEventListener('drop', (e) => {
        const card = e.target.closest('.d-shot');
        if (!card || state.dragFrom === null) return;
        e.preventDefault();
        const to = Number(card.dataset.index);
        const from = state.dragFrom;
        state.dragFrom = null;
        host.querySelectorAll('.d-shot').forEach((x) => x.classList.remove('dragging', 'drop-over'));
        if (from === to) return;
        state.draft = moveShot(state.draft, from, to);
        state.dirty = true;
        redrawShots();
    });

    host.addEventListener('dragend', () => {
        state.dragFrom = null;
        host.querySelectorAll('.d-shot').forEach((x) => x.classList.remove('dragging', 'drop-over'));
    });

    /* ---------------- 实时推进 ---------------- */
    on(EVENTS.taskUpdate, ({ task }) => {
        if (!state.id || task.payload?.dramaId !== state.id) return;
        if (state.step === 2 && state.dirty) return;
        reload();
    });
    on(EVENTS.credits, ({ credits }) => {
        state.credits = credits || 0;
        const el = host.querySelector('#dCredits');
        if (el) el.textContent = num(state.credits);
    });

    if (state.drama) fetchFilmWork(state.drama.workId);
    draw();
}
