import { listTrainings, getTraining, createTraining, restartTraining, cancelTask, createModelAsset, getAccount } from '../core/api.js';
import { statusMeta } from '../core/constants.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast, progressBar, emptyState, copyText, openModal, closeModal, imgTag, confirmDialog } from '../core/ui.js';
import { escapeHtml, num, timeAgo } from '../core/format.js';
import { on, EVENTS } from '../core/bus.js';
import { KEYS } from '../core/storage.js';
import {
    BASE_PROFILES, MODE_PRESETS, OPTIMIZERS, SCHEDULERS, RANKS, LRS, BATCHES, RESOLUTIONS,
    GRAD_ACCUMS, CLIP_SKIPS, PLAN_STAGES, pickConfig, suggestEpochs, buildTrainPlan,
    lossAt, lrAt, lrLabel, configWarnings, predictFault, retrySuggestions, trainToml
} from '../core/training.js';

const BASES = Object.keys(BASE_PROFILES);
const PRECISIONS = ['bf16', 'fp16', 'fp32'];
const POLL_MS = 1500;

export async function render(host, ctx) {
    setPageTitle('模型训练');
    const [{ trainings, datasets }, account] = await Promise.all([listTrainings(), getAccount()]);

    const initialMode = 'standard';
    const preset = MODE_PRESETS[initialMode];
    const state = {
        datasetId: datasets[0]?.id || '',
        mode: initialMode,
        alphaAuto: true,
        epochs: suggestEpochs({ mode: initialMode, batch: preset.batch, gradAccum: preset.gradAccum }, datasets[0] || {}),
        liveId: null,
        polling: null,
        unsubscribe: null,
        credits: account.credits
    };

    const officialCount = datasets.filter((d) => d.isOfficial).length;
    const running = trainings.filter((t) => ['queued', 'running'].includes(t.status));
    const doneCount = trainings.filter((t) => t.status === 'succeeded').length;
    const avgMin = avgDuration(trainings);

    host.innerHTML = `
        <div class="page-head">
            <div class="page-head-main">
                <h1 class="page-title">LoRA 模型训练</h1>
                <div class="page-sub">用自有数据集训练风格 / 角色模型，训练过程可观察 loss、样张与 checkpoint，完成后自动生成可调用的模型资产</div>
            </div>
            <div class="page-actions">
                <span class="balance-chip">${icon('credit', 14)} <b id="balanceText">${num(state.credits)}</b></span>
                <a class="btn btn-outline" href="${url('assets/my-assets-model.html')}">${icon('cpu', 15)}我的模型</a>
            </div>
        </div>

        <div class="grid cols-4" style="margin-bottom:16px">
            ${statCard('ds', '数据集', datasets.length, `官方 ${officialCount} · 我的 ${datasets.length - officialCount}`, 'database')}
            ${statCard('jobs', '训练任务', trainings.length, `${doneCount} 个已完成 · ${running.length} 个运行中`, 'cpu')}
            ${statCard('time', '平均耗时', avgMin, '历史训练实际用时', 'clock')}
            ${statCard('budget', '本次预算', '<span id="statBudget">—</span>', '随参数实时预估，中断按进度结算', 'credit', true)}
        </div>

        <div class="train-wrap">
            <div class="col" style="gap:16px">
                <div class="card">
                    <div class="card-head">
                        <div>
                            <div class="card-title">新建训练任务</div>
                            <div class="card-sub">选择数据集与训练模式，再按需要微调参数</div>
                        </div>
                        <div class="spacer"></div>
                        <div class="chips" id="modeTabs">
                            ${Object.entries(MODE_PRESETS).map(([id, p]) => `<button class="chip ${id === state.mode ? 'active' : ''}" data-mode="${id}" title="${escapeHtml(p.hint)}">${p.name}</button>`).join('')}
                        </div>
                    </div>
                    <div class="card-body">
                        <div class="label" style="margin-bottom:8px">训练数据集 <span class="req">*</span>
                            <span class="hint-inline">官方数据集可直接试用，我的数据集在资产库上传素材后生成</span></div>
                        <div class="dataset-grid" id="datasetGrid">
                            ${datasets.length ? datasets.map((d) => `<button class="dataset-card ${state.datasetId === d.id ? 'active' : ''}" data-dataset="${d.id}">
                                <div class="dataset-thumbs">
                                    ${d.thumbs.slice(0, 4).map((t, i) => imgTag(t, `${d.name || '样本'} ${i + 1}`)).join('')}
                                    <span class="dataset-tag ${d.isOfficial ? 'official' : ''}">${d.isOfficial ? '官方' : '我的'}</span>
                                </div>
                                <b>${escapeHtml(d.name)}</b>
                                <span>${d.count} 张 · 已打标 ${d.tagged} · ${escapeHtml(d.resolution)}</span>
                            </button>`).join('') : `<div class="small muted" style="padding:14px">暂无可用数据集，先上传一批素材吧。</div>`}
                        </div>

                        <div class="form-grid" style="margin-top:18px">
                            <div class="field">
                                <label class="label" for="tName">模型名称 <span class="req">*</span></label>
                                <input class="input" id="tName" maxlength="24" placeholder="例如：林澈人像 · 柔光">
                            </div>
                            <div class="field">
                                <label class="label" for="tTrigger">触发词 <span class="req">*</span>
                                    <span class="hint-inline">字母 / 数字 / 下划线</span></label>
                                <input class="input mono" id="tTrigger" maxlength="16" placeholder="lch_soft">
                            </div>
                            <div class="field">
                                <label class="label" for="tBase">底模</label>
                                <select class="select" id="tBase">${BASES.map((b) => `<option>${b}</option>`).join('')}</select>
                            </div>
                            <div class="field">
                                <label class="label" for="tEpochs">训练轮数 Epoch
                                    <span class="hint-inline" id="epochHint"></span></label>
                                <input class="input" type="number" id="tEpochs" min="1" max="120" step="1" value="${state.epochs}">
                            </div>
                            <div class="field">
                                <label class="label" for="tRank">网络维度 Rank</label>
                                <select class="select" id="tRank">${RANKS.map((r) => `<option value="${r}" ${r === preset.rank ? 'selected' : ''}>${r}</option>`).join('')}</select>
                            </div>
                            <div class="field">
                                <div class="label">Alpha
                                    <span class="hint-inline"><label class="row small" style="gap:5px;cursor:pointer" id="swAlpha"><span class="switch on" id="alphaAuto" style="width:32px;height:18px"></span>自动 ½·Rank</label></span></div>
                                <input class="input" type="number" id="tAlpha" min="1" max="128" step="1" value="${Math.round(preset.rank / 2)}" ${state.alphaAuto ? 'disabled' : ''}>
                            </div>
                            <div class="field">
                                <label class="label" for="tLr">学习率</label>
                                <select class="select" id="tLr">${LRS.map((v) => `<option value="${v}" ${v === preset.lr ? 'selected' : ''}>${lrLabel(v)}</option>`).join('')}</select>
                            </div>
                            <div class="field">
                                <label class="label" for="tBatch">批次大小 Batch</label>
                                <select class="select" id="tBatch">${BATCHES.map((v) => `<option value="${v}" ${v === preset.batch ? 'selected' : ''}>${v}</option>`).join('')}</select>
                            </div>
                            <div class="field">
                                <label class="label" for="tRes">训练分辨率</label>
                                <select class="select" id="tRes">${RESOLUTIONS.map((v) => `<option value="${v}" ${v === preset.resolution ? 'selected' : ''}>${v} px</option>`).join('')}</select>
                            </div>
                            <div class="field">
                                <label class="label" for="tAccum">梯度累积
                                    <span class="hint-inline">等效 batch × 累积</span></label>
                                <select class="select" id="tAccum">${GRAD_ACCUMS.map((v) => `<option value="${v}" ${v === preset.gradAccum ? 'selected' : ''}>${v}</option>`).join('')}</select>
                            </div>
                        </div>

                        <details class="adv" id="advBox">
                            <summary>${icon('sliders', 15)} 高级参数<span class="small muted" id="advBadge"></span></summary>
                            <div class="form-grid" style="margin-top:14px">
                                <div class="field">
                                    <label class="label" for="tOpt">优化器</label>
                                    <select class="select" id="tOpt">${OPTIMIZERS.map((o) => `<option value="${o.id}">${o.id} · ${o.note}</option>`).join('')}</select>
                                </div>
                                <div class="field">
                                    <label class="label" for="tSch">学习率调度</label>
                                    <select class="select" id="tSch">${SCHEDULERS.map((s) => `<option value="${s.id}">${s.id} · ${s.note}</option>`).join('')}</select>
                                </div>
                                <div class="field">
                                    <label class="label" for="tDrop">Dropout</label>
                                    <select class="select" id="tDrop">${[0, 0.05, 0.1, 0.15, 0.2, 0.3].map((v) => `<option value="${v}" ${v === 0.1 ? 'selected' : ''}>${v}</option>`).join('')}</select>
                                </div>
                                <div class="field">
                                    <label class="label" for="tPrec">混合精度</label>
                                    <select class="select" id="tPrec">${PRECISIONS.map((v) => `<option ${v === 'bf16' ? 'selected' : ''}>${v}</option>`).join('')}</select>
                                </div>
                                <div class="field">
                                    <label class="label" for="tClip">CLIP Skip</label>
                                    <select class="select" id="tClip">${CLIP_SKIPS.map((v) => `<option value="${v}" ${v === 2 ? 'selected' : ''}>${v}</option>`).join('')}</select>
                                </div>
                                <div class="field">
                                    <label class="label" for="tSave">每 N 个 epoch 存 checkpoint</label>
                                    <input class="input" type="number" id="tSave" min="1" max="60" step="1" value="3">
                                </div>
                                <div class="field span-2">
                                    <label class="label" for="tSeed">随机种子 <span class="hint-inline">-1 表示每次随机</span></label>
                                    <input class="input mono" type="number" id="tSeed" min="-1" max="2147483647" step="1" value="-1">
                                </div>
                                <div class="field span-2 row" style="gap:22px;flex-wrap:wrap">
                                    <label class="row small" style="gap:6px;cursor:pointer" id="swNoise"><span class="switch on" id="tNoise"></span> Noise Offset（改善暗部层次）</label>
                                    <label class="row small" style="gap:6px;cursor:pointer" id="swTextEnc"><span class="switch" id="tTextEnc"></span> 训练文本编码器（更吃显存）</label>
                                </div>
                            </div>
                        </details>

                        <div class="train-estimate" id="estimate"></div>
                        <div class="col small" style="gap:6px;margin-top:10px" id="estNotes"></div>

                        <div class="divider"></div>
                        <div class="label" style="margin-bottom:8px">训练流程<span class="hint-inline">引擎按此计划逐步推进，页面与日志同源</span></div>
                        <div class="plan-track" id="planPreview"></div>

                        <div class="row between wrap" style="margin-top:16px;gap:12px">
                            <div class="row small muted" style="gap:14px;flex-wrap:wrap">
                                <span>${icon('info', 13)} <span id="modeHint">${escapeHtml(preset.hint)}</span></span>
                            </div>
                            <div class="row" style="gap:12px">
                                <label class="row small" style="gap:6px;cursor:pointer" id="swPublish">
                                    <span class="switch" id="autoPublish"></span> 完成后自动发布
                                </label>
                                <button class="btn btn-outline" id="fillExample">${icon('wand', 15)}填充示例配置</button>
                                <button class="btn btn-primary" id="startTrain">${icon('rocket', 15)}开始训练</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="trainProgress" class="hidden"></div>
            </div>

            <div class="col" style="gap:14px">
                <div class="card">
                    <div class="card-head">
                        <div class="card-title">训练任务</div>
                        <div class="spacer"></div>
                        <span class="badge" id="jobCount">${trainings.length}</span>
                    </div>
                    <div class="card-body col" style="gap:10px" id="jobList">
                        ${trainings.length ? trainings.map(jobCard).join('') : emptyState({ title: '还没有训练任务', desc: '选择数据集并配置参数后开始第一次训练。' })}
                    </div>
                </div>
                <div class="card">
                    <div class="card-head"><div class="card-title">训练小贴士</div></div>
                    <div class="card-body small" style="color:var(--text-2);line-height:1.9">
                        <div class="row" style="gap:8px;align-items:flex-start">${icon('check', 14)}<span>样本 20-50 张、分辨率统一，效果最稳定。</span></div>
                        <div class="row" style="gap:8px;align-items:flex-start">${icon('check', 14)}<span>Alpha 常用 Rank 的一半：想要特征强就升 Rank，别只抬 Alpha。</span></div>
                        <div class="row" style="gap:8px;align-items:flex-start">${icon('check', 14)}<span>显存不够时优先加「梯度累积」而不是降 Rank，收敛更稳。</span></div>
                        <div class="row" style="gap:8px;align-items:flex-start">${icon('check', 14)}<span>触发词用罕见短词，避免与底模已有概念冲突。</span></div>
                        <div class="row" style="gap:8px;align-items:flex-start">${icon('alert', 14)}<span>训练失败会自动退还算力；中断可按已完成进度结算。</span></div>
                        <div class="row" style="gap:8px;align-items:flex-start">${icon('alert', 14)}<span>演示环境会压缩训练时长，进度、日志与 loss 口径与真实训练一致。</span></div>
                    </div>
                </div>
            </div>
        </div>`;

    const jobList = host.querySelector('#jobList');
    const progressBox = host.querySelector('#trainProgress');
    const balanceText = host.querySelector('#balanceText');
    const estimateBox = host.querySelector('#estimate');
    const estNotes = host.querySelector('#estNotes');
    const planPreview = host.querySelector('#planPreview');

    const $ = (sel) => host.querySelector(sel);
    const val = (sel, fallback = '') => {
        const el = $(sel);
        return el ? el.value : fallback;
    };

    /**
     * 重拉列表后刷新：卡片 + 计数徽标 + 顶部指标。
     * patch = true 时仅在有状态发生变化的那一行做局部替换，
     * 进度微调只补进度条与最新日志，避免整列重绘打断 hover / 滚动 / 进度条动画。
     */
    function applyList(list, patch = false) {
        const before = trainings.map((t) => `${t.id}:${t.status}`).join(',');
        trainings.length = 0;
        list.forEach((t) => trainings.push(t));
        const after = trainings.map((t) => `${t.id}:${t.status}`).join(',');
        if (patch && before === after && jobList.children.length === trainings.length) {
            patchJobs();
            paintStats();
            return;
        }
        jobList.innerHTML = trainings.length
            ? trainings.map(jobCard).join('')
            : emptyState({ title: '还没有训练任务', desc: '选择数据集并配置参数后开始第一次训练。' });
        paintStats();
    }

    /** 进行中的卡片只补进度与日志两处 */
    function patchJobs() {
        trainings.forEach((t) => {
            if (!['queued', 'running'].includes(t.status)) return;
            const card = jobList.querySelector(`[data-job="${t.id}"]`);
            if (!card) return;
            const bar = card.querySelector('.progress i');
            if (bar) bar.style.width = `${Math.max(0, Math.min(100, Math.round(t.task?.progress || 0)))}%`;
            const line = card.querySelector('.job-log');
            const msg = t.task?.logs?.slice(-1)[0]?.msg || '等待调度';
            if (line && line.textContent !== msg) line.textContent = msg;
        });
    }

    function paintStats() {
        const done = trainings.filter((t) => t.status === 'succeeded').length;
        const live = trainings.filter((t) => ['queued', 'running'].includes(t.status)).length;
        const setText = (sel, text) => {
            const el = $(sel);
            if (el) el.textContent = text;
        };
        setText('#jobCount', String(trainings.length));
        setText('#stat-jobs-v', num(trainings.length));
        setText('#stat-jobs-t', `${done} 个已完成 · ${live} 个运行中`);
        setText('#stat-time-v', avgDuration(trainings));
    }

    function currentInput() {
        return {
            mode: state.mode,
            base: val('#tBase'),
            rank: Number(val('#tRank')),
            alphaAuto: state.alphaAuto,
            alpha: Number(val('#tAlpha')),
            lr: Number(val('#tLr')),
            batch: Number(val('#tBatch')),
            gradAccum: Number(val('#tAccum')),
            resolution: val('#tRes'),
            epochs: Number(val('#tEpochs')),
            optimizer: val('#tOpt'),
            scheduler: val('#tSch'),
            dropout: Number(val('#tDrop')),
            precision: val('#tPrec'),
            clipSkip: Number(val('#tClip')),
            savePerEpoch: Number(val('#tSave')),
            seed: Number(val('#tSeed')),
            noiseOffset: $('#tNoise')?.classList.contains('on'),
            trainTextEncoder: $('#tTextEnc')?.classList.contains('on')
        };
    }

    /** 本地即时预估：与后端 checkTraining 走同一套领域函数，口径必然一致 */
    function computeEstimate() {
        const dataset = datasets.find((d) => d.id === state.datasetId) || { count: 0, tagged: 0 };
        const input = currentInput();
        let cfg;
        try {
            cfg = pickConfig(input, dataset);
        } catch (err) {
            return null;
        }
        return {
            dataset,
            cfg,
            plan: buildTrainPlan(cfg, dataset, val('#tTrigger') || 'lora'),
            warnings: configWarnings(cfg, dataset),
            fault: predictFault(cfg),
            vramOver: cfg.vramGb > cfg.vramLimitGb
        };
    }

    function paintEstimate() {
        const est = computeEstimate();
        if (!est) return;
        const { cfg, dataset, plan, warnings, fault, vramOver } = est;
        const ckptCount = plan.filter((p) => p.kind === 'ckpt').length;
        const sampleCount = plan.filter((p) => p.kind === 'sample' || p.kind === 'finalSample').length;
        estimateBox.innerHTML = `
            ${estTile('总步数', num(cfg.steps), `${num(cfg.stepsPerEpoch)} 步 / epoch · ${cfg.repeat}×repeat`, 'zap')}
            ${estTile('预计算力', num(cfg.estimateCost), cfg.estimateCost > state.credits ? `余额 ${num(state.credits)}，不足` : `余额 ${num(state.credits)}`, 'credit', cfg.estimateCost > state.credits ? 'bad' : '')}
            ${estTile('预计耗时', `${cfg.estimateMin} 分钟`, `吞吐 ${cfg.samplesPerSec} samples/s`, 'clock')}
            ${estTile('显存估算', `${cfg.vramGb} GB`, `节点上限 ${cfg.vramLimitGb} GB`, 'cpu', vramOver ? 'bad' : '')}
            ${estTile('产出', `${ckptCount} ckpt`, `权重 ${cfg.weightMb} MB · 样张 ${sampleCount} 张`, 'box')}`;

        const notes = [];
        if (vramOver) notes.push(`<div class="est-note bad">${icon('alert', 14)}<span>显存估算 ${cfg.vramGb} GB 超出节点上限 ${cfg.vramLimitGb} GB：请降低 Batch / 分辨率 / Rank，或增大梯度累积。</span></div>`);
        if (cfg.estimateCost > state.credits) notes.push(`<div class="est-note bad">${icon('alert', 14)}<span>算力不足，还差 ${num(cfg.estimateCost - state.credits)} 积分，<a href="${url('wallet.html')}">去充值</a>。</span></div>`);
        if (fault) notes.push(`<div class="est-note bad">${icon('alert', 14)}<span>该组合会导致训练中断：${escapeHtml(fault.reason)}。</span></div>`);
        warnings.forEach((w) => notes.push(`<div class="est-note warn">${icon('info', 14)}<span>${escapeHtml(w)}</span></div>`));
        if (dataset.count && dataset.tagged < dataset.count) notes.push(`<div class="est-note">${icon('info', 14)}<span>数据集有 ${dataset.count - dataset.tagged} 张未打标，提交训练时会自动跳过。</span></div>`);
        estNotes.innerHTML = notes.join('');
        const budgetEl = $('#statBudget');
        if (budgetEl) budgetEl.textContent = num(cfg.estimateCost);

        $('#epochHint').textContent = `推荐 ${suggestEpochs({ mode: state.mode, batch: cfg.batch, gradAccum: cfg.gradAccum }, dataset)} 轮`;
        $('#advBadge').textContent = $('#advBox')?.open ? '' : ' · 已按预设配置';
        $('#modeHint').textContent = MODE_PRESETS[state.mode].hint;
        planPreview.innerHTML = plan.slice(0, 6).map((p) => `<span class="plan-pill">${escapeHtml(p.label)}</span>`).join('') + `<span class="plan-pill more">+${Math.max(0, plan.length - 6)} 步</span>`;
    }

    function estTile(label, value, sub, iconName, tone = '') {
        return `<div class="est-tile ${tone}">
            <span class="est-ico">${icon(iconName, 14)}</span>
            <div><b>${escapeHtml(String(value))}</b><span>${escapeHtml(sub)}</span><em>${escapeHtml(label)}</em></div>
        </div>`;
    }

    /* ------------------------- 表单交互 ------------------------- */
    function applyPreset(mode) {
        const p = MODE_PRESETS[mode];
        state.mode = mode;
        const dataset = datasets.find((d) => d.id === state.datasetId) || {};
        $('#tRank').value = p.rank;
        $('#tLr').value = p.lr;
        $('#tBatch').value = p.batch;
        $('#tAccum').value = p.gradAccum;
        $('#tRes').value = p.resolution;
        $('#tAlpha').value = Math.round(p.rank * (p.alphaRatio || 0.5));
        $('#tOpt').value = p.optimizer;
        $('#tSch').value = p.scheduler;
        $('#tNoise').classList.toggle('on', !!p.noiseOffset);
        // 预设同时重定安全基线：否则残留的 fp16 + 文本编码器会把“必然失败”的组合带进下一轮
        $('#tPrec').value = 'bf16';
        $('#tTextEnc').classList.remove('on');
        state.epochs = suggestEpochs({ mode, batch: p.batch, gradAccum: p.gradAccum }, dataset);
        $('#tEpochs').value = state.epochs;
        host.querySelectorAll('#modeTabs .chip').forEach((el) => el.classList.toggle('active', el.dataset.mode === mode));
    }

    host.querySelector('#modeTabs').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-mode]');
        if (!chip) return;
        applyPreset(chip.dataset.mode);
        paintEstimate();
    });

    host.querySelector('#datasetGrid').addEventListener('click', (e) => {
        const card = e.target.closest('[data-dataset]');
        if (!card) return;
        state.datasetId = card.dataset.dataset;
        host.querySelectorAll('.dataset-card').forEach((el) => el.classList.toggle('active', el === card));
        const dataset = datasets.find((d) => d.id === state.datasetId) || {};
        const suggested = suggestEpochs({ mode: state.mode, batch: Number(val('#tBatch')), gradAccum: Number(val('#tAccum')) }, dataset);
        $('#tEpochs').value = suggested;
        paintEstimate();
    });

    // 开关行统一绑在 label 上，点文字与点开关都能切换（preventDefault 避免 label 默认行为再触发一次）
    $('#swAlpha').addEventListener('click', (e) => {
        e.preventDefault();
        state.alphaAuto = !state.alphaAuto;
        $('#alphaAuto').classList.toggle('on', state.alphaAuto);
        const el = $('#tAlpha');
        el.disabled = state.alphaAuto;
        if (state.alphaAuto) el.value = Math.round(Number(val('#tRank')) * ((MODE_PRESETS[state.mode] || {}).alphaRatio || 0.5));
        paintEstimate();
    });

    [['#swNoise', '#tNoise'], ['#swTextEnc', '#tTextEnc'], ['#swPublish', '#autoPublish']].forEach(([rowSel, swSel]) => {
        $(rowSel)?.addEventListener('click', (e) => {
            e.preventDefault();
            $(swSel).classList.toggle('on');
            paintEstimate();
        });
    });

    host.querySelector('#tRank').addEventListener('change', () => {
        if (state.alphaAuto) $('#tAlpha').value = Math.round(Number(val('#tRank')) * ((MODE_PRESETS[state.mode] || {}).alphaRatio || 0.5));
        paintEstimate();
    });

    ['#tBase', '#tEpochs', '#tAlpha', '#tLr', '#tBatch', '#tAccum', '#tRes', '#tOpt', '#tSch', '#tDrop', '#tPrec', '#tClip', '#tSave', '#tSeed', '#tTrigger'].forEach((sel) => {
        const el = host.querySelector(sel);
        if (!el) return;
        el.addEventListener('input', paintEstimate);
        el.addEventListener('change', paintEstimate);
    });

    host.querySelector('#advBox')?.addEventListener('toggle', () => {
        $('#advBadge').textContent = host.querySelector('#advBox').open ? '' : ' · 已按预设配置';
    });

    host.querySelector('#fillExample').addEventListener('click', () => {
        const dataset = datasets.find((d) => d.id === state.datasetId);
        // 从数据集名称里收出主词，避免截尾巴截出「筑参考集」这类碎片名
        const clean = String(dataset?.name || 'demo').replace(/^(官方|我的)\s*[·、]\s*/, '').replace(/[（(].*?[)）]/g, '').trim();
        const base = (clean.replace(/(参考集|基础集|精选集|素材集|素材库|数据集)$/, '') || clean).slice(0, 8);
        const digits = (String(dataset?.id || '').match(/\d+/) || ['0'])[0];
        $('#tName').value = `${base} · 风格模型`.slice(0, 24);
        $('#tTrigger').value = `lx_${digits}${String(Date.now()).slice(-2)}`;
        applyPreset('standard');
        $('#tSave').value = 3;
        $('#tSeed').value = 20260213;
        paintEstimate();
        toast('已填入推荐配置，可直接开始训练', 'success');
    });

    host.querySelector('#startTrain').addEventListener('click', async () => {
        const btn = host.querySelector('#startTrain');
        const est = computeEstimate();
        if (!est) return toast('请完整填写训练参数', 'error');
        // 前端先拦一次：与后端 checkTraining 同源，避免明显非法配置发到服务端
        if (est.vramOver) return toast(`显存估算 ${est.cfg.vramGb} GB 超出节点上限 ${est.cfg.vramLimitGb} GB，请降低 Batch / 分辨率 / Rank`, 'error');
        btn.classList.add('loading');
        btn.disabled = true;
        try {
            const { training } = await createTraining({
                name: val('#tName'),
                trigger: val('#tTrigger'),
                datasetId: state.datasetId,
                autoPublish: host.querySelector('#autoPublish').classList.contains('on'),
                // 提交归一化后的领域配置，保证落库的 steps / 成本与页面预估一致
                config: est.cfg
            });
            toast('训练任务已提交，正在排队', 'success');
            const next = await getAccount();
            state.credits = next.credits;
            balanceText.textContent = num(next.credits);
            applyList((await listTrainings()).trainings);
            watch(training.id);
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            btn.classList.remove('loading');
            btn.disabled = false;
        }
    });

    /* 列表跟随引擎：提交后 queued → running 的转换由引擎完成，
     * 面板轮询只在打开过程时跑，因此需要一个不依赖面板的轻量列表同步 */
    on(EVENTS.taskUpdate, (payload) => {
        const task = payload?.task;
        if (!task || task.type !== 'train') return;
        if (!trainings.some((t) => ['queued', 'running'].includes(t.status))) return;
        listTrainings()
            .then(({ trainings: fresh }) => applyList(fresh, true))
            .catch((err) => console.warn(err));
    });

    /* 另一个标签页写库时，db.js 已作废本地内存缓存，但列表不会自己重绘：
     * 监听同一份 storage 的跨页写入事件，把对方提交的训练同步过来 */
    let foreignTimer = 0;
    window.addEventListener('storage', (e) => {
        if (e.key !== KEYS.db) return;
        clearTimeout(foreignTimer);
        foreignTimer = setTimeout(() => {
            listTrainings()
                .then(({ trainings: fresh }) => applyList(fresh, true))
                .catch((err) => console.warn(err));
        }, 500);
    });

    /* ------------------------- 过程监控 ------------------------- */
    function stopWatch() {
        if (state.polling) clearInterval(state.polling);
        if (state.unsubscribe) state.unsubscribe();
        state.polling = null;
        state.unsubscribe = null;
        state.liveId = null;
    }

    async function watch(trainingId) {
        stopWatch();
        state.liveId = trainingId;
        progressBox.classList.remove('hidden');
        const pull = async () => {
            try {
                const { training } = await getTraining(trainingId);
                paintLive(training);
                if (!['queued', 'running'].includes(training.status)) {
                    stopWatch();
                    const [next, fresh] = await Promise.all([getAccount(), listTrainings()]);
                    state.credits = next.credits;
                    balanceText.textContent = num(next.credits);
                    applyList(fresh.trainings);
                }
            } catch (err) {
                console.warn(err);
            }
        };
        await pull();
        state.polling = setInterval(pull, POLL_MS);
        state.unsubscribe = on(EVENTS.taskUpdate, () => {
            if (state.liveId) pull();
        });
    }

    function paintLive(training) {
        const task = training.task || { progress: 0, status: training.status, logs: [] };
        const cfg = training.config || {};
        const dataset = training.dataset || {};
        const plan = buildTrainPlan(cfg, dataset, training.trigger);
        const progress = Math.max(0, Math.min(100, Number(task.progress) || 0));
        const st = statusMeta(training.status);
        const active = ['queued', 'running'].includes(training.status);

        progressBox.innerHTML = `<div class="card live-card">
            <div class="card-head">
                <div>
                    <div class="card-title row" style="gap:8px">${escapeHtml(training.name)}
                        <span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${st.label}</span>
                    </div>
                    <div class="card-sub">${escapeHtml(cfg.base)} · Rank ${cfg.rank}/${cfg.alpha} · ${cfg.epochs} epoch · ${num(cfg.steps)} 步 · ${settledCost(task, cfg).phrase('算力')}</div>
                </div>
                <div class="spacer"></div>
                ${active ? `<button class="btn btn-sm btn-outline" data-act="cancel" data-id="${task.id || ''}">${icon('stop', 13)}中断训练</button>` : ''}
                <button class="btn btn-sm btn-ghost" data-act="detail" data-training="${training.id}">${icon('info', 13)}完整详情</button>
            </div>
            <div class="card-body">
                <div class="stage-track">${stageTrack(plan, progress, training.status)}</div>
                <div style="margin:12px 0 4px">${progressBar(progress, training.status === 'failed' ? 'danger' : training.status === 'succeeded' ? 'ok' : '', active)}</div>
                <div class="row between small muted" style="margin-bottom:12px">
                    <span>第 ${Math.round((progress / 100) * cfg.steps)} / ${num(cfg.steps)} 步 · Epoch ${Math.min(cfg.epochs, Math.floor((progress / 100) * cfg.epochs))} / ${cfg.epochs}</span>
                    <span>${active ? `剩余约 ${Math.max(0, Math.ceil((cfg.estimateMin || 0) * (1 - progress / 100)))} 分钟` : '已结束'}</span>
                </div>

                <div class="live-grid">
                    ${liveCell('当前 loss', liveLoss(training, cfg), lossTrend(training))}
                    ${liveCell('学习率', lrAt(cfg, progress / 100).toExponential(2), `调度 ${cfg.scheduler || 'cosine'}`)}
                    ${liveCell('显存占用', `${cfg.vramGb} / ${cfg.vramLimitGb} GB`, `${cfg.precision} · batch ${cfg.batch}×${cfg.gradAccum}`)}
                    ${liveCell('训练吞吐', `${cfg.samplesPerSec} samples/s`, `≈ ${Math.round((cfg.samplesPerSec || 1) * (cfg.batch || 1))} img/s`)}
                    ${liveCell('Checkpoint', `${(training.checkpoints || []).length} 个`, (training.checkpoints || []).slice(-1)[0]?.name || '尚未保存')}
                    ${liveCell('验证样张', `${(training.samples || []).length} 张`, `每 ${cfg.savePerEpoch || 3} epoch 存权重`)}
                </div>

                <div class="live-charts">
                    <div>
                        <div class="label" style="margin-bottom:6px">Loss 曲线<span class="hint-inline">${(training.loss || []).length} 个采样点</span></div>
                        <div class="loss-chart">${lossChart(training.loss || [], cfg)}</div>
                    </div>
                    <div>
                        <div class="label" style="margin-bottom:6px">运行日志<span class="hint-inline">实时</span></div>
                        <div class="log-panel" id="liveLog">${logLines(task.logs || [])}</div>
                    </div>
                </div>

                ${(training.samples || []).length ? `<div class="divider"></div>
                    <div class="label" style="margin-bottom:8px">过程样张<span class="hint-inline">里程碑步生成的验证图，用于判断特征强度与过拟合</span></div>
                    <div class="sample-strip">${training.samples.map(sampleTile).join('')}</div>` : ''}

                ${training.status === 'succeeded' ? `<div class="row" style="gap:8px;margin-top:14px;flex-wrap:wrap">
                    <a class="btn btn-sm btn-primary" href="${url('assets/model-detail.html')}?id=${training.modelId}" target="self">${icon('cpu', 13)}查看模型资产</a>
                    <a class="btn btn-sm btn-outline" href="${url('tasks.html')}" target="self">${icon('check', 13)}任务中心产物</a>
                    <button class="btn btn-sm btn-ghost" data-act="publish" data-training="${training.id}">${icon('upload', 13)}发布 / 更新资产</button>
                    <button class="btn btn-sm btn-ghost" data-act="toml" data-training="${training.id}">${icon('copy', 13)}复制训练配置</button>
                </div>` : ''}
                ${training.status === 'failed' ? `<div class="row" style="gap:8px;margin-top:14px;flex-wrap:wrap">
                    <span class="small" style="color:var(--danger)">${icon('alert', 13)} ${escapeHtml(training.error || '训练失败，算力已退还')}</span>
                    <span class="spacer"></span>
                    <button class="btn btn-sm btn-outline" data-act="retry" data-training="${training.id}">${icon('refresh', 13)}改参数重试</button>
                </div>` : ''}
                ${training.status === 'canceled' ? `<div class="small muted" style="margin-top:12px">训练已中断，按已完成 ${Math.round(progress)}% 结算：${settledCost(task, cfg).phrase('算力')}。</div>` : ''}
            </div>
        </div>`;
        const log = progressBox.querySelector('#liveLog');
        if (log) log.scrollTop = log.scrollHeight;
    }

    function liveCell(label, value, sub) {
        return `<div class="live-cell"><em>${escapeHtml(label)}</em><b class="mono">${escapeHtml(String(value ?? '—'))}</b><span class="small muted">${escapeHtml(sub || '')}</span></div>`;
    }

    function liveLoss(training, cfg) {
        const arr = training.loss || [];
        if (arr.length) return arr[arr.length - 1].loss;
        return lossAt(cfg, 0, cfg.lossPoints || 24);
    }

    function lossTrend(training) {
        const arr = training.loss || [];
        if (arr.length < 2) return '首个采样点生成后显示趋势';
        const delta = arr[arr.length - 1].loss - arr[Math.max(0, arr.length - 6)].loss;
        return delta <= 0 ? `近 ${Math.min(5, arr.length - 1)} 点下降 ${Math.abs(delta).toFixed(3)}` : `近 ${Math.min(5, arr.length - 1)} 点回升 ${delta.toFixed(3)}`;
    }

    function sampleTile(s) {
        return `<figure class="sample-item">
            ${imgTag(s.image, `样张 step ${s.step} · ${s.label}`, 'sample-img')}
            <figcaption><b>${escapeHtml(s.label)}</b><span>${s.loss != null ? `loss ${s.loss}` : ''}</span></figcaption>
        </figure>`;
    }

    /* ------------------------- 任务列表操作 ------------------------- */
    jobList.addEventListener('click', async (e) => {
        const copy = e.target.closest('[data-copy]');
        if (copy) return copyText(copy.dataset.copy, '触发词已复制');

        const detail = e.target.closest('[data-detail]');
        if (detail) {
            const target = trainings.find((t) => t.id === detail.dataset.detail) || (await getTraining(detail.dataset.detail)).training;
            if (target) showDetail(target);
            return;
        }
        const goto = e.target.closest('[data-model]');
        if (goto) {
            window.location.href = `${url('assets/model-detail.html')}?id=${goto.dataset.model}`;
            return;
        }
        const open = e.target.closest('[data-open]');
        if (open) {
            progressBox.classList.remove('hidden');
            watch(open.dataset.open);
            host.scrollIntoView();
            return;
        }
        const retry = e.target.closest('[data-retry]');
        if (retry) return openRetry(trainings.find((t) => t.id === retry.dataset.retry));

        const cancel = e.target.closest('[data-cancel]');
        if (cancel) return doCancel(cancel.dataset.cancel, cancel.dataset.task);
    });

    progressBox.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'cancel') return doCancel(state.liveId, btn.dataset.id);
        if (act === 'detail') return showDetail((await getTraining(btn.dataset.training)).training);
        if (act === 'retry') return openRetry((await getTraining(btn.dataset.training)).training);
        if (act === 'toml') {
            const t = (await getTraining(btn.dataset.training)).training;
            return copyText(trainToml(t), '训练配置已复制（TOML）');
        }
        if (act === 'publish') {
            const t = (await getTraining(btn.dataset.training)).training;
            try {
                const work = await createModelAsset({ trainingId: t.id, title: t.name, publish: true });
                toast(`已发布模型资产「${work.title}」`, 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
        }
    });

    async function doCancel(trainingId, taskId) {
        if (!taskId) return toast('任务尚未分配，无法中断', 'error');
        const ok = await confirmDialog({ title: '中断训练', message: '已跑完的进度按实际消耗计费，其余算力立即退回账户。', confirmText: '中断训练', danger: true });
        if (!ok) return;
        try {
            await cancelTask(taskId);
            toast('训练已中断，未消耗算力已退回', 'success');
            const [fresh, next] = await Promise.all([listTrainings(), getAccount()]);
            applyList(fresh.trainings);
            state.credits = next.credits;
            balanceText.textContent = num(next.credits);
            watch(trainingId);
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    function openRetry(training) {
        if (!training) return;
        const options = retrySuggestions(training.config || {}, training.error || '');
        openModal({
            title: `改参数重试 · ${training.name}`,
            body: `<div class="col" style="gap:10px">
                <div class="small muted">失败原因：${escapeHtml(training.error || '训练异常终止')}</div>
                ${options.map((o, i) => `<button class="retry-opt ${i === 1 ? 'best' : ''}" data-retry-opt="${i}">
                    <b>${escapeHtml(o.title)}</b><span>${escapeHtml(o.desc)}</span>
                </button>`).join('')}
                <div class="small muted">重试会新建一条训练记录，原记录与 loss 曲线保留以便对比。</div>
            </div>`,
            footer: '<button class="btn btn-outline" data-close>取消</button>',
            onMount(card, root) {
                card.querySelectorAll('[data-retry-opt]').forEach((btn) => btn.addEventListener('click', async () => {
                    const opt = options[Number(btn.dataset.retryOpt)];
                    root.querySelector('.modal-mask')?.click();
                    try {
                        const { training: fresh } = await restartTraining(training.id, opt.overrides);
                        toast(`已按「${opt.title}」重新提交`, 'success');
                        const list = await listTrainings();
                        applyList(list.trainings);
                        watch(fresh.id);
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                }));
            }
        });
    }

    function showDetail(training) {
        const cfg = training.config || {};
        const st = statusMeta(training.status);
        const loss = training.loss || [];
        openModal({
            title: `训练详情 · ${training.name}`,
            size: 'lg',
            body: `<div class="col" style="gap:14px">
                <div class="row wrap" style="gap:8px">
                    <span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${st.label}</span>
                    <span class="tag mono">触发词 ${escapeHtml(training.trigger)}</span>
                    <span class="tag">${escapeHtml(cfg.base)}</span>
                    <span class="tag">Rank ${cfg.rank} / α ${cfg.alpha}</span>
                    <span class="tag">${cfg.epochs} epoch · ${num(cfg.steps)} 步</span>
                    <span class="tag">${escapeHtml(cfg.optimizer)}</span>
                </div>
                <dl class="param-list">
                    <dt>数据集</dt><dd>${escapeHtml(training.dataset?.name || '-')}（${training.dataset?.count || 0} 张 · repeat ${cfg.repeat}）</dd>
                    <dt>学习率</dt><dd>${lrLabel(cfg.lr)}（${escapeHtml(cfg.scheduler)}，warmup ${cfg.warmupSteps} 步）</dd>
                    <dt>批次</dt><dd>${cfg.batch} × 累积 ${cfg.gradAccum} = 等效 ${(cfg.batch || 1) * (cfg.gradAccum || 1)}</dd>
                    <dt>分辨率 / 精度</dt><dd>${cfg.resolution} px · ${escapeHtml(cfg.precision)}</dd>
                    <dt>Dropout / CLIP Skip</dt><dd>${cfg.dropout} · ${cfg.clipSkip}</dd>
                    <dt>文本编码器</dt><dd>${cfg.trainTextEncoder ? '参与训练' : '冻结（仅 UNet）'}</dd>
                    <dt>随机种子</dt><dd class="mono">${cfg.seed}</dd>
                    <dt>Checkpoint</dt><dd>每 ${cfg.savePerEpoch} epoch · 共 ${(training.checkpoints || []).length} 个（${cfg.weightMb} MB / 个）</dd>
                    <dt>显存 / 吞吐</dt><dd>${cfg.vramGb} GB（上限 ${cfg.vramLimitGb}）· ${cfg.samplesPerSec} samples/s</dd>
                    <dt>创建 / 耗时</dt><dd>${timeAgo(training.createdAt)} · ${training.durationMin ? `${training.durationMin} 分钟` : '—'}</dd>
                    <dt>最终 loss</dt><dd>${loss.length ? loss[loss.length - 1].loss : '—'}</dd>
                    <dt>算力结算</dt><dd>${settledCost(training.task, cfg).phrase('积分')}</dd>
                </dl>
                ${loss.length ? `<div>
                    <div class="label" style="margin-bottom:6px">Loss 曲线</div>
                    <div class="loss-chart">${lossChart(loss, cfg)}</div>
                </div>` : ''}
                ${(training.samples || []).length ? `<div>
                    <div class="label" style="margin-bottom:8px">过程样张</div>
                    <div class="sample-strip">${training.samples.map(sampleTile).join('')}</div>
                </div>` : ''}
                ${(training.checkpoints || []).length ? `<div>
                    <div class="label" style="margin-bottom:8px">Checkpoint</div>
                    <div class="ckpt-chips">${training.checkpoints.map((c) => `<span class="tag mono">${escapeHtml(c.name)} · loss ${c.loss}</span>`).join('')}</div>
                </div>` : ''}
                <div>
                    <div class="label" style="margin-bottom:6px">完整日志</div>
                    <div class="log-panel">${logLines(training.task?.logs || [])}</div>
                </div>
                <div>
                    <div class="label" style="margin-bottom:6px">训练配置<span class="hint-inline">可复制到自己的训练脚本</span></div>
                    <pre class="toml-block">${escapeHtml(trainToml(training))}</pre>
                </div>
            </div>`,
            footer: training.modelId
                ? `<button class="btn btn-outline" data-close>关闭</button><a class="btn btn-primary" href="${url('assets/model-detail.html')}?id=${training.modelId}">查看模型资产</a>`
                : `<button class="btn btn-outline" data-close>关闭</button>${['failed', 'canceled'].includes(training.status) ? `<button class="btn btn-primary" data-detail-retry="${training.id}">改参数重试</button>` : ''}`,
            onMount(card) {
                card.querySelector('[data-detail-retry]')?.addEventListener('click', () => {
                    closeModal();
                    openRetry(training);
                });
            }
        });
    }

    /* ------------------------- 初始化 ------------------------- */
    paintEstimate();
    const resume = ctx.query.training || (running[0]?.id || '');
    if (resume && trainings.some((t) => t.id === resume)) {
        watch(resume);
    } else if (ctx.query.training) {
        getTraining(ctx.query.training).then(({ training }) => showDetail(training)).catch(() => {});
    }
}

/* ============================ 纯展示函数 ============================ */

/**
 * 实际计费：名义消耗扣除退还部分（中断按比例退、失败全额退）。
 * 不这样做的话，已取消的任务会同时显示「消耗 150」和「已退 129」两个矛盾数字。
 */
function settledCost(task, cfg = {}) {
    const cost = Number(task?.cost ?? cfg.estimateCost) || 0;
    const refund = Number(task?.refund) || 0;
    const paid = Math.max(0, cost - refund);
    return {
        cost,
        refund,
        paid,
        /** 统一拼成一句完整文案，避免调用方拼后缀时多出空格 */
        phrase: (unit = '算力') => (refund > 0
            ? `实付 ${num(paid)} ${unit}（名义 ${num(cost)}，已退 ${num(refund)}）`
            : `消耗 ${num(cost)} ${unit}`)
    };
}

function statCard(id, label, value, sub, iconName, raw = false) {
    return `<div class="metric">
        <div class="row" style="gap:8px">
            <span style="width:28px;height:28px;border-radius:8px;background:var(--brand-50);color:var(--brand-600);display:inline-flex;align-items:center;justify-content:center">${icon(iconName, 14)}</span>
            <span class="metric-label">${escapeHtml(label)}</span>
        </div>
        <div class="metric-value" id="stat-${id}-v">${raw ? value : (typeof value === 'number' ? num(value) : escapeHtml(String(value)))}</div>
        <div class="metric-trend" id="stat-${id}-t">${escapeHtml(sub)}</div>
    </div>`;
}

/** 已完成训练的平均实际耗时（分钟） */
function avgDuration(list) {
    const done = list.filter((t) => t.durationMin);
    return done.length ? `${Math.round(done.reduce((s, t) => s + t.durationMin, 0) / done.length)} 分钟` : '—';
}

function jobCard(training) {
    const st = statusMeta(training.status);
    const task = training.task;
    const cfg = training.config || {};
    const lastLog = task?.logs?.slice(-1)[0]?.msg || '等待调度';
    const finalLoss = (training.loss || []).length ? training.loss[training.loss.length - 1].loss : null;
    return `<div class="job-card ${['queued', 'running'].includes(training.status) ? 'running' : ''}" data-job="${training.id}">
        <div class="row between" style="align-items:flex-start">
            <div style="min-width:0">
                <div class="row" style="gap:6px;flex-wrap:wrap">
                    <b style="font-size:13px">${escapeHtml(training.name)}</b>
                    <span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${st.label}</span>
                </div>
                <div class="small muted" style="margin-top:3px">
                    ${escapeHtml(cfg.base)} · Rank ${cfg.rank}/${cfg.alpha} · ${cfg.epochs} epoch · ${num(cfg.steps)} 步
                </div>
                <div class="small muted" style="margin-top:2px">${escapeHtml(cfg.optimizer)} · ${lrLabel(cfg.lr)} · batch ${cfg.batch}×${cfg.gradAccum} · ${timeAgo(training.createdAt)}</div>
            </div>
            <span class="tag mono">${escapeHtml(training.trigger)}</span>
        </div>
        ${['queued', 'running'].includes(training.status) ? `
            <div style="margin:8px 0 4px">${progressBar(task?.progress || 0, '', true)}</div>
            <div class="small muted ellipsis job-log">${escapeHtml(lastLog)}</div>
            <div class="row" style="gap:6px;margin-top:8px">
                <button class="btn btn-sm btn-primary" data-open="${training.id}">${icon('eye', 13)}查看过程</button>
                <button class="btn btn-sm btn-ghost" data-cancel="${training.id}" data-task="${task?.id || ''}">${icon('stop', 13)}中断</button>
            </div>` : ''}
        ${training.status === 'succeeded' ? `<div class="row small" style="gap:10px;margin-top:8px;color:var(--ok);flex-wrap:wrap">
            <span>${icon('check', 13)} 完成 · loss ${finalLoss ?? '—'}</span>
            <span class="muted">${(training.checkpoints || []).length} ckpt · ${(training.samples || []).length} 样张 · ${training.durationMin} 分钟</span>
        </div>` : ''}
        ${training.status === 'failed' ? `<div class="row small" style="gap:8px;margin-top:8px;color:var(--danger)">
            ${icon('alert', 13)} <span class="ellipsis">${escapeHtml(training.error || '训练异常终止，算力已退还')}</span>
        </div>` : ''}
        ${training.status === 'canceled' ? `<div class="row small muted" style="gap:8px;margin-top:8px">
            ${icon('stop', 13)} <span>已中断（按 ${Math.round(task?.progress || 0)}% 计费）</span>
        </div>` : ''}
        <div class="row" style="gap:6px;margin-top:10px">
            <button class="btn btn-sm btn-ghost" data-detail="${training.id}">${icon('info', 13)}详情</button>
            <button class="btn btn-sm btn-ghost" data-copy="${escapeHtml(training.trigger)}">${icon('copy', 13)}触发词</button>
            ${['failed', 'canceled'].includes(training.status) ? `<button class="btn btn-sm btn-ghost" data-retry="${training.id}">${icon('refresh', 13)}重试</button>` : ''}
            <span class="spacer"></span>
            ${training.modelId ? `<button class="btn btn-sm btn-outline" data-model="${training.modelId}">${icon('cpu', 13)}模型资产</button>` : ''}
        </div>
    </div>`;
}

/** 阶段进度条：按共用计划把条目归入 5 个阶段，直观看出训练走到哪一步 */
function stageTrack(plan, progress, status) {
    return PLAN_STAGES.map((stage) => {
        const items = plan.filter((p) => p.stage === stage.id);
        if (!items.length) return '';
        const done = items.filter((i) => i.at <= progress).length;
        const cls = status === 'failed' && done === 0 ? 'bad' : done >= items.length ? 'done' : done > 0 ? 'active' : '';
        return `<div class="stage-item ${cls}">
            <span class="stage-dot">${done >= items.length ? icon('check', 11) : done > 0 ? icon('clock', 11) : ''}</span>
            <b>${escapeHtml(stage.name)}</b>
            <em>${done}/${items.length}</em>
        </div>`;
    }).join('<span class="stage-sep"></span>');
}

function logLines(logs) {
    if (!logs.length) return '<div class="small muted">暂无日志</div>';
    return logs.slice(-24).map((l) => `<div class="log-line ${l.level === 'ok' ? 'ok' : l.level === 'warn' ? 'warn' : l.level === 'err' ? 'err' : ''}"><span class="t">${escapeHtml(l.t || '')}</span><span class="m">${escapeHtml(l.msg || '')}</span></div>`).join('');
}

/** Loss 曲线：数据点随训练增长，末点带标记与数值 */
function lossChart(points, cfg = {}) {
    if (!points.length) return '<div class="small muted" style="padding:24px 12px">首个采样点将在训练开始后出现</div>';
    const w = 360;
    const h = 96;
    const values = points.map((p) => p.loss);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || 1;
    const xy = (p, i) => [
        (i / Math.max(1, points.length - 1)) * w,
        h - ((p.loss - min) / span) * (h - 12) - 6
    ];
    const path = points.map((p, i) => {
        const [x, y] = xy(p, i);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const [lx, ly] = xy(points[points.length - 1], points.length - 1);
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
        <line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="var(--border)" stroke-width="1"/>
        <path d="${path}" fill="none" stroke="var(--brand)" stroke-width="1.6"/>
        <path d="${path} L${lx.toFixed(1)},${h} L0,${h} Z" fill="var(--brand-50)" opacity=".7"/>
        <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.6" fill="var(--brand)"/>
    </svg>
    <div class="chart-axis"><span>step 1 → ${num(cfg.steps || points[points.length - 1].step)}</span><span>loss ${min} ~ ${max}</span></div>`;
}
