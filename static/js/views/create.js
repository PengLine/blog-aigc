import { KINDS, SUBTYPES, MODELS, RATIOS, MODEL_MAP, SAMPLERS, taskCost } from '../core/constants.js';
import { createWork, updateWork, submitWork, getWork, listAssets, createTask, startDrama } from '../core/api.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast, imgTag, kindBadge, readFileAsDataURL, progressBar } from '../core/ui.js';
import { escapeHtml, num, timeAgo } from '../core/format.js';
import { on, EVENTS } from '../core/bus.js';
import {
    DURATION_OPTIONS, LONG_FORM_MIN, isLongForm, profileFor, videoCost, scriptCost, composeCost,
    splitBeats, planShotCount, distributeSeconds, suggestDuration
} from '../core/drama.js';

const CREATE_KINDS = ['character', 'prop', 'scenic', 'video', 'model'];

const COPY = {
    character: { title: '创建角色', sub: '沉淀可复用的角色形象与设定，支持短剧与绘本引用', prompt: '白发少女，全息夹克，机械右臂，赛博朋克风格，三视图' },
    prop: { title: '创建道具', sub: '武器、饰品、载具等可复用物件，含多角度与拆解图', prompt: '黄铜机械蝴蝶，齿轮结构，微距产品摄影，深色背景' },
    scenic: { title: '创建景点', sub: '场景与环境背景，可作为短剧外景或故事发生地', prompt: '雨夜霓虹街道，积水反射招牌灯光，电影感宽幅' },
    video: { title: '创建短剧', sub: '组合角色、道具与景点，产出可发布的竖屏或横屏短剧', prompt: '废弃空间站走廊，冷蓝色灯光，信使苏醒，电影感' },
    model: { title: '创建模型', sub: '上传或登记 LoRA / 风格模型，供工作流与应用调用', prompt: '人像样张，柔和窗光，85mm，胶片质感' }
};

export async function render(host, ctx) {
    const kind = ctx.params.kind || 'character';
    const kindInfo = KINDS[kind] || KINDS.character;
    const copy = COPY[kind] || COPY.character;
    setPageTitle(copy.title);

    let editing = null;
    let source = null;
    if (ctx.query.edit) {
        try {
            editing = (await getWork(ctx.query.edit)).work;
        } catch (err) {
            toast(err.message, 'error');
        }
    }
    if (ctx.query.from) {
        try {
            source = (await getWork(ctx.query.from)).work;
        } catch (err) {
            toast('灵感来源作品不可用，已按空白表单创建', 'warn');
        }
    }

    // 支持从任务详情「再创作」携带 ?prompt= / ?model= / ?negative= 直接进入创作台
    const preset = {
        prompt: String(ctx.query.prompt || '').slice(0, 800),
        negative: String(ctx.query.negative || '').slice(0, 300),
        model: MODEL_MAP[ctx.query.model] ? String(ctx.query.model) : ''
    };

    const defaults = {
        // 视频必须默认选视频模型，否则时长档位与实际下单模型不是同一个口径
        model: preset.model || source?.params?.model || (kind === 'video' ? 'kling-v' : 'lingxi-xl'),
        steps: source?.params?.steps || 28,
        cfg: source?.params?.cfg || 6.5,
        seed: source?.params?.seed || Math.floor(Math.random() * 900000) + 100000,
        ratio: source?.params?.ratio || (kind === 'video' ? '9:16' : '4:3'),
        sampler: source?.params?.sampler || SAMPLERS[0]
    };
    const state = {
        kind,
        cover: editing?.cover || (source?.cover || ''),
        tags: editing?.tags ? [...editing.tags] : source?.tags?.slice(0, 3) || [],
        outputs: [],
        taskId: null,
        generating: false,
        assetRefs: editing?.assetRefs || { character: [], prop: [], scenic: [] },
        priceMode: editing?.price?.mode || 'free',
        priceAmount: editing?.price?.amount || 10,
        visibility: editing?.visibility || 'public',
        params: { ...defaults, ...(source?.params || {}), ...(editing?.params || {}), ...(preset.model ? { model: preset.model } : {}) },
        // 新建默认交给「自动推算」，只有编辑已有作品时才回显它当初的实际时长
        duration: editing?.duration || (kind === 'video' ? 'auto' : 5)
    };
    if (state.cover) state.outputs = [{ type: kind === 'video' ? 'video' : 'image', url: state.cover, title: '当前封面' }];
    // 已经走过分镜流水线的长剧本成片：回工作台改分镜，不在快速表单里重复一套编辑入口
    if (kind === 'video' && editing?.meta?.dramaId && isLongForm(editing.duration)) {
        host.innerHTML = `<div class="card" style="padding:20px"><div class="small muted">正在打开该项目的工作台…</div></div>`;
        window.location.replace(url(`assets/create-video.html?drama=${encodeURIComponent(editing.meta.dramaId)}&long=1`));
        return;
    }

    let assetPool = { character: [], prop: [], scenic: [] };
    if (kind === 'video') {
        const res = await listAssets({ pageSize: 100, kind: 'all' });
        ['character', 'prop', 'scenic'].forEach((k) => {
            assetPool[k] = res.items.filter((a) => a.kind === k);
        });
    }

    const switchQuery = ctx.query.edit
        ? `?edit=${encodeURIComponent(ctx.query.edit)}`
        : ctx.query.from
            ? `?from=${encodeURIComponent(ctx.query.from)}`
            : preset.prompt
                ? `?prompt=${encodeURIComponent(preset.prompt)}${preset.model ? `&model=${encodeURIComponent(preset.model)}` : ''}`
                : '';
    const typeSwitch = `<div class="chips" style="margin-bottom:16px">
        ${CREATE_KINDS.map((k) => `<a class="chip ${k === kind ? 'active' : ''}" href="${url(KINDS[k].create)}${switchQuery}">
            ${icon(KINDS[k].icon, 14)}${KINDS[k].name}
        </a>`).join('')}
    </div>`;

    host.innerHTML = `
        <div class="page-head">
            <div class="page-head-main">
                <h1 class="page-title">${copy.title}
                    ${editing ? `<span class="badge badge-warn">编辑中 v${editing.version}</span>` : `<span class="badge badge-brand">新建</span>`}</h1>
                <div class="page-sub">${copy.sub}</div>
            </div>
            <div class="page-actions">
                <a class="btn btn-outline" href="${url(kindInfo.mine)}">${icon('layers', 15)}我的${kindInfo.plural}</a>
                <button class="btn btn-outline" id="saveDraft">保存草稿</button>
                <button class="btn btn-primary" id="publishBtn">${icon('upload', 15)}提交发布</button>
            </div>
        </div>
        ${typeSwitch}

        ${source ? `<div class="card" style="padding:10px 14px;margin-bottom:14px;background:var(--brand-50);border-color:var(--brand-100)">
            <div class="row small" style="color:var(--brand-700)">${icon('sparkles', 15)}
                <span>正在基于「${escapeHtml(source.title)}」进行同款创作，提示词与参数已预填。</span>
                <span class="spacer"></span>
                <a href="${url(`${KINDS[source.kind].detail}?id=${source.id}`)}" style="color:var(--brand-700)">查看原作品</a>
            </div>
        </div>` : ''}

        <div class="create-wrap">
            <div class="card">
                <div class="form-section">
                    <div class="section-head"><span class="n">1</span><h3>基础信息</h3><span class="spacer"></span>
                        <span class="small muted">公开后将展示在作品广场</span>
                    </div>
                    <div class="form-grid">
                        <div class="field span-2">
                            <label class="label" for="fTitle">${kindInfo.name}名称 <span class="req">*</span>
                                <span class="hint-inline">建议 6-20 字，包含题材关键词</span>
                            </label>
                            <input class="input" id="fTitle" maxlength="40" placeholder="例如：赛博义体少女·岚"
                                value="${escapeHtml(editing?.title || (source ? `${source.title} · 同款` : ''))}">
                        </div>
                        <div class="field">
                            <label class="label" for="fSubtype">题材分类</label>
                            <select class="select" id="fSubtype">
                                ${SUBTYPES.map((s) => `<option value="${s.id}" ${(editing?.subtype || source?.subtype) === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}
                            </select>
                        </div>
                        <div class="field">
                            <label class="label">标签 <span class="hint-inline">最多 8 个</span></label>
                            <div class="tag-input" id="tagInput">
                                <span class="row wrap" id="tagChips" style="gap:6px"></span>
                                <input id="tagField" placeholder="输入后回车添加" maxlength="12">
                            </div>
                        </div>
                        <div class="field span-2">
                            <label class="label" for="fDesc">描述</label>
                            <textarea class="textarea" id="fDesc" maxlength="300" placeholder="说明这个${kindInfo.name}的设定、使用场景与创作思路">${escapeHtml(editing?.desc || '')}</textarea>
                        </div>
                    </div>
                </div>

                <div class="form-section">
                    <div class="section-head"><span class="n">2</span><h3>素材与生成</h3><span class="spacer"></span>
                        <span class="cost-pill" id="costPill">${icon('credit', 13)} 生成消耗 ${taskCost(kind === 'video' ? 'video' : 'image', state.params)} 算力</span>
                    </div>
                    <div class="cover-picker">
                        <div>
                            <div class="cover-box" id="coverBox">
                                ${state.cover ? imgTag(state.cover, '封面') : `${icon('image', 26)}<span class="small" style="margin-top:6px">暂无封面</span>`}
                            </div>
                            <label class="btn btn-outline btn-sm btn-block" style="margin-top:8px">
                                ${icon('upload', 14)}上传封面
                                <input type="file" id="coverFile" accept="image/*" hidden>
                            </label>
                        </div>
                        <div>
                            <div class="field">
                                <label class="label" for="fPrompt"><span id="promptLabel">提示词 <span class="req">*</span>
                                    <span class="hint-inline">支持中文，越具体越好</span></span>
                                </label>
                                <textarea class="textarea" id="fPrompt" placeholder="描述主体、环境、光线与风格">${escapeHtml(editing?.prompt || source?.prompt || preset.prompt || copy.prompt)}</textarea>
                                <div class="small hidden" id="scriptHint" style="margin-top:6px;color:var(--brand-700);line-height:1.7"></div>
                            </div>
                            <div class="field">
                                <label class="label" for="fNegative">负面提示词</label>
                                <input class="input" id="fNegative" value="${escapeHtml(editing?.negative || source?.negative || preset.negative || 'low quality, blurry, watermark, extra fingers')}">
                            </div>
                            <div class="form-grid">
                                <div class="field">
                                    <label class="label" for="fModel">生成模型</label>
                                    <select class="select" id="fModel">
                                        ${MODELS.filter((m) => (kind === 'video' ? m.kind === 'video' : m.kind === 'image')).map((m) => `<option value="${m.id}" ${state.params.model === m.id ? 'selected' : ''}>${m.name} · ${m.cost} 算力</option>`).join('')}
                                    </select>
                                </div>
                                <div class="field">
                                    <label class="label" for="fRatio">画幅比例</label>
                                    <select class="select" id="fRatio">
                                        ${RATIOS.map((r) => `<option value="${r.id}" ${state.params.ratio === r.id ? 'selected' : ''}>${r.label}（${r.w}×${r.h}）</option>`).join('')}
                                    </select>
                                </div>
                                ${kind === 'video' ? `<div class="field">
                                    <label class="label" for="fDuration">视频时长 <span class="hint-inline" id="durationHint"></span></label>
                                    <select class="select" id="fDuration">
                                        <option value="auto" ${state.duration === 'auto' ? 'selected' : ''}>自动 · 按剧本推算</option>
                                        ${DURATION_OPTIONS.map((d) => `<option value="${d}" ${Number(state.duration) === d ? 'selected' : ''}>${d} 秒${d > LONG_FORM_MIN ? ' · 分镜工作台' : ''}</option>`).join('')}
                                        ${legacyDurationOption()}
                                    </select>
                                </div>` : `<div class="field">
                                    <label class="label" for="fSteps">采样步数 <span class="hint-inline" id="stepsLabel">${state.params.steps}</span></label>
                                    <input class="range" type="range" id="fSteps" min="8" max="50" step="1" value="${state.params.steps}">
                                </div>`}
                                <div class="field">
                                    <label class="label" for="fCfg">CFG Scale</label>
                                    <input class="input" type="number" id="fCfg" min="1" max="20" step="0.5" value="${state.params.cfg}">
                                </div>
                                <div class="field">
                                    <label class="label" for="fSeed">随机种子 <button class="small" id="reseed" style="margin-left:auto;color:var(--brand)">随机</button></label>
                                    <input class="input mono" type="number" id="fSeed" value="${state.params.seed}">
                                </div>
                            </div>
                            <div class="row">
                                <button class="btn btn-primary" id="generateBtn">${icon('sparkles', 15)}AI 生成封面</button>
                                <span class="small muted" id="genHint">生成任务会进入任务中心，可随时离开页面</span>
                            </div>
                            <div id="genProgress" class="mt-12 hidden"></div>
                            <div id="genResults" class="gen-grid mt-12"></div>
                        </div>
                    </div>
                </div>

                ${kind === 'model' ? `<div class="form-section">
                    <div class="section-head"><span class="n">3</span><h3>模型信息</h3><span class="spacer"></span>
                        <a class="small" href="${url('lora-train.html')}" style="color:var(--brand)">通过训练生成模型 ${icon('chevron-right', 12)}</a>
                    </div>
                    <div class="form-grid">
                        <div class="field"><label class="label">底模</label>
                            <select class="select" id="mBase">
                                ${['SDXL 1.0', 'SD 1.5', 'FLUX.1 dev', 'SDXL Turbo'].map((b) => `<option ${editing?.meta?.base === b ? 'selected' : ''}>${b}</option>`).join('')}
                            </select>
                        </div>
                        <div class="field"><label class="label">触发词</label>
                            <input class="input mono" id="mTrigger" value="${escapeHtml(editing?.meta?.trigger || '')}" placeholder="例如 lxportrait">
                        </div>
                        <div class="field"><label class="label">Rank</label>
                            <input class="input" type="number" id="mRank" value="${editing?.meta?.rank ?? 32}" min="4" max="128">
                        </div>
                        <div class="field"><label class="label">训练步数</label>
                            <input class="input" type="number" id="mSteps" value="${editing?.meta?.steps ?? 4200}" min="500" step="100">
                        </div>
                    </div>
                </div>` : ''}

                ${kind === 'video' ? `<div class="form-section">
                    <div class="section-head"><span class="n">3</span><h3>关联资产</h3><span class="spacer"></span>
                        <span class="small muted">短剧将引用这些资产，保证形象与场景一致</span>
                    </div>
                    ${['character', 'prop', 'scenic'].map((refKind) => `<div class="field">
                        <label class="label">${KINDS[refKind].plural}</label>
                        <div class="chips" data-ref-group="${refKind}">
                            ${assetPool[refKind].length ? assetPool[refKind].map((a) => `<button class="chip ${state.assetRefs[refKind]?.includes(a.id) ? 'active' : ''}" data-ref-id="${a.id}" data-ref-kind="${refKind}">
                                ${escapeHtml(a.title)}
                            </button>`).join('') : `<span class="small muted">还没有${KINDS[refKind].plural}资产，<a href="${url(KINDS[refKind].create)}">去创建</a></span>`}
                        </div>
                    </div>`).join('')}
                </div>` : ''}

                <div class="form-section">
                    <div class="section-head"><span class="n">${kind === 'video' || kind === 'model' ? '4' : '3'}</span><h3>发布与授权</h3></div>
                    <div class="form-grid">
                        <div class="field">
                            <label class="label">可见范围</label>
                            <div class="radio-cards" id="visibilityGroup">
                                <div class="radio-card ${state.visibility === 'public' ? 'active' : ''}" data-visibility="public">
                                    <div class="rc-title">公开</div><div class="rc-desc">出现在广场，可被复刻</div>
                                </div>
                                <div class="radio-card ${state.visibility === 'private' ? 'active' : ''}" data-visibility="private">
                                    <div class="rc-title">仅自己</div><div class="rc-desc">仅资产库可见</div>
                                </div>
                            </div>
                        </div>
                        <div class="field">
                            <label class="label">使用授权</label>
                            <div class="radio-cards" id="priceGroup">
                                ${[['free', '免费'], ['credits', '算力'], ['license', '商业']].map(([id, label]) => `<div class="radio-card ${state.priceMode === id ? 'active' : ''}" data-price="${id}">
                                    <div class="rc-title">${label}</div><div class="rc-desc">${id === 'free' ? '所有人可用' : id === 'credits' ? '按次扣费' : '一次性授权'}</div>
                                </div>`).join('')}
                            </div>
                            <div class="input-group mt-8 ${state.priceMode === 'free' ? 'hidden' : ''}" id="priceAmountWrap">
                                <input class="input" type="number" min="1" id="priceAmount" value="${state.priceAmount}">
                                <span class="btn btn-outline" style="pointer-events:none">${state.priceMode === 'license' ? '元' : '算力'}</span>
                            </div>
                        </div>
                    </div>
                    <div class="small muted" style="margin-top:8px;line-height:1.7">
                        提交后将进入内容安全审核（通常 1 分钟内完成）。涉及真实地标、血腥暴力等内容会被退回。
                    </div>
                </div>
            </div>

            <aside class="create-side">
                <div class="card" style="overflow:hidden">
                    <div class="preview-media" id="previewMedia">${state.cover ? imgTag(state.cover, '预览') : ''}</div>
                    <div class="card-body">
                        <div class="row" style="gap:6px">${kindBadge(kind)} <span class="badge">预览</span></div>
                        <h3 style="font-size:15px;margin-top:8px" id="previewTitle">${escapeHtml(editing?.title || '未命名' + kindInfo.name)}</h3>
                        <div class="row wrap" style="gap:5px;margin-top:6px" id="previewTags"></div>
                        <div class="row small muted" style="margin-top:10px;gap:6px">${icon('user', 13)} 林澈 · ${timeAgo(new Date().toISOString())}</div>
                    </div>
                </div>
                <div class="card">
                    <div class="card-head"><div class="card-title">发布检查</div></div>
                    <div class="card-body col" style="gap:9px" id="checklist"></div>
                </div>
                <div class="card">
                    <div class="card-body">
                        <div class="row between small"><span class="muted">生成模型</span><b id="sumModel">${MODEL_MAP[state.params.model]?.name || '-'}</b></div>
                        <div class="row between small mt-8"><span class="muted">预计成本</span><b class="cost-pill" id="sumCost">${taskCost(kind === 'video' ? 'video' : 'image', state.params)} 算力</b></div>
                        <div class="row between small mt-8"><span class="muted">当前余额</span><b id="sumBalance">-</b></div>
                        <div class="divider"></div>
                        <button class="btn btn-primary btn-block" id="publishBtn2">${icon('upload', 15)}提交发布</button>
                        <button class="btn btn-outline btn-block mt-8" id="saveDraft2">保存草稿</button>
                    </div>
                </div>
            </aside>
        </div>`;

    /* ---------------- 状态渲染 ---------------- */
    const $ = (sel) => host.querySelector(sel);

    function renderTags() {
        const hostEl = $('#tagChips');
        if (!hostEl) return;
        hostEl.innerHTML = state.tags.map((t) => `<span class="tag tag-brand">${escapeHtml(t)}<button data-del-tag="${escapeHtml(t)}">×</button></span>`).join('');
        const previewTags = $('#previewTags');
        if (previewTags) previewTags.innerHTML = state.tags.slice(0, 3).map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('');
        hostEl.querySelectorAll('[data-del-tag]').forEach((btn) => {
            btn.addEventListener('click', () => {
                state.tags = state.tags.filter((t) => t !== btn.dataset.delTag);
                renderTags();
                renderChecklist();
            });
        });
    }

    function renderCover() {
        $('#coverBox').innerHTML = state.cover
            ? imgTag(state.cover, '封面')
            : `${icon('image', 26)}<span class="small" style="margin-top:6px">暂无封面</span>`;
        $('#previewMedia').innerHTML = state.cover ? imgTag(state.cover, '预览') : '';
    }

    function renderOutputs() {
        const box = $('#genResults');
        if (!state.outputs.length) {
            box.innerHTML = `<div class="gen-placeholder">点击「AI 生成封面」<br>或上传本地图片</div>`;
            return;
        }
        box.innerHTML = state.outputs.map((out, i) => `<div class="gen-item ${out.url === state.cover ? 'active' : ''}" data-out="${i}">
            ${out.type === 'text' ? `<div class="gen-placeholder" style="border:none;background:var(--surface)"><span class="small">${escapeHtml(out.title)}<br>文本结果</span></div>` : imgTag(out.url, out.title || '生成结果')}
            <span class="pick">${out.url === state.cover ? '已选为封面' : '设为封面'}</span>
        </div>`).join('');
        box.querySelectorAll('[data-out]').forEach((el) => {
            el.addEventListener('click', () => {
                const out = state.outputs[Number(el.dataset.out)];
                if (!out?.url) return;
                state.cover = out.url;
                renderCover();
                renderOutputs();
                renderChecklist();
                toast('已设为封面', 'success', 1200);
            });
        });
    }

    function renderChecklist() {
        const title = $('#fTitle').value.trim();
        const desc = $('#fDesc').value.trim();
        const items = [
            { ok: !!title, text: '填写资产名称' },
            { ok: !!state.cover, text: '准备封面素材' },
            { ok: desc.length >= 8, text: '描述不少于 8 个字' },
            { ok: state.tags.length > 0, text: '至少添加 1 个标签' }
        ];
        $('#checklist').innerHTML = items.map((i) => `<div class="row small" style="gap:8px;color:${i.ok ? 'var(--ok)' : 'var(--muted)'}">
            ${icon(i.ok ? 'check' : 'alert', 14)}<span>${i.text}</span>
        </div>`).join('');
    }

    /** 老作品（含种子数据）的时长可能不在标准档位里，补一个原样沿用的选项，避免下拉默默改掉原值 */
    function legacyDurationOption() {
        const d = Number(state.duration);
        if (!Number.isFinite(d) || d <= 0 || DURATION_OPTIONS.includes(d)) return '';
        return `<option value="${d}" selected>${d} 秒 · 沿用原时长</option>`;
    }

    /** 视频成本口径：≤ 15 秒一条任务；> 15 秒拆成「解析 + 逐镜头 + 合成」三段合计 */
    function videoEstimate() {
        const model = $('#fModel')?.value || 'kling-v';
        const selected = $('#fDuration')?.value || 'auto';
        const script = ($('#fPrompt')?.value || '').trim();
        // 「自动」档先按剧本规模推算，长/短分流由推算结果决定，而不是由用户先猜一个档位
        const suggest = selected === 'auto' ? suggestDuration(script, model) : null;
        const duration = suggest ? (suggest.seconds || 5) : Number(selected) || 5;
        if (!isLongForm(duration)) return { long: false, auto: Boolean(suggest), suggest, duration, model, cost: videoCost(model, duration) };
        const p = profileFor(model);
        const beats = script ? splitBeats(script).length : 0;
        const count = planShotCount(duration, beats || Math.max(3, Math.ceil(duration / p.maxShot)), p.maxShot);
        const secs = distributeSeconds(duration, count, p.maxShot);
        const shotCost = secs.reduce((sum, s) => sum + videoCost(model, s), 0);
        const parse = scriptCost(duration, script.length);
        const compose = composeCost(duration, count);
        return { long: true, auto: Boolean(suggest), suggest, duration, model, count, secs, parse, shotCost, compose, cost: parse + shotCost + compose };
    }

    function renderSummary() {
        const est = kind === 'video' ? videoEstimate() : { long: false, cost: taskCost('image', { model: $('#fModel').value }) };
        const model = MODEL_MAP[$('#fModel').value];
        $('#sumModel').textContent = model ? model.name : '-';
        $('#sumCost').textContent = `${est.cost} 算力`;
        $('#costPill').innerHTML = est.long
            ? `${icon('credit', 13)} 全流程预估 ${est.cost} 算力（解析 ${est.parse} + ${est.count} 镜头 ${est.shotCost} + 合成 ${est.compose}）`
            : `${icon('credit', 13)} 生成消耗 ${est.cost} 算力`;
        $('#previewTitle').textContent = $('#fTitle').value.trim() || `未命名${kindInfo.name}`;
    }

    /** 长短剧分流：超过 15 秒时把表单语义改为「剧本」，发布按钮隐去，改由工作台引导 */
    function syncLongMode() {
        if (kind !== 'video') return renderSummary();
        const est = videoEstimate();
        const long = est.long;
        $('#promptLabel').innerHTML = long
            ? `剧本 / 分场大纲 <span class="req">*</span><span class="hint-inline">按 。！？；与换行切分节拍，一句通常落成一个镜头</span>`
            : `提示词 <span class="req">*</span><span class="hint-inline">支持中文，越具体越好</span>`;
        $('#fPrompt').placeholder = long
            ? '1. 开场：交代时空\n2. 推进：出现阻碍\n3. 转折：关键动作\n4. 收束：留下悬念'
            : '描述主体、环境、光线与风格';
        $('#durationHint').textContent = est.auto
            ? (est.suggest.seconds ? `自动推算 · ${est.duration} 秒` : '填写剧本后自动推算')
            : (long ? `长剧本模式（> ${LONG_FORM_MIN} 秒）` : '');
        const hint = $('#scriptHint');
        hint.classList.toggle('hidden', !long);
        hint.innerHTML = long
            ? `${icon('info', 13)}` +
              `${est.auto ? ` 时长已按剧本规模自动推算：${est.suggest.reason}。想更短或更长，可在「视频时长」里改成手动档位。<br>` : ''}` +
              `${est.duration} 秒短剧会拆成约 ${est.count} 个镜头逐段生成：解析 → 审核修改 → 逐镜头下单 → 合成成片。项目在工作台里保存，成片合成后自动创建作品记录。`
            : '';
        $('#genHint').textContent = long ? '解析任务会进入任务中心，可随时离开页面续做' : '生成任务会进入任务中心，可随时离开页面';
        $('#generateBtn').innerHTML = long ? `${icon('wand', 15)}解析剧本 · 进入分镜工作台` : `${icon('sparkles', 15)}AI 生成封面`;
        ['#publishBtn', '#publishBtn2', '#saveDraft', '#saveDraft2'].forEach((sel) => {
            const el = $(sel);
            if (el) el.style.display = long ? 'none' : '';
        });
        return renderSummary();
    }

    async function refreshBalance() {
        try {
            const res = await fetchBalance();
            $('#sumBalance').textContent = `${num(res)} 算力`;
        } catch (err) {
            $('#sumBalance').textContent = '-';
        }
    }

    /* ---------------- 事件绑定 ---------------- */
    $('#tagField')?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const value = e.target.value.trim().replace(/^#/, '');
        if (!value) return;
        if (state.tags.length >= 8) {
            toast('最多添加 8 个标签', 'warn');
            return;
        }
        if (!state.tags.includes(value)) state.tags.push(value);
        e.target.value = '';
        renderTags();
        renderChecklist();
    });

    $('#coverFile')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const result = await readFileAsDataURL(file);
            state.cover = result.url;
            state.outputs.unshift({ type: 'image', url: result.url, title: result.name });
            renderCover();
            renderOutputs();
            renderChecklist();
            toast(result.simulated ? '图片较大，已使用占位预览（演示环境）' : '封面已上传', 'success');
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    $('#reseed')?.addEventListener('click', () => {
        $('#fSeed').value = Math.floor(Math.random() * 900000) + 100000;
    });

    $('#fSteps')?.addEventListener('input', (e) => {
        $('#stepsLabel').textContent = e.target.value;
    });

    $('#fModel')?.addEventListener('change', syncLongMode);
    $('#fDuration')?.addEventListener('change', syncLongMode);
    $('#fPrompt')?.addEventListener('input', syncLongMode);
    $('#fTitle')?.addEventListener('input', () => {
        $('#previewTitle').textContent = $('#fTitle').value.trim() || `未命名${kindInfo.name}`;
        renderChecklist();
    });
    $('#fDesc')?.addEventListener('input', renderChecklist);

    host.querySelectorAll('[data-visibility]').forEach((el) => {
        el.addEventListener('click', () => {
            state.visibility = el.dataset.visibility;
            host.querySelectorAll('[data-visibility]').forEach((x) => x.classList.toggle('active', x === el));
        });
    });

    host.querySelectorAll('[data-price]').forEach((el) => {
        el.addEventListener('click', () => {
            state.priceMode = el.dataset.price;
            host.querySelectorAll('[data-price]').forEach((x) => x.classList.toggle('active', x === el));
            $('#priceAmountWrap').classList.toggle('hidden', state.priceMode === 'free');
        });
    });

    host.querySelectorAll('[data-ref-id]').forEach((el) => {
        el.addEventListener('click', () => {
            const refKind = el.dataset.refKind;
            const id = el.dataset.refId;
            const list = state.assetRefs[refKind] || (state.assetRefs[refKind] = []);
            const idx = list.indexOf(id);
            if (idx >= 0) list.splice(idx, 1);
            else list.push(id);
            el.classList.toggle('active', idx < 0);
        });
    });

    /* ---------------- AI 生成 ---------------- */
    /** 长剧本：不直接下单视频，而是建项目 + 下解析单，后续四步在工作台完成 */
    async function startLongProject() {
        const est = videoEstimate();
        const title = $('#fTitle').value.trim();
        if (!title) {
            toast('请填写短剧名称', 'warn');
            $('#fTitle').focus();
            return;
        }
        const btn = $('#generateBtn');
        btn.classList.add('loading');
        try {
            const res = await startDrama({
                title,
                script: $('#fPrompt').value.trim(),
                targetSec: est.duration,
                model: est.model,
                ratio: $('#fRatio').value,
                negative: $('#fNegative').value.trim(),
                assetRefs: state.assetRefs
            });
            toast(`解析任务已创建，消耗 ${res.task.cost} 算力`, 'success');
            setTimeout(() => {
                window.location.href = url(`assets/create-video.html?drama=${encodeURIComponent(res.drama.id)}&long=1`);
            }, 420);
        } catch (err) {
            toast(err.message, 'error');
            btn.classList.remove('loading');
        }
    }

    $('#generateBtn')?.addEventListener('click', async () => {
        if (state.generating) return;
        const prompt = $('#fPrompt').value.trim();
        if (!prompt) {
            toast(kind === 'video' && videoEstimate().long ? '请先填写剧本' : '请先填写提示词', 'warn');
            $('#fPrompt').focus();
            return;
        }
        if (kind === 'video' && videoEstimate().long) {
            if (prompt.length < 20) {
                toast('剧本至少 20 个字，才能切出可用的叙事节拍', 'warn');
                return;
            }
            await startLongProject();
            return;
        }
        const btn = $('#generateBtn');
        btn.classList.add('loading');
        state.generating = true;
        try {
            const payload = {
                prompt,
                negative: $('#fNegative').value.trim(),
                model: $('#fModel').value,
                ratio: $('#fRatio').value,
                steps: Number($('#fSteps')?.value || 28),
                cfg: Number($('#fCfg').value || 6.5),
                seed: Number($('#fSeed').value),
                kind,
                // 下拉选「自动」时，下单用的就是推算出来的那个秒数，与页面预估同一口径
                duration: kind === 'video' ? videoEstimate().duration : 0
            };
            const type = kind === 'video' ? 'video' : 'image';
            const task = await createTask({
                type,
                title: `${$('#fTitle').value.trim() || kindInfo.name} · ${kind === 'video' ? '视频' : '封面图'}`,
                payload,
                cost: taskCost(type, payload)
            });
            state.taskId = task.id;
            showProgress(task);
            toast(`任务已创建，消耗 ${task.cost} 算力`, 'success');
            watchTask(task.id);
            refreshBalance();
        } catch (err) {
            toast(err.message, 'error');
            btn.classList.remove('loading');
            state.generating = false;
        }
    });

    function showProgress(task) {
        const box = $('#genProgress');
        box.classList.remove('hidden');
        box.innerHTML = `<div class="card" style="padding:12px">
            <div class="row between small"><span class="row" style="gap:6px">${icon('clock', 13)}生成任务 ${task.status === 'queued' ? '排队中' : '执行中'}</span><b id="taskPct">${task.progress}%</b></div>
            <div id="taskBarWrap" style="margin-top:8px">${progressBar(task.progress, '', true)}</div>
            <div class="small muted mt-8" id="taskMsg">已提交至任务队列…</div>
            <a class="small mt-8" href="${url('tasks.html')}" style="color:var(--brand);display:inline-block">在任务中心查看 ${icon('external', 11)}</a>
        </div>`;
    }

    function watchTask(taskId) {
        const off = on(EVENTS.taskUpdate, ({ task }) => {
            if (task.id !== taskId) return;
            const pct = Math.round(task.progress);
            const pctEl = $('#taskPct');
            const barEl = $('#taskBarWrap');
            const msgEl = $('#taskMsg');
            if (pctEl) pctEl.textContent = `${pct}%`;
            if (barEl) barEl.innerHTML = progressBar(pct, task.status === 'failed' ? 'danger' : '', true);
            if (msgEl && task.logs?.length) msgEl.textContent = task.logs[task.logs.length - 1].msg;
            if (task.status === 'succeeded') {
                off();
                state.generating = false;
                $('#generateBtn')?.classList.remove('loading');
                state.outputs = [...task.outputs, ...state.outputs];
                if (!state.cover && task.outputs[0]?.url) state.cover = task.outputs[0].url;
                renderCover();
                renderOutputs();
                renderChecklist();
                setTimeout(() => $('#genProgress')?.classList.add('hidden'), 1200);
                toast('生成完成，已自动选为封面', 'success');
            }
            if (task.status === 'failed' || task.status === 'canceled') {
                off();
                state.generating = false;
                $('#generateBtn')?.classList.remove('loading');
                toast(task.error || '任务已取消，积分已退还', 'error');
            }
        });
    }

    /* ---------------- 保存 ---------------- */
    async function save(mode) {
        const title = $('#fTitle').value.trim();
        if (!title) {
            toast('请填写资产名称', 'warn');
            $('#fTitle').focus();
            return;
        }
        if (mode === 'publish' && !state.cover) {
            toast('发布前需要先准备一张封面', 'warn');
            return;
        }
        const priceAmount = Number($('#priceAmount')?.value || 0);
        if (state.priceMode !== 'free' && priceAmount <= 0) {
            toast('请填写有效价格', 'warn');
            return;
        }
        const payload = {
            kind,
            title,
            desc: $('#fDesc').value.trim(),
            subtype: $('#fSubtype').value,
            tags: state.tags,
            cover: state.cover,
            prompt: $('#fPrompt').value.trim(),
            negative: $('#fNegative').value.trim(),
            params: {
                model: $('#fModel').value,
                steps: Number($('#fSteps')?.value || 28),
                cfg: Number($('#fCfg').value || 6.5),
                seed: Number($('#fSeed').value || 0),
                sampler: state.params.sampler || SAMPLERS[0],
                ratio: $('#fRatio').value,
                lora: state.params.lora || []
            },
            price: { mode: state.priceMode, amount: state.priceMode === 'free' ? 0 : priceAmount },
            visibility: state.visibility,
            duration: kind === 'video' ? videoEstimate().duration : 0,
            assetRefs: kind === 'video' ? state.assetRefs : null,
            meta: kind === 'model'
                ? {
                    base: $('#mBase').value,
                    trigger: $('#mTrigger').value.trim(),
                    rank: Number($('#mRank').value),
                    steps: Number($('#mSteps').value),
                    size: '-',
                    downloads: 0,
                    loss: 0
                }
                : null,
            sourceWorkId: editing ? editing.sourceWorkId : source?.id || null,
            status: mode === 'publish' ? 'published' : 'draft'
        };

        const btn = mode === 'publish' ? $('#publishBtn') : $('#saveDraft');
        btn?.classList.add('loading');
        try {
            let saved;
            if (editing) {
                saved = await updateWork(editing.id, payload);
                if (mode === 'publish' && ['draft', 'rejected', 'private'].includes(editing.status)) {
                    await submitWork(editing.id);
                }
            } else {
                saved = (await createWork(payload)).work;
            }
            toast(mode === 'publish' ? '已提交审核，通常 1 分钟内完成' : '草稿已保存', 'success');
            setTimeout(() => {
                window.location.href = mode === 'publish'
                    ? url(`${kindInfo.detail}?id=${saved.id}`)
                    : url(kindInfo.mine);
            }, 600);
        } catch (err) {
            toast(err.message, 'error');
            btn?.classList.remove('loading');
        }
    }

    $('#publishBtn')?.addEventListener('click', () => save('publish'));
    $('#publishBtn2')?.addEventListener('click', () => save('publish'));
    $('#saveDraft')?.addEventListener('click', () => save('draft'));
    $('#saveDraft2')?.addEventListener('click', () => save('draft'));

    renderTags();
    renderOutputs();
    renderChecklist();
    syncLongMode();
    refreshBalance();
}

async function fetchBalance() {
    const { getAccount } = await import('../core/api.js');
    const account = await getAccount();
    return account.credits;
}
