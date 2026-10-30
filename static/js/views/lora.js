import { listTrainings, createTraining, getTask, getAccount } from '../core/api.js';
import { statusMeta } from '../core/constants.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast, progressBar, emptyState, copyText, openModal } from '../core/ui.js';
import { escapeHtml, num, timeAgo } from '../core/format.js';
import { on, EVENTS } from '../core/bus.js';

const BASES = ['SDXL 1.0', 'SD 1.5', 'FLUX.1 dev', 'SDXL Turbo'];

export async function render(host, ctx) {
    setPageTitle('模型训练');
    const [{ trainings, datasets }, account] = await Promise.all([listTrainings(), getAccount()]);

    const state = {
        datasetId: datasets[0]?.id || '',
        trainingId: ctx.query.training || '',
        taskId: null,
        polling: null,
        unsubscribe: null
    };

    host.innerHTML = `
        <div class="page-head">
            <div class="page-head-main">
                <h1 class="page-title">LoRA 模型训练</h1>
                <div class="page-sub">用自有数据集训练风格 / 角色模型，训练完成后自动生成可调用的模型资产</div>
            </div>
            <div class="page-actions">
                <span class="balance-chip">${icon('credit', 14)} <b id="balanceText">${num(account.credits)}</b></span>
                <a class="btn btn-outline" href="${url('assets/my-assets-model.html')}">${icon('cpu', 15)}我的模型</a>
            </div>
        </div>

        <div class="grid cols-3" style="margin-bottom:16px">
            ${statCard('数据集', datasets.length, `共 ${datasets.reduce((s, d) => s + d.count, 0)} 张样本`, 'database')}
            ${statCard('训练任务', trainings.length, `${trainings.filter((t) => t.status === 'succeeded').length} 个已完成`, 'cpu')}
            ${statCard('单次成本', 120, '训练完成并生成模型资产', 'credit')}
        </div>

        <div class="train-wrap">
            <div class="card">
                <div class="card-head">
                    <div>
                        <div class="card-title">新建训练任务</div>
                        <div class="card-sub">选择数据集并配置训练参数</div>
                    </div>
                </div>
                <div class="card-body">
                    <div class="label" style="margin-bottom:8px">训练数据集 <span class="req">*</span></div>
                    <div class="dataset-grid" id="datasetGrid">
                        ${datasets.map((d) => `<button class="dataset-card ${state.datasetId === d.id ? 'active' : ''}" data-dataset="${d.id}">
                            <div class="dataset-thumbs">
                                ${d.thumbs.slice(0, 4).map((t) => `<img src="${escapeHtml(t)}" alt="样本" loading="lazy">`).join('')}
                            </div>
                            <b>${escapeHtml(d.name)}</b>
                            <span>${d.count} 张 · 已打标 ${d.tagged} · ${escapeHtml(d.resolution)}</span>
                        </button>`).join('')}
                    </div>

                    <div class="form-grid" style="margin-top:18px">
                        <div class="field">
                            <label class="label" for="tName">模型名称 <span class="req">*</span></label>
                            <input class="input" id="tName" maxlength="24" placeholder="例如：林澈人像 · 柔光">
                        </div>
                        <div class="field">
                            <label class="label" for="tTrigger">触发词 <span class="req">*</span>
                                <span class="hint-inline">建议 2-4 个字母</span></label>
                            <input class="input mono" id="tTrigger" maxlength="16" placeholder="lch_soft">
                        </div>
                        <div class="field">
                            <label class="label" for="tBase">底模</label>
                            <select class="select" id="tBase">
                                ${BASES.map((b) => `<option>${b}</option>`).join('')}
                            </select>
                        </div>
                        <div class="field">
                            <label class="label" for="tRank">网络维度 Rank</label>
                            <select class="select" id="tRank">
                                ${[8, 16, 32, 64].map((r) => `<option value="${r}" ${r === 32 ? 'selected' : ''}>${r}</option>`).join('')}
                            </select>
                        </div>
                        <div class="field">
                            <label class="label" for="tSteps">训练步数</label>
                            <input class="input" type="number" id="tSteps" min="500" max="10000" step="500" value="3000">
                        </div>
                        <div class="field">
                            <label class="label" for="tLr">学习率</label>
                            <select class="select" id="tLr">
                                ${[0.00005, 0.0001, 0.0002, 0.0005].map((v) => `<option value="${v}" ${v === 0.0001 ? 'selected' : ''}>${v}</option>`).join('')}
                            </select>
                        </div>
                    </div>

                    <div class="row between wrap" style="margin-top:16px;gap:12px">
                        <div class="row small muted" style="gap:16px">
                            <span>${icon('credit', 13)} 预计消耗 <b style="color:var(--text)">120</b> 算力</span>
                            <span>${icon('clock', 13)} 预计 35-60 分钟</span>
                        </div>
                        <div class="row" style="gap:10px">
                            <label class="row small" style="gap:6px;cursor:pointer">
                                <span class="switch" id="autoPublish"></span> 完成后自动发布
                            </label>
                            <button class="btn btn-primary" id="startTrain">${icon('rocket', 15)}开始训练</button>
                        </div>
                    </div>

                    <div id="trainProgress" class="hidden" style="margin-top:16px"></div>
                </div>
            </div>

            <div class="col" style="gap:14px">
                <div class="card">
                    <div class="card-head">
                        <div class="card-title">训练任务</div>
                        <div class="spacer"></div>
                        <span class="badge">${trainings.length}</span>
                    </div>
                    <div class="card-body col" style="gap:10px" id="jobList">
                        ${trainings.length ? trainings.map(jobCard).join('') : emptyState({ title: '还没有训练任务', desc: '选择数据集并配置参数后开始第一次训练。' })}
                    </div>
                </div>
                <div class="card">
                    <div class="card-head"><div class="card-title">训练小贴士</div></div>
                    <div class="card-body small" style="color:var(--text-2);line-height:1.9">
                        <div class="row" style="gap:8px;align-items:flex-start">${icon('check', 14)}<span>样本数量 20-50 张、分辨率统一，效果最稳定。</span></div>
                        <div class="row" style="gap:8px;align-items:flex-start">${icon('check', 14)}<span>人像类优先浅色底，场景类保留多样视角。</span></div>
                        <div class="row" style="gap:8px;align-items:flex-start">${icon('check', 14)}<span>触发词使用罕见短词，避免与底模已有概念冲突。</span></div>
                        <div class="row" style="gap:8px;align-items:flex-start">${icon('alert', 14)}<span>训练失败会自动退还算力，可在任务中心查看日志。</span></div>
                    </div>
                </div>
            </div>
        </div>`;

    const jobList = host.querySelector('#jobList');
    const progressBox = host.querySelector('#trainProgress');
    const balanceText = host.querySelector('#balanceText');

    host.querySelector('#autoPublish')?.addEventListener('click', (e) => {
        e.currentTarget.classList.toggle('on');
    });

    host.querySelector('#datasetGrid')?.addEventListener('click', (e) => {
        const card = e.target.closest('[data-dataset]');
        if (!card) return;
        state.datasetId = card.dataset.dataset;
        host.querySelectorAll('.dataset-card').forEach((el) => el.classList.toggle('active', el === card));
    });

    host.querySelector('#startTrain')?.addEventListener('click', async () => {
        if (!state.datasetId) return toast('请选择训练数据集', 'error');
        const name = host.querySelector('#tName').value.trim();
        const trigger = host.querySelector('#tTrigger').value.trim();
        if (!name) return toast('请填写模型名称', 'error');
        if (!trigger) return toast('请设置触发词', 'error');

        const btn = host.querySelector('#startTrain');
        btn.classList.add('loading');
        btn.disabled = true;
        try {
            const { training, task } = await createTraining({
                name,
                trigger,
                datasetId: state.datasetId,
                base: host.querySelector('#tBase').value,
                rank: host.querySelector('#tRank').value,
                steps: host.querySelector('#tSteps').value,
                lr: host.querySelector('#tLr').value,
                autoPublish: host.querySelector('#autoPublish').classList.contains('on')
            });
            toast('训练任务已提交，正在排队', 'success');
            const next = await getAccount();
            balanceText.textContent = num(next.credits);
            progressBox.classList.remove('hidden');
            watch(task, training);
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            btn.classList.remove('loading');
            btn.disabled = false;
        }
    });

    jobList.addEventListener('click', (e) => {
        const copyBtn = e.target.closest('[data-copy]');
        if (copyBtn) {
            copyText(copyBtn.dataset.copy, '触发词已复制');
            return;
        }
        const detailBtn = e.target.closest('[data-detail]');
        if (detailBtn) {
            const tr = trainings.find((t) => t.id === detailBtn.dataset.detail);
            if (tr) showDetail(tr);
            return;
        }
        const goto = e.target.closest('[data-model]');
        if (goto) window.location.href = `${url('assets/model-detail.html')}?id=${goto.dataset.model}`;
    });

    function watch(task, training) {
        stopWatch();
        state.taskId = task.id;
        paint(task, training);
        state.unsubscribe = on(EVENTS.taskUpdate, (t) => {
            if (t && t.id === state.taskId) paint(t, training);
        });
        state.polling = setInterval(async () => {
            try {
                const latest = await getTask(state.taskId);
                paint(latest, training);
            } catch (err) {
                console.warn(err);
            }
        }, 1600);
    }

    function stopWatch() {
        if (state.polling) clearInterval(state.polling);
        if (state.unsubscribe) state.unsubscribe();
        state.polling = null;
        state.unsubscribe = null;
    }

    function paint(task, training) {
        const st = statusMeta(task.status);
        progressBox.innerHTML = `<div class="card" style="padding:14px;background:var(--bg-soft)">
            <div class="row between" style="margin-bottom:8px">
                <div class="row" style="gap:8px">
                    <b class="small">${escapeHtml(training?.name || task.title)}</b>
                    <span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${st.label}</span>
                </div>
                <b class="small">${task.progress}%</b>
            </div>
            ${progressBar(task.progress, task.status === 'failed' ? 'danger' : task.status === 'succeeded' ? 'ok' : '')}
            <div class="small muted" style="margin-top:8px">${escapeHtml((task.logs || []).slice(-1)[0]?.msg || '等待调度')}</div>
            ${task.status === 'succeeded' ? `<div class="row" style="gap:8px;margin-top:10px">
                <a class="btn btn-sm btn-primary" href="${url('tasks.html')}?id=${task.id}">${icon('check', 13)}查看产物</a>
                <a class="btn btn-sm btn-outline" href="${url('assets/my-assets-model.html')}">${icon('cpu', 13)}我的模型</a>
            </div>` : ''}
            ${task.status === 'failed' ? `<div class="small" style="margin-top:8px;color:var(--danger)">${escapeHtml(task.error || '训练失败，算力已退还')}</div>` : ''}
        </div>`;
        if (!['queued', 'running'].includes(task.status)) {
            stopWatch();
            if (task.status === 'succeeded') {
                window.setTimeout(async () => {
                    const next = await getAccount();
                    balanceText.textContent = num(next.credits);
                    const fresh = await listTrainings();
                    jobList.innerHTML = fresh.trainings.map(jobCard).join('') || emptyState({ title: '还没有训练任务' });
                }, 800);
            }
        }
    }

    function showDetail(training) {
        openModal({
            title: `训练详情 · ${training.name}`,
            body: `<div class="col" style="gap:12px">
                <div class="row wrap" style="gap:8px">
                    <span class="badge ${statusMeta(training.status).tone ? `badge-${statusMeta(training.status).tone}` : ''}">${statusMeta(training.status).label}</span>
                    <span class="tag">触发词 ${escapeHtml(training.trigger)}</span>
                    <span class="tag">${escapeHtml(training.config.base)}</span>
                    <span class="tag">Rank ${training.config.rank}</span>
                    <span class="tag">${num(training.config.steps)} 步</span>
                </div>
                <dl class="param-list">
                    <dt>数据集</dt><dd>${escapeHtml(training.dataset?.name || '-')}（${training.dataset?.count || 0} 张）</dd>
                    <dt>学习率</dt><dd>${training.config.lr}</dd>
                    <dt>批次大小</dt><dd>${training.config.batch}</dd>
                    <dt>优化器</dt><dd>${escapeHtml(training.config.optimizer)}</dd>
                    <dt>创建时间</dt><dd>${timeAgo(training.createdAt)}</dd>
                    <dt>耗时</dt><dd>${training.durationMin ? `${training.durationMin} 分钟` : '—'}</dd>
                    <dt>最终 loss</dt><dd>${training.loss.length ? training.loss[training.loss.length - 1].loss : '—'}</dd>
                </dl>
                ${training.loss.length ? `<div>
                    <div class="label" style="margin-bottom:6px">Loss 曲线</div>
                    <div class="loss-chart">${lossChart(training.loss)}</div>
                </div>` : ''}
                <div class="log-panel">
                    ${(training.task?.logs || []).slice(-10).map((l) => `<div class="log-line"><span class="t">${escapeHtml(l.t || '')}</span><span class="m">${escapeHtml(l.msg || '')}</span></div>`).join('') || '<div class="small muted">暂无日志</div>'}
                </div>
            </div>`,
            footer: training.modelId
                ? `<a class="btn btn-primary" href="${url('assets/model-detail.html')}?id=${training.modelId}">查看模型资产</a>`
                : '<button class="btn btn-outline" data-close>关闭</button>'
        });
    }

    await getAccount().then((a) => {
        balanceText.textContent = num(a.credits);
    }).catch(() => {});
}

function statCard(label, value, sub, iconName) {
    return `<div class="metric">
        <div class="row" style="gap:8px">
            <span style="width:28px;height:28px;border-radius:8px;background:var(--brand-50);color:var(--brand-600);display:inline-flex;align-items:center;justify-content:center">${icon(iconName, 14)}</span>
            <span class="metric-label">${escapeHtml(label)}</span>
        </div>
        <div class="metric-value">${typeof value === 'number' ? num(value) : escapeHtml(String(value))}</div>
        <div class="metric-trend">${escapeHtml(sub)}</div>
    </div>`;
}

function jobCard(training) {
    const st = statusMeta(training.status);
    const task = training.task;
    const lastLog = task?.logs?.slice(-1)[0]?.msg || '等待调度';
    return `<div class="job-card ${['queued', 'running'].includes(training.status) ? 'running' : ''}" data-job="${training.id}">
        <div class="row between" style="align-items:flex-start">
            <div style="min-width:0">
                <div class="row" style="gap:6px;flex-wrap:wrap">
                    <b style="font-size:13px">${escapeHtml(training.name)}</b>
                    <span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${st.label}</span>
                </div>
                <div class="small muted" style="margin-top:3px">
                    ${escapeHtml(training.config.base)} · Rank ${training.config.rank} · ${num(training.config.steps)} 步 · ${timeAgo(training.createdAt)}
                </div>
            </div>
            <span class="tag mono">${escapeHtml(training.trigger)}</span>
        </div>
        ${['queued', 'running'].includes(training.status) ? `
            <div style="margin:8px 0 4px">${progressBar(task?.progress || 0)}</div>
            <div class="small muted ellipsis">${escapeHtml(lastLog)}</div>` : ''}
        ${training.status === 'succeeded' ? `<div class="row small" style="gap:10px;margin-top:8px;color:var(--ok)">
            ${icon('check', 13)} 训练完成 · 最终 loss ${training.loss.length ? training.loss[training.loss.length - 1].loss : '—'}
        </div>` : ''}
        ${training.status === 'failed' ? `<div class="row small" style="gap:8px;margin-top:8px;color:var(--danger)">
            ${icon('alert', 13)} ${escapeHtml(training.error || '训练异常终止，算力已退还')}
        </div>` : ''}
        <div class="row" style="gap:6px;margin-top:10px">
            <button class="btn btn-sm btn-ghost" data-detail="${training.id}">${icon('info', 13)}详情</button>
            <button class="btn btn-sm btn-ghost" data-copy="${escapeHtml(training.trigger)}">${icon('copy', 13)}触发词</button>
            <span class="spacer"></span>
            ${training.modelId ? `<button class="btn btn-sm btn-outline" data-model="${training.modelId}">${icon('cpu', 13)}模型资产</button>` : ''}
        </div>
    </div>`;
}

function lossChart(points) {
    if (!points.length) return '';
    const w = 320;
    const h = 84;
    const max = Math.max(...points.map((p) => p.loss));
    const min = Math.min(...points.map((p) => p.loss));
    const span = max - min || 1;
    const path = points.map((p, i) => {
        const x = (i / Math.max(1, points.length - 1)) * w;
        const y = h - ((p.loss - min) / span) * (h - 8) - 4;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
        <path d="${path}" fill="none" stroke="var(--brand)" stroke-width="1.6"/>
        <path d="${path} L${w},${h} L0,${h} Z" fill="var(--brand-50)" opacity=".7"/>
    </svg>`;
}
