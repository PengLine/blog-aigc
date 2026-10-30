import { adminOverview, reviewWork } from '../core/api.js';
import { isOps, loginAs } from '../core/auth.js';
import { statusMeta, TASK_TYPES, KINDS } from '../core/constants.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast, emptyState, avatarTag, imgTag, openModal, closeModal } from '../core/ui.js';
import { escapeHtml, num, timeAgo } from '../core/format.js';

export async function render(host, ctx) {
    setPageTitle('平台管理');

    if (!isOps()) {
        host.innerHTML = `<div class="card" style="max-width:560px;margin:60px auto;text-align:center;padding:40px 24px">
            <div style="width:56px;height:56px;border-radius:16px;background:var(--brand-50);color:var(--brand-600);display:flex;align-items:center;justify-content:center;margin:0 auto 16px">
                ${icon('shield', 26)}
            </div>
            <h2 style="font-size:18px;font-weight:700">需要运营权限</h2>
            <p class="small muted" style="margin:10px 0 20px;line-height:1.8">
                平台管理包含内容审核、任务监控与用户治理，仅运营账号可访问。<br>
                在演示环境中，你可以切换到内置的运营账号体验完整流程。
            </p>
            <button class="btn btn-primary" id="switchOps">${icon('user', 15)}切换到运营演示账号</button>
            <div class="small muted" style="margin-top:14px">运营账号：ops@lingxi.demo</div>
        </div>`;
        host.querySelector('#switchOps')?.addEventListener('click', () => {
            loginAs('u_ops');
            toast('已切换为运营账号', 'success');
            window.setTimeout(() => window.location.reload(), 500);
        });
        return;
    }

    let data = await adminOverview();

    host.innerHTML = `
        <div class="page-head">
            <div class="page-head-main">
                <h1 class="page-title">平台管理 <span class="badge badge-warn">运营视角</span></h1>
                <div class="page-sub">内容审核、任务监控与用户治理，审核结论会实时通知创作者</div>
            </div>
            <div class="page-actions">
                <button class="btn btn-outline" id="refreshAdmin">${icon('refresh', 15)}刷新数据</button>
                <a class="btn btn-primary" href="${url('index.html')}">${icon('grid', 15)}查看广场</a>
            </div>
        </div>

        <div class="grid cols-4" style="margin-bottom:16px" id="statGrid"></div>

        <div class="card" style="margin-bottom:16px">
            <div class="card-head">
                <div>
                    <div class="card-title">待审核内容</div>
                    <div class="card-sub">通过后立即公开；退回需填写原因，创作者会收到通知</div>
                </div>
                <div class="spacer"></div>
                <span class="badge badge-warn" id="pendingBadge"></span>
            </div>
            <div class="card-body" id="pendingList"></div>
        </div>

        <div class="grid cols-2" style="gap:16px">
            <div class="card">
                <div class="card-head"><div class="card-title">最近任务</div><div class="spacer"></div>
                    <span class="small muted">全平台</span></div>
                <div class="card-body" style="padding-top:0">
                    <div class="table-wrap">
                        <table class="table">
                            <thead><tr><th>任务</th><th>类型</th><th>状态</th><th>消耗</th><th>时间</th></tr></thead>
                            <tbody id="taskRows"></tbody>
                        </table>
                    </div>
                </div>
            </div>
            <div class="card">
                <div class="card-head"><div class="card-title">用户</div><div class="spacer"></div>
                    <span class="small muted" id="userCount"></span></div>
                <div class="card-body" style="padding-top:0">
                    <div class="table-wrap">
                        <table class="table">
                            <thead><tr><th>用户</th><th>套餐</th><th>粉丝</th><th>作品</th></tr></thead>
                            <tbody id="userRows"></tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>`;

    draw();

    host.querySelector('#refreshAdmin')?.addEventListener('click', async (e) => {
        e.currentTarget.classList.add('loading');
        try {
            data = await adminOverview();
            draw();
            toast('数据已刷新', 'success');
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            e.currentTarget.classList.remove('loading');
        }
    });

    function draw() {
        host.querySelector('#statGrid').innerHTML = `
            ${statCard('创作者', data.stats.users, '含运营账号外的全部用户', 'users')}
            ${statCard('作品总数', data.stats.works, `已发布 ${data.stats.published}`, 'layers')}
            ${statCard('今日任务', data.stats.todayTasks, `消耗 ${num(data.stats.todayCost)} 算力`, 'zap')}
            ${statCard('失败任务', data.stats.failed, '已自动退款', 'alert')}`;

        host.querySelector('#pendingBadge').textContent = `${data.pendingCount} 条待处理`;

        const pendingList = host.querySelector('#pendingList');
        if (!data.pending.length) {
            pendingList.innerHTML = emptyState({ title: '审核队列已清空', desc: '所有提交内容都已处理完毕，保持这个节奏。' });
        } else {
            pendingList.innerHTML = `<div class="grid cols-2" style="gap:14px">
                ${data.pending.map((item) => `<div class="card" style="padding:12px;background:var(--bg-soft)" data-review="${item.id}">
                    <div class="row" style="gap:12px;align-items:flex-start">
                        <div class="review-preview" style="width:96px;flex:none">${imgTag(item.cover, item.title)}</div>
                        <div style="min-width:0;flex:1">
                            <div class="row" style="gap:6px;flex-wrap:wrap">
                                <b style="font-size:13px">${escapeHtml(item.title)}</b>
                                <span class="badge">${(KINDS[item.kind] || KINDS.character).name}</span>
                            </div>
                            <div class="small muted" style="margin-top:3px">
                                ${escapeHtml(item.author?.name || '匿名')} · 提交于 ${timeAgo(item.updatedAt)}
                            </div>
                            <div class="small" style="margin-top:6px;color:var(--text-2);line-height:1.6;max-height:56px;overflow:hidden">
                                ${escapeHtml(item.desc || '无描述')}
                            </div>
                            <div class="row wrap" style="gap:4px;margin-top:6px">
                                ${item.tags.slice(0, 3).map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}
                            </div>
                        </div>
                    </div>
                    <div class="row" style="gap:8px;margin-top:10px">
                        <a class="btn btn-sm btn-ghost" href="${url(`${(KINDS[item.kind] || KINDS.character).detail}?id=${item.id}`)}">${icon('eye', 13)}查看详情</a>
                        <span class="spacer"></span>
                        <button class="btn btn-sm btn-danger-soft" data-act="reject" data-id="${item.id}">${icon('x', 13)}退回</button>
                        <button class="btn btn-sm btn-primary" data-act="approve" data-id="${item.id}">${icon('check', 13)}通过</button>
                    </div>
                </div>`).join('')}
            </div>`;
        }

        host.querySelector('#taskRows').innerHTML = data.recentTasks.map((t) => {
            const st = statusMeta(t.status);
            const type = TASK_TYPES[t.type] || { name: '任务' };
            return `<tr>
                <td><div class="small">${escapeHtml(t.title)}</div><div class="small muted">${escapeHtml(t.ownerName || '')}</div></td>
                <td><span class="badge">${type.name}</span></td>
                <td><span class="badge ${st.tone ? `badge-${st.tone}` : ''}">${st.label}</span></td>
                <td class="mono">${t.cost}</td>
                <td class="small muted">${timeAgo(t.createdAt)}</td>
            </tr>`;
        }).join('') || '<tr><td colspan="5" class="small muted">暂无任务</td></tr>';

        host.querySelector('#userCount').textContent = `${data.users.length} 位`;
        host.querySelector('#userRows').innerHTML = data.users.map((u) => `<tr>
            <td><div class="row" style="gap:8px">${avatarTag(u, 'avatar-sm')}
                <div><div class="small">${escapeHtml(u.name)}</div>
                <div class="small muted">@${escapeHtml(u.handle)}</div></div></div></td>
            <td><span class="badge">${u.plan === 'studio' ? '工作室版' : u.plan === 'pro' ? '专业版' : '体验版'}</span></td>
            <td class="mono">${num(u.followers || 0)}</td>
            <td class="mono">${num(u.worksCount || 0)}</td>
        </tr>`).join('');

        bindReview();
    }

    function bindReview() {
        host.querySelectorAll('[data-act]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const { act, id } = btn.dataset;
                if (act === 'approve') {
                    btn.classList.add('loading');
                    try {
                        await reviewWork(id, true);
                        toast('已通过审核，内容已公开', 'success');
                        data = await adminOverview();
                        draw();
                    } catch (err) {
                        toast(err.message, 'error');
                        btn.classList.remove('loading');
                    }
                    return;
                }
                rejectDialog(id);
            });
        });
    }

    function rejectDialog(id) {
        openModal({
            title: '退回审核',
            size: 'sm',
            body: `<div class="col" style="gap:10px">
                <p class="small muted" style="line-height:1.7">请填写退回原因，创作者会在通知中心看到该说明。</p>
                <div class="chips" id="reasonChips">
                    ${['疑似含真实地标', '画面质量不达标', '描述与内容不符', '疑似侵权素材', '疑似含敏感内容'].map((r) => `<button class="chip" data-reason="${r}">${r}</button>`).join('')}
                </div>
                <textarea class="textarea" id="rejectNote" style="min-height:80px" placeholder="补充说明…"></textarea>
            </div>`,
            footer: `<button class="btn btn-outline" data-close>取消</button>
                     <button class="btn btn-danger" id="confirmReject">确认退回</button>`,
            onMount(card, root) {
                const note = card.querySelector('#rejectNote');
                root.querySelector('[data-close]')?.addEventListener('click', closeModal);
                card.querySelectorAll('[data-reason]').forEach((chip) => {
                    chip.addEventListener('click', () => {
                        chip.classList.toggle('active');
                        const picked = [...card.querySelectorAll('[data-reason].active')].map((el) => el.dataset.reason);
                        note.value = picked.join('；');
                    });
                });
                card.querySelector('#confirmReject').addEventListener('click', async () => {
                    const text = note.value.trim();
                    if (!text) {
                        toast('请填写退回原因', 'error');
                        return;
                    }
                    try {
                        await reviewWork(id, false, text);
                        closeModal();
                        toast('已退回并通知创作者', 'success');
                        data = await adminOverview();
                        draw();
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                });
            }
        });
    }
}

function statCard(label, value, sub, iconName) {
    return `<div class="admin-stat">
        <div class="row between">
            <span class="small muted">${escapeHtml(label)}</span>
            <span style="color:var(--brand-600)">${icon(iconName, 15)}</span>
        </div>
        <b>${num(value)}</b>
        <span>${escapeHtml(sub)}</span>
    </div>`;
}
