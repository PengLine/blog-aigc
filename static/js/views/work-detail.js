import {
    getWork,
    viewWork,
    toggleReaction,
    addComment,
    submitWork,
    deleteWork,
    unpublishWork,
    purchaseWork,
    listWorks
} from '../core/api.js';
import { MODEL_MAP, kindMeta, SAMPLERS } from '../core/constants.js';
import { url, setPageTitle } from '../core/shell.js';
import {
    imgTag,
    avatarTag,
    statusBadge,
    kindBadge,
    icon,
    toast,
    confirmDialog,
    openModal,
    copyText,
    emptyState
} from '../core/ui.js';
import { escapeHtml, num, timeAgo, fmtDate } from '../core/format.js';
import { artCover, POSTER_SECOND } from '../core/cover.js';

export async function render(host, ctx) {
    setPageTitle('作品详情');
    host.innerHTML = `<div class="split"><div class="skeleton" style="height:460px;border-radius:16px"></div><div class="skeleton" style="height:300px;border-radius:16px"></div></div>`;

    let data;
    try {
        let id = ctx.query.id;
        if (!id) {
            const fallback = await listWorks({ kind: ctx.params.kind || 'all', sort: 'popular', pageSize: 1 });
            if (!fallback.items.length) {
                host.innerHTML = emptyState({ title: '暂时没有可展示的作品', action: `<a class="btn btn-primary" href="${url('index.html')}">回到广场</a>` });
                return;
            }
            id = fallback.items[0].id;
        }
        data = await getWork(id);
        if (!sessionStorage.getItem(`viewed:${id}`)) {
            sessionStorage.setItem(`viewed:${id}`, '1');
            viewWork(id);
        }
    } catch (err) {
        host.innerHTML = emptyState({
            title: '无法查看该作品',
            desc: err.message,
            action: `<a class="btn btn-primary" href="${url('index.html')}">回到广场</a>`
        });
        return;
    }

    const { work, comments, related, source, versions } = data;
    const meta = kindMeta(work.kind);
    setPageTitle(work.title);
    draw();

    function draw() {
        const isVideo = work.mediaType === 'video' || work.kind === 'video';
        const modelName = MODEL_MAP[work.params?.model]?.name || work.params?.model || '-';
        const priceText = work.price?.mode === 'free' || !work.price?.amount
            ? '免费使用'
            : work.price.mode === 'license'
                ? `¥ ${work.price.amount} 商业授权`
                : `${work.price.amount} 算力 / 次`;

        host.innerHTML = `
        <div class="page-head" style="align-items:flex-start">
            <div class="page-head-main" style="display:flex;gap:12px;align-items:flex-start">
                <a class="icon-btn" href="${url('index.html')}" title="返回广场" style="margin-top:2px">${icon('arrow-left', 18)}</a>
                <div>
                    <h1 class="page-title">${escapeHtml(work.title)}
                        ${kindBadge(work.kind)}
                        ${statusBadge(work.status)}
                    </h1>
                    <div class="page-sub" style="display:flex;gap:14px;flex-wrap:wrap">
                        <span>${icon('eye', 13)} ${num(work.stats.views)} 浏览</span>
                        <span>${icon('heart', 13)} ${num(work.stats.likes)} 点赞</span>
                        <span>${icon('clock', 13)} 更新于 ${timeAgo(work.updatedAt)}</span>
                        <span>v${work.version || 1}</span>
                    </div>
                </div>
            </div>
            <div class="page-actions">
                ${work.isMine ? ownerActions() : `<button class="btn btn-outline" id="reportBtn">${icon('alert', 15)}举报</button>`}
                <button class="btn btn-outline" id="shareBtn">${icon('share', 15)}分享</button>
                <a class="btn btn-primary" href="${url(`${meta.create}?from=${work.id}`)}">${icon('sparkles', 15)}同款创作</a>
            </div>
        </div>

        ${work.status === 'rejected' && work.review ? `<div class="card" style="padding:12px 16px;margin-bottom:14px;border-color:#fecaca;background:var(--danger-bg)">
            <div class="row" style="color:var(--danger);align-items:flex-start">${icon('alert', 16)}
                <div><b>审核未通过</b><div class="small" style="margin-top:2px">${escapeHtml(work.review.note || '内容不符合社区规范')}</div></div>
            </div>
        </div>` : ''}

        <div class="detail-wrap">
            <div class="col" style="gap:16px">
                <div class="card" style="overflow:hidden">
                    <div class="media-stage">
                        ${isVideo
                        ? `<video controls preload="metadata" poster="${escapeHtml(artCover({ title: work.title, prompt: work.prompt, kind: 'video', second: POSTER_SECOND }))}" src="${escapeHtml(work.mediaUrl || '')}">您的浏览器不支持视频播放</video>`
                        : imgTag(work.cover, work.title, '', `data-fb-prompt="${escapeHtml(work.prompt || '')}"`)}
                    </div>
                    <div class="card-body">
                        <p style="font-size:13.5px;color:var(--text-2);line-height:1.8">${escapeHtml(work.desc || '作者暂未填写作品描述。')}</p>
                        <div class="row wrap" style="margin-top:12px;gap:6px">
                            ${work.tags.map((t) => `<a class="tag tag-brand" href="${url(`index.html?q=${encodeURIComponent(t)}`)}">#${escapeHtml(t)}</a>`).join('')}
                        </div>
                        <div class="divider"></div>
                        <div class="row wrap" style="gap:10px">
                            <button class="btn ${work.liked ? 'btn-danger-soft' : 'btn-outline'}" id="likeBtn">${icon('heart', 15)}${work.liked ? '已点赞' : '点赞'} ${num(work.stats.likes)}</button>
                            <button class="btn ${work.favorited ? 'btn-soft' : 'btn-outline'}" id="favBtn">${icon('star', 15)}${work.favorited ? '已收藏' : '收藏'} ${num(work.stats.favorites)}</button>
                            <button class="btn btn-ghost" id="copyPrompt">${icon('copy', 15)}复制提示词</button>
                            <button class="btn btn-ghost" id="downloadBtn">${icon('download', 15)}下载原图</button>
                        </div>
                    </div>
                </div>

                <div class="card">
                    <div class="card-head">
                        <div>
                            <div class="card-title">创作参数</div>
                            <div class="card-sub">可直接复制到创作中心复现</div>
                        </div>
                        <div class="spacer"></div>
                        <button class="btn btn-sm btn-outline" id="copyParams">${icon('copy', 14)}复制参数</button>
                    </div>
                    <div class="card-body">
                        <div class="grid cols-2" style="gap:24px">
                            <div>
                                <div class="label" style="margin-bottom:6px">提示词</div>
                                <div class="prompt-box" style="white-space:pre-wrap">${escapeHtml(work.prompt || '—')}
                                    <button class="btn btn-sm btn-ghost copy" data-copy="${escapeHtml(work.prompt || '')}" title="复制">${icon('copy', 13)}</button>
                                </div>
                                <div class="label" style="margin:12px 0 6px">负面提示词</div>
                                <div class="prompt-box" style="white-space:pre-wrap;max-height:92px">${escapeHtml(work.negative || '—')}</div>
                            </div>
                            <div>
                                <dl class="param-list">
                                    <dt>生成模型</dt><dd>${escapeHtml(modelName)}</dd>
                                    <dt>采样步数</dt><dd>${work.params?.steps ?? '-'}</dd>
                                    <dt>CFG Scale</dt><dd>${work.params?.cfg ?? '-'}</dd>
                                    <dt>采样器</dt><dd>${escapeHtml(work.params?.sampler || SAMPLERS[0])}</dd>
                                    <dt>随机种子</dt><dd class="mono">${work.params?.seed ?? '-'}</dd>
                                    <dt>画面比例</dt><dd>${escapeHtml(work.params?.ratio || '-')}</dd>
                                    <dt>LoRA</dt><dd>${work.params?.lora?.length ? escapeHtml(work.params.lora.join('、')) : '无'}</dd>
                                    <dt>创建时间</dt><dd>${fmtDate(work.createdAt)}</dd>
                                </dl>
                                ${work.meta ? `<div class="divider"></div><dl class="param-list">
                                    <dt>底模</dt><dd>${escapeHtml(work.meta.base || '-')}</dd>
                                    <dt>触发词</dt><dd class="mono">${escapeHtml(work.meta.trigger || '-')}</dd>
                                    <dt>Rank</dt><dd>${work.meta.rank ?? '-'}</dd>
                                    <dt>训练步数</dt><dd>${num(work.meta.steps || 0)}</dd>
                                    <dt>体积</dt><dd>${escapeHtml(work.meta.size || '-')}</dd>
                                    <dt>下载量</dt><dd>${num(work.meta.downloads || 0)}</dd>
                                </dl>` : ''}
                            </div>
                        </div>
                        ${source ? `<div class="divider"></div>
                        <div class="row" style="gap:10px;font-size:12.5px">
                            <span class="muted">灵感来源</span>
                            <a href="${url(`${kindMeta(source.kind).detail}?id=${source.id}`)}" class="row" style="gap:6px">
                                ${imgTag(source.cover, source.title, '', 'style="width:42px;height:32px;border-radius:6px;object-fit:cover"')}
                                ${escapeHtml(source.title)}
                            </a>
                        </div>` : ''}
                    </div>
                </div>

                <div class="card" id="commentsCard">
                    <div class="card-head">
                        <div class="card-title">评论 ${num(comments.length)}</div>
                    </div>
                    <div class="card-body">
                        <div class="row" style="align-items:flex-start;gap:10px">
                            ${avatarTag({ name: '我' })}
                            <div style="flex:1">
                                <textarea class="textarea" id="commentInput" placeholder="说点什么…（支持 Ctrl + Enter 发送）" style="min-height:76px"></textarea>
                                <div class="row" style="margin-top:8px">
                                    <span class="small muted">请友善发言，评论会同步通知作者</span>
                                    <span class="spacer"></span>
                                    <button class="btn btn-primary btn-sm" id="commentSubmit">发表评论</button>
                                </div>
                            </div>
                        </div>
                        <div id="commentList" style="margin-top:6px">${comments.length ? comments.map(commentHtml).join('') : '<div class="small muted" style="padding:16px 0">还没有评论，来抢沙发。</div>'}</div>
                    </div>
                </div>
            </div>

            <aside class="detail-side">
                <div class="card">
                    <div class="card-body">
                        <div class="row" style="gap:10px">
                            <a href="${url(`profile.html?uid=${work.author.id}`)}">${avatarTag(work.author, 'avatar-lg')}</a>
                            <div style="min-width:0">
                                <a href="${url(`profile.html?uid=${work.author.id}`)}" class="strong" style="color:var(--text)">
                                    ${escapeHtml(work.author.name)}
                                    ${work.author.verified ? `<span class="badge badge-brand" style="margin-left:4px">认证</span>` : ''}
                                </a>
                                <div class="small muted">@${escapeHtml(work.author.handle)} · Lv.${work.author.level}</div>
                            </div>
                        </div>
                        <p class="small muted" style="margin-top:10px;line-height:1.7">${escapeHtml(work.author.bio || '这位创作者还没有填写简介')}</p>
                        <div class="row between" style="margin-top:12px">
                            <div class="small"><b>${num(work.author.worksCount)}</b> <span class="muted">作品</span></div>
                            <div class="small"><b>${num(work.author.followers)}</b> <span class="muted">粉丝</span></div>
                            <div class="small"><b>${num(work.author.likesReceived)}</b> <span class="muted">获赞</span></div>
                            <div class="spacer"></div>
                            ${work.isMine ? '' : `<button class="btn btn-sm btn-primary" id="followBtn">关注</button>`}
                        </div>
                    </div>
                </div>

                <div class="card">
                    <div class="card-head"><div class="card-title">资产信息</div></div>
                    <div class="card-body">
                        <dl class="param-list">
                            <dt>资产类型</dt><dd>${escapeHtml(meta.name)}</dd>
                            <dt>题材分类</dt><dd>${escapeHtml(work.subtype)}</dd>
                            <dt>授权方式</dt><dd>${priceText}</dd>
                            <dt>复刻次数</dt><dd>${num(work.stats.remixes)}</dd>
                            <dt>收藏</dt><dd>${num(work.stats.favorites)}</dd>
                            <dt>评论</dt><dd>${num(work.stats.comments)}</dd>
                        </dl>
                        ${work.price && work.price.mode !== 'free' && work.price.amount ? `
                        <button class="btn btn-primary btn-block mt-12" id="buyBtn" ${work.licensed ? 'disabled' : ''}>
                            ${icon('credit', 15)}${work.licensed ? '已获得授权' : work.price.mode === 'license' ? `购买商业授权 ¥${work.price.amount}` : `支付 ${work.price.amount} 算力使用`}
                        </button>
                        <div class="small muted" style="margin-top:8px;text-align:center">演示环境将直接扣减算力积分</div>` : ''}
                    </div>
                </div>

                ${work.isMine ? `<div class="card">
                    <div class="card-head"><div class="card-title">资产管理</div></div>
                    <div class="card-body col" style="gap:8px">
                        <div class="row between small"><span class="muted">当前状态</span>${statusBadge(work.status)}</div>
                        <div class="row between small"><span class="muted">可见范围</span><span>${work.visibility === 'private' ? '仅自己' : '公开'}</span></div>
                        <div class="row between small"><span class="muted">版本</span><span>v${work.version || 1}</span></div>
                        <div class="divider" style="margin:6px 0"></div>
                        <a class="btn btn-outline btn-block" href="${url(`${meta.create}?edit=${work.id}`)}">${icon('edit', 15)}编辑资产</a>
                        ${['draft', 'rejected', 'private'].includes(work.status) ? `<button class="btn btn-primary btn-block" id="submitBtn">${icon('upload', 15)}提交审核发布</button>` : ''}
                        ${work.status === 'published' ? `<button class="btn btn-outline btn-block" id="unpublishBtn">下架作品</button>` : ''}
                        <button class="btn btn-danger-soft btn-block" id="deleteBtn">${icon('trash', 15)}删除资产</button>
                    </div>
                </div>` : ''}

                <div class="card">
                    <div class="card-head"><div class="card-title">版本记录</div></div>
                    <div class="card-body">
                        <div class="col" style="gap:10px">
                            ${versions.map((v) => `<div class="row small" style="gap:8px">
                                <span class="badge ${v.version === work.version ? 'badge-brand' : ''}">v${v.version}</span>
                                <span class="muted" style="flex:1">${escapeHtml(v.note)}</span>
                                <span class="muted">${fmtDate(v.at)}</span>
                            </div>`).join('')}
                        </div>
                    </div>
                </div>

                <div class="card">
                    <div class="card-head"><div class="card-title">相似资产</div></div>
                    <div class="card-body">
                        <div class="related-grid">
                            ${related.length ? related.map((r) => `<a class="related-item" href="${url(`${kindMeta(r.kind).detail}?id=${r.id}`)}">
                                <div class="thumb">${imgTag(r.cover, r.title)}</div>
                                <p>${escapeHtml(r.title)}</p>
                            </a>`).join('') : '<div class="small muted">暂无相似资产</div>'}
                        </div>
                    </div>
                </div>
            </aside>
        </div>`;

        bind();
    }

    function ownerActions() {
        return `<a class="btn btn-outline" href="${url(`${meta.create}?edit=${work.id}`)}">${icon('edit', 15)}编辑</a>`;
    }

    function commentHtml(c) {
        return `<div class="comment">
            <a href="${url(`profile.html?uid=${c.user.id}`)}">${avatarTag(c.user)}</a>
            <div class="comment-main">
                <div class="comment-head">
                    <b>${escapeHtml(c.user.name)}</b>
                    <span class="muted">${timeAgo(c.createdAt)}</span>
                    ${c.user.id === work.author.id ? '<span class="badge badge-brand">作者</span>' : ''}
                </div>
                <div class="comment-body">${escapeHtml(c.content)}</div>
                <div class="comment-actions">
                    <button data-like-comment="${c.id}">${icon('heart', 12)} ${c.likes}</button>
                    <button data-reply="${escapeHtml(c.user.name)}">回复</button>
                </div>
            </div>
        </div>`;
    }

    function bind() {
        host.querySelector('#likeBtn')?.addEventListener('click', async () => {
            const res = await toggleReaction(work.id, 'like');
            work.liked = res.active;
            work.stats.likes = res.count;
            draw();
            toast(res.active ? '已点赞' : '已取消点赞', 'success', 1400);
        });

        host.querySelector('#favBtn')?.addEventListener('click', async () => {
            const res = await toggleReaction(work.id, 'favorite');
            work.favorited = res.active;
            work.stats.favorites = res.count;
            draw();
            toast(res.active ? '已加入收藏' : '已取消收藏', 'success', 1400);
        });

        host.querySelector('#shareBtn')?.addEventListener('click', async () => {
            const link = window.location.href;
            if (navigator.share) {
                try {
                    await navigator.share({ title: work.title, url: link });
                    return;
                } catch (err) {
                    /* 用户取消 */
                }
            }
            copyText(link, '作品链接已复制');
        });

        host.querySelector('#copyPrompt')?.addEventListener('click', () => copyText(work.prompt || '', '提示词已复制'));
        host.querySelector('#copyParams')?.addEventListener('click', () => {
            const text = [
                `提示词：${work.prompt}`,
                `负面提示词：${work.negative}`,
                `模型：${MODEL_MAP[work.params?.model]?.name || work.params?.model}`,
                `步数：${work.params?.steps} / CFG：${work.params?.cfg} / 采样器：${work.params?.sampler} / 种子：${work.params?.seed}`
            ].join('\n');
            copyText(text, '创作参数已复制');
        });
        host.querySelectorAll('[data-copy]').forEach((btn) => {
            btn.addEventListener('click', () => copyText(btn.dataset.copy || '', '已复制'));
        });

        host.querySelector('#downloadBtn')?.addEventListener('click', () => {
            toast('演示环境未接入对象存储，已模拟下载请求', 'info');
        });

        host.querySelector('#followBtn')?.addEventListener('click', () => {
            toast('已关注创作者，后续作品会出现在你的动态流', 'success');
        });

        host.querySelector('#reportBtn')?.addEventListener('click', () => {
            openModal({
                title: '举报作品',
                size: 'sm',
                body: `<div class="col" style="gap:8px">
                    ${['涉嫌侵权', '内容违规', '虚假信息', '其他问题'].map((r, i) => `<label class="row" style="gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer">
                        <input type="radio" name="reason" value="${r}" ${i === 0 ? 'checked' : ''}> <span class="small">${r}</span>
                    </label>`).join('')}
                    <textarea class="textarea" id="reportNote" placeholder="补充说明（选填）" style="min-height:70px"></textarea>
                </div>`,
                footer: `<button class="btn btn-outline" data-close="1">取消</button><button class="btn btn-danger" id="reportSubmit">提交举报</button>`,
                onMount(card) {
                    card.querySelector('#reportSubmit').addEventListener('click', () => {
                        const reason = card.querySelector('input[name="reason"]:checked')?.value || '其他问题';
                        const note = card.querySelector('#reportNote').value.trim();
                        toast(`举报已提交（${reason}${note ? '：' + note.slice(0, 12) : ''}），运营会在 24 小时内处理`, 'success');
                        card.closest('.modal-root').classList.remove('open');
                    });
                }
            });
        });

        host.querySelector('#commentSubmit')?.addEventListener('click', submitComment);
        host.querySelector('#commentInput')?.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitComment();
        });

        async function submitComment() {
            const input = host.querySelector('#commentInput');
            const text = input.value.trim();
            if (!text) {
                toast('请先输入评论内容', 'warn');
                return;
            }
            const btn = host.querySelector('#commentSubmit');
            btn.classList.add('loading');
            try {
                const c = await addComment(work.id, text);
                comments.unshift(c);
                work.stats.comments += 1;
                draw();
                toast('评论已发布', 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
        }

        host.querySelectorAll('[data-like-comment]').forEach((btn) => {
            btn.addEventListener('click', () => {
                btn.innerHTML = `${icon('heart', 12)} ${Number(btn.textContent.trim()) + 1}`;
                btn.style.color = 'var(--danger)';
                toast('已点赞该评论', 'success', 1200);
            });
        });
        host.querySelectorAll('[data-reply]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const input = host.querySelector('#commentInput');
                input.value = `@${btn.dataset.reply} `;
                input.focus();
            });
        });

        host.querySelector('#buyBtn')?.addEventListener('click', async () => {
            const ok = await confirmDialog({
                title: '确认获取授权',
                message: `将扣减 ${work.price.amount} 算力积分以获得「${work.title}」的使用授权，可在你的资产库中随时调用。`,
                confirmText: '确认支付'
            });
            if (!ok) return;
            try {
                await purchaseWork(work.id);
                work.licensed = true;
                draw();
                toast('授权成功，已加入可调用资产', 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
        });

        host.querySelector('#submitBtn')?.addEventListener('click', async () => {
            try {
                await submitWork(work.id);
                toast('已提交审核，通常 1 分钟内完成', 'success');
                setTimeout(() => location.reload(), 600);
            } catch (err) {
                toast(err.message, 'error');
            }
        });

        host.querySelector('#unpublishBtn')?.addEventListener('click', async () => {
            const ok = await confirmDialog({ title: '下架作品', message: '下架后作品将从广场移除，仅自己可见。', confirmText: '下架' });
            if (!ok) return;
            await unpublishWork(work.id);
            toast('作品已下架', 'success');
            setTimeout(() => location.reload(), 500);
        });

        host.querySelector('#deleteBtn')?.addEventListener('click', async () => {
            const ok = await confirmDialog({
                title: '删除资产',
                message: '删除后不可恢复，引用该资产的短剧将失去关联，确认删除？',
                confirmText: '确认删除',
                danger: true
            });
            if (!ok) return;
            await deleteWork(work.id);
            toast('资产已删除', 'success');
            setTimeout(() => (window.location.href = url('assets/my-assets.html')), 500);
        });
    }
}
