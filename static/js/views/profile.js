import { getCreator, favorites, toggleFollow, updateProfile, getAccount, listTasks, resetDemo, exportData } from '../core/api.js';
import { currentUserId, currentPublicUser } from '../core/auth.js';
import { url, setPageTitle } from '../core/shell.js';
import { icon, toast, avatarTag, workCard, bindWorkCards, emptyState, confirmDialog, readFileAsDataURL, openModal, closeModal, copyText, renderPagination } from '../core/ui.js';
import { escapeHtml, num, timeAgo, fmtDate } from '../core/format.js';

const SELF_TABS = [
    { id: 'overview', name: '概览' },
    { id: 'works', name: '作品' },
    { id: 'favorites', name: '收藏' },
    { id: 'following', name: '关注与粉丝' },
    { id: 'settings', name: '资料设置' }
];

export async function render(host, ctx) {
    const me = currentUserId();
    const uid = ctx.query.uid || me;
    let data;
    try {
        data = await getCreator(uid);
    } catch (err) {
        host.innerHTML = emptyState({ title: '找不到该创作者', desc: err.message, action: `<a class="btn btn-primary" href="${url('index.html')}">回到广场</a>` });
        return;
    }

    const isSelf = data.isSelf;
    setPageTitle(isSelf ? '个人中心' : data.user.name);
    const state = {
        tab: ctx.query.tab || (isSelf ? 'overview' : 'works'),
        page: 1,
        pageSize: 8,
        favs: [],
        following: data.following,
        followers: data.followers
    };

    async function loadAux() {
        if (state.tab === 'favorites' && isSelf) {
            const res = await favorites();
            state.favs = res.items;
        }
    }

    draw();
    await loadAux();
    drawBody();

    function draw() {
        const user = data.user;
        const tabs = isSelf ? SELF_TABS : [{ id: 'works', name: '作品' }, { id: 'following', name: '关注与粉丝' }];
        host.innerHTML = `
            <div class="card" style="padding:0;overflow:hidden;margin-bottom:16px">
                <div class="profile-cover" style="background:${coverBg(user)}"></div>
                <div class="profile-head">
                    <div class="row wrap" style="gap:16px;align-items:flex-end">
                        ${avatarTag(user, 'avatar-xl avatar-ring')}
                        <div style="flex:1;min-width:200px">
                            <div class="row" style="gap:8px;flex-wrap:wrap">
                                <h1 style="font-size:20px;font-weight:700">${escapeHtml(user.name)}</h1>
                                ${user.verified ? `<span class="badge badge-brand">${icon('check', 11)}认证创作者</span>` : ''}
                                <span class="badge">Lv.${user.level || 1}</span>
                                ${isSelf ? `<span class="badge badge-violet">${escapeHtml(user.plan === 'studio' ? '工作室版' : user.plan === 'pro' ? '专业版' : '体验版')}</span>` : ''}
                            </div>
                            <div class="small muted" style="margin-top:4px">@${escapeHtml(user.handle || 'user')}
                                ${user.region ? ` · ${escapeHtml(user.region)}` : ''} · 加入于 ${fmtDate(user.joinedAt)}</div>
                            <p class="small" style="color:var(--text-2);margin-top:8px;line-height:1.7;max-width:640px">${escapeHtml(user.bio || '这位创作者还没有填写简介。')}</p>
                            <div class="row wrap" style="gap:6px;margin-top:8px">
                                ${(user.tags || []).map((t) => `<span class="tag tag-brand">#${escapeHtml(t)}</span>`).join('')}
                            </div>
                        </div>
                        <div class="row" style="gap:8px">
                            ${isSelf
                ? `<a class="btn btn-outline" href="${url('wallet.html')}">${icon('wallet', 15)}账户与订阅</a>
                                   <button class="btn btn-primary" id="editProfile">${icon('edit', 15)}编辑资料</button>`
                : `<button class="btn btn-outline" id="shareProfile">${icon('share', 15)}分享</button>
                                   <button class="btn ${data.isFollowing ? 'btn-outline' : 'btn-primary'}" id="followBtn">
                                       ${icon(data.isFollowing ? 'check' : 'plus', 15)}${data.isFollowing ? '已关注' : '关注'}</button>`}
                        </div>
                    </div>
                    <div class="profile-stats">
                        <div><b>${num(data.works.length)}</b><span>作品</span></div>
                        <div><b>${num(data.likesReceived)}</b><span>获赞</span></div>
                        <div><b>${num(data.followerCount)}</b><span>粉丝</span></div>
                        <div><b>${num(data.followingCount)}</b><span>关注</span></div>
                    </div>
                </div>
            </div>

            <div class="tabs" id="profileTabs" style="margin-bottom:14px">
                ${tabs.map((t) => `<button class="tab ${state.tab === t.id ? 'active' : ''}" data-tab="${t.id}">${t.name}</button>`).join('')}
            </div>
            <div id="profileBody"></div>`;

        host.querySelector('#followBtn')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.classList.add('loading');
            try {
                const res = await toggleFollow(uid);
                data.isFollowing = res.following;
                data.followerCount += res.following ? 1 : -1;
                toast(res.following ? '已关注' : '已取消关注', 'success');
                draw();
                drawBody();
            } catch (err) {
                toast(err.message, 'error');
            } finally {
                btn.classList.remove('loading');
            }
        });

        host.querySelector('#shareProfile')?.addEventListener('click', () => {
            copyText(location.href, '主页链接已复制');
        });

        host.querySelector('#editProfile')?.addEventListener('click', () => editProfileDialog());

        host.querySelector('#profileTabs')?.addEventListener('click', async (e) => {
            const tab = e.target.closest('[data-tab]');
            if (!tab) return;
            state.tab = tab.dataset.tab;
            state.page = 1;
            host.querySelectorAll('#profileTabs .tab').forEach((el) => el.classList.toggle('active', el === tab));
            if (state.tab === 'favorites') await loadAux();
            drawBody();
        });
    }

    async function drawBody() {
        const body = host.querySelector('#profileBody');
        if (!body) return;

        if (state.tab === 'overview') {
            const [account, tasks] = await Promise.all([getAccount(), listTasks({ pageSize: 5 })]);
            body.innerHTML = `
                <div class="grid cols-4" style="margin-bottom:16px">
                    ${miniStat('算力余额', num(account.credits), '生成与训练消耗', 'credit')}
                    ${miniStat('作品', String(data.works.length), '公开可见', 'layers')}
                    ${miniStat('进行中任务', String(tasks.counts.running + tasks.counts.queued), '任务中心查看', 'zap')}
                    ${miniStat('套餐', account.planName, `每月 ${num(account.quota)} 算力`, 'shield')}
                </div>
                <div class="card">
                    <div class="card-head">
                        <div class="card-title">最近作品</div>
                        <div class="spacer"></div>
                        <a class="small" href="${url('assets/my-assets.html')}" style="color:var(--brand)">资产库 ${icon('chevron-right', 12)}</a>
                    </div>
                    <div class="card-body">
                        ${data.works.length
                    ? `<div class="work-grid">${data.works.slice(0, 4).map((w) => workCard(w, { showStatus: true, showAuthor: false })).join('')}</div>`
                    : emptyState({ title: '还没有公开作品', desc: '发布第一个作品后，这里会展示你的创作。', action: `<a class="btn btn-primary" href="${url('assets/create-character.html')}">开始创作</a>` })}
                    </div>
                </div>
                <div class="card" style="margin-top:16px">
                    <div class="card-head">
                        <div class="card-title">最近任务</div>
                        <div class="spacer"></div>
                        <a class="small" href="${url('tasks.html')}" style="color:var(--brand)">任务中心 ${icon('chevron-right', 12)}</a>
                    </div>
                    <div class="card-body" style="padding-top:4px">
                        ${tasks.items.length ? tasks.items.map((t) => `<a class="history-item" href="${url('tasks.html')}?id=${t.id}" style="display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
                            <span class="badge">${escapeHtml(t.title)}</span>
                            <span class="spacer"></span>
                            <span class="small muted">${timeAgo(t.createdAt)} · ${t.cost} 算力</span>
                        </a>`).join('') : '<div class="small muted" style="padding:10px 0">暂无任务记录</div>'}
                    </div>
                </div>`;
            bindCards(body);
            return;
        }

        if (state.tab === 'works') {
            const list = data.works;
            if (!list.length) {
                body.innerHTML = emptyState({ title: '还没有公开发布的作品', desc: '提交审核通过后会展示在这里。', action: `<a class="btn btn-primary" href="${url('assets/my-assets.html')}">前往资产库</a>` });
                return;
            }
            const pages = Math.max(1, Math.ceil(list.length / state.pageSize));
            const page = Math.min(state.page, pages);
            const slice = list.slice((page - 1) * state.pageSize, page * state.pageSize);
            body.innerHTML = `<div class="work-grid">${slice.map((w) => workCard(w, { showStatus: isSelf, showAuthor: false })).join('')}</div>
                <div class="pagination" id="workPager" style="margin-top:16px"></div>`;
            bindCards(body);
            renderPagination(body.querySelector('#workPager'), {
                page,
                pages,
                total: list.length,
                pageSize: state.pageSize,
                onChange: (next) => {
                    state.page = next;
                    drawBody();
                }
            });
            return;
        }

        if (state.tab === 'favorites') {
            if (!state.favs.length) {
                body.innerHTML = emptyState({ title: '还没有收藏作品', desc: '在广场中点击收藏，作品会出现在这里。', action: `<a class="btn btn-primary" href="${url('index.html')}">去发现</a>` });
                return;
            }
            body.innerHTML = `<div class="work-grid">${state.favs.map((w) => workCard(w)).join('')}</div>`;
            bindCards(body);
            return;
        }

        if (state.tab === 'following') {
            body.innerHTML = `<div class="grid cols-2" style="gap:16px">
                <div class="card">
                    <div class="card-head"><div class="card-title">关注 ${state.following.length}</div></div>
                    <div class="card-body" style="padding-top:4px">
                        ${state.following.length ? state.following.map(userRow).join('') : '<div class="small muted" style="padding:10px 0">还没有关注任何人</div>'}
                    </div>
                </div>
                <div class="card">
                    <div class="card-head"><div class="card-title">粉丝 ${data.followerCount}</div></div>
                    <div class="card-body" style="padding-top:4px">
                        ${state.followers.length ? state.followers.map(userRow).join('') : '<div class="small muted" style="padding:10px 0">还没有粉丝，发布作品吸引更多关注吧</div>'}
                    </div>
                </div>
            </div>`;
            return;
        }

        body.innerHTML = settingsHtml();
        bindSettings();
    }

    function bindCards(root) {
        bindWorkCards(root, (id) => {
            const work = [...data.works, ...state.favs].find((w) => w.id === id);
            if (!work) return;
            const map = { character: 'assets/character-detail.html', prop: 'assets/prop-detail.html', scenic: 'assets/scenic-detail.html', video: 'assets/video-detail.html', model: 'assets/model-detail.html', app: 'app/ai-app-detail.html' };
            window.location.href = `${url(map[work.kind] || 'assets/detail.html')}?id=${encodeURIComponent(id)}`;
        });
    }

    function userRow(user) {
        return `<div class="row" style="gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
            ${avatarTag(user, 'avatar-sm')}
            <div style="min-width:0;flex:1">
                <a href="${url(`profile.html?uid=${user.id}`)}" style="font-size:13px;font-weight:600">${escapeHtml(user.name)}</a>
                <div class="small muted ellipsis">${escapeHtml(user.bio || `@${user.handle}`)}</div>
            </div>
            <a class="btn btn-sm btn-outline" href="${url(`profile.html?uid=${user.id}`)}">主页</a>
        </div>`;
    }

    function settingsHtml() {
        const user = currentPublicUser();
        return `<div class="grid cols-2" style="gap:16px">
            <div class="card">
                <div class="card-head"><div class="card-title">基础资料</div></div>
                <div class="card-body col" style="gap:14px">
                    <div class="row" style="gap:12px">
                        ${avatarTag(user, 'avatar-lg')}
                        <div>
                            <label class="btn btn-outline btn-sm">${icon('upload', 13)}更换头像
                                <input type="file" id="avatarFile" accept="image/*" hidden>
                            </label>
                            <div class="hint">建议 1:1 比例，小于 300KB</div>
                        </div>
                    </div>
                    <div class="field" style="margin:0">
                        <label class="label">昵称</label>
                        <input class="input" id="setName" maxlength="20" value="${escapeHtml(user.name)}">
                    </div>
                    <div class="field" style="margin:0">
                        <label class="label">用户名</label>
                        <input class="input mono" id="setHandle" value="${escapeHtml(user.handle || '')}">
                    </div>
                    <div class="field" style="margin:0">
                        <label class="label">所在地</label>
                        <input class="input" id="setRegion" value="${escapeHtml(user.region || '')}">
                    </div>
                    <div class="field" style="margin:0">
                        <label class="label">简介</label>
                        <textarea class="textarea" id="setBio" style="min-height:80px">${escapeHtml(user.bio || '')}</textarea>
                    </div>
                    <div class="field" style="margin:0">
                        <label class="label">标签 <span class="hint-inline">逗号分隔，最多 6 个</span></label>
                        <input class="input" id="setTags" value="${escapeHtml((user.tags || []).join(','))}">
                    </div>
                    <button class="btn btn-primary" id="saveProfile">${icon('check', 15)}保存资料</button>
                </div>
            </div>
            <div class="col" style="gap:16px">
                <div class="card">
                    <div class="card-head"><div class="card-title">账号与套餐</div></div>
                    <div class="card-body small col" style="gap:10px">
                        <div class="row between"><span class="muted">当前套餐</span><b>${escapeHtml(user.plan === 'studio' ? '工作室版' : user.plan === 'pro' ? '专业版' : '体验版')}</b></div>
                        <div class="row between"><span class="muted">加入时间</span><span>${fmtDate(user.joinedAt)}</span></div>
                        <div class="row between"><span class="muted">创作者等级</span><span>Lv.${user.level || 1}</span></div>
                        <a class="btn btn-outline" href="${url('wallet.html')}">管理订阅与充能</a>
                    </div>
                </div>
                <div class="card">
                    <div class="card-head"><div class="card-title">数据与隐私</div></div>
                    <div class="card-body small col" style="gap:10px">
                        <p class="muted" style="line-height:1.7">演示环境的全部数据保存在浏览器本地（localStorage），可随时导出备份或重置为初始状态。</p>
                        <button class="btn btn-outline" id="exportBtn">${icon('download', 14)}导出我的数据</button>
                        <button class="btn btn-danger-soft" id="resetBtn">${icon('refresh', 14)}重置演示数据</button>
                    </div>
                </div>
            </div>
        </div>`;
    }

    function bindSettings() {
        const body = host.querySelector('#profileBody');
        let avatarData = '';
        body.querySelector('#avatarFile')?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                avatarData = await readFileAsDataURL(file, 300);
                const img = body.querySelector('.avatar-lg');
                if (img) img.src = avatarData;
                toast('头像已选择，保存后生效');
            } catch (err) {
                toast(err.message, 'error');
            }
        });

        body.querySelector('#saveProfile')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.classList.add('loading');
            btn.disabled = true;
            try {
                const patch = {
                    name: body.querySelector('#setName').value,
                    handle: body.querySelector('#setHandle').value,
                    region: body.querySelector('#setRegion').value,
                    bio: body.querySelector('#setBio').value,
                    tags: body.querySelector('#setTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
                };
                if (avatarData) patch.avatar = avatarData;
                await updateProfile(patch);
                toast('资料已保存', 'success');
                data = await getCreator(me);
                draw();
                drawBody();
            } catch (err) {
                toast(err.message, 'error');
            } finally {
                btn.classList.remove('loading');
                btn.disabled = false;
            }
        });

        body.querySelector('#exportBtn')?.addEventListener('click', async () => {
            try {
                const json = await exportData();
                const blob = new Blob([json], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `lingxi-aigc-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(a.href);
                toast('数据已导出', 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
        });

        body.querySelector('#resetBtn')?.addEventListener('click', async () => {
            const ok = await confirmDialog({
                title: '重置演示数据',
                message: '所有作品、任务、账单与通知都会恢复为初始演示数据，当前修改无法恢复。',
                confirmText: '确认重置',
                danger: true
            });
            if (!ok) return;
            await resetDemo();
            toast('已重置为初始演示数据', 'success');
            window.setTimeout(() => window.location.reload(), 600);
        });
    }

    function editProfileDialog() {
        const user = currentPublicUser();
        openModal({
            title: '编辑资料',
            size: 'sm',
            body: `<div class="col" style="gap:12px">
                <div class="field" style="margin:0"><label class="label">昵称</label>
                    <input class="input" id="mName" value="${escapeHtml(user.name)}" maxlength="20"></div>
                <div class="field" style="margin:0"><label class="label">简介</label>
                    <textarea class="textarea" id="mBio" style="min-height:76px">${escapeHtml(user.bio || '')}</textarea></div>
                <div class="field" style="margin:0"><label class="label">标签</label>
                    <input class="input" id="mTags" value="${escapeHtml((user.tags || []).join(','))}" placeholder="用逗号分隔"></div>
            </div>`,
            footer: `<button class="btn btn-outline" data-close>取消</button>
                     <button class="btn btn-primary" id="mSave">保存</button>`,
            onMount(card, root) {
                root.querySelector('[data-close]')?.addEventListener('click', closeModal);
                card.querySelector('#mSave').addEventListener('click', async () => {
                    try {
                        await updateProfile({
                            name: card.querySelector('#mName').value,
                            bio: card.querySelector('#mBio').value,
                            tags: card.querySelector('#mTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
                        });
                        closeModal();
                        toast('资料已更新', 'success');
                        data = await getCreator(me);
                        draw();
                        drawBody();
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                });
            }
        });
    }
}

function coverBg(user) {
    const seed = (user.id || 'u').slice(-3);
    const hue = (seed.charCodeAt(0) * 37) % 360;
    return `linear-gradient(120deg, hsl(${hue} 62% 48%), hsl(${(hue + 48) % 360} 58% 38%))`;
}

function miniStat(label, value, sub, iconName) {
    return `<div class="metric">
        <div class="row" style="gap:8px">
            <span style="width:28px;height:28px;border-radius:8px;background:var(--brand-50);color:var(--brand-600);display:inline-flex;align-items:center;justify-content:center">${icon(iconName, 14)}</span>
            <span class="metric-label">${escapeHtml(label)}</span>
        </div>
        <div class="metric-value">${escapeHtml(String(value))}</div>
        <div class="metric-trend">${escapeHtml(sub)}</div>
    </div>`;
}
