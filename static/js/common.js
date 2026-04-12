// 公共方法

// 初始化导航菜单
function initNavMenu() {
    const isHomePage = window.location.pathname.endsWith('index.html') || window.location.pathname.endsWith('/');
    const isMyAssetsPage = window.location.pathname.endsWith('my-assets.html') || window.location.pathname.includes('my-assets-');
    
    if (isHomePage) {
        initHomeNavMenu();
    } else if (isMyAssetsPage) {
        initMyAssetsNavMenu();
    } else {
        initDefaultNavMenu();
    }
}

// 初始化首页导航菜单
function initHomeNavMenu() {
    const subNavMenus = document.querySelectorAll('.sub-nav-menu');
    // 首页二级菜单默认隐藏
    // subNavMenus.forEach(menu => {
    //     menu.style.display = 'none';
    // });
    
    bindHomeNavEvents();
    bindSubNavEvents();
}

// 初始化我的资产导航菜单
function initMyAssetsNavMenu() {
    const subNavMenus = document.querySelectorAll('.sub-nav-menu');
    // 隐藏其他导航项的二级菜单
    subNavMenus.forEach(menu => {
        menu.style.display = 'none';
    });
    
    // 展开我的资产的二级菜单
    const myAssetsNav = document.querySelector('.nav-link[href="my-assets.html"]');
    if (myAssetsNav) {
        const subNavMenu = myAssetsNav.nextElementSibling;
        if (subNavMenu && subNavMenu.classList.contains('sub-nav-menu')) {
            subNavMenu.style.display = 'block';
        }
    }
    
    bindMyAssetsNavEvents();
    bindSubNavEvents();
}

// 初始化默认导航菜单
function initDefaultNavMenu() {
    const subNavMenus = document.querySelectorAll('.sub-nav-menu');
    // 其他页面二级菜单默认隐藏
    subNavMenus.forEach(menu => {
        menu.style.display = 'none';
    });
    
    bindDefaultNavEvents();
    bindSubNavEvents();
}

// 绑定首页导航菜单事件
function bindHomeNavEvents() {
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            // 检查点击的目标是否是二级导航链接
            if (e.target.closest('.sub-nav-link')) {
                return; // 如果是二级导航链接，不处理
            }
            
            // 检查是否有子菜单
            const subNavMenu = link.nextElementSibling;
            const hasSubMenu = subNavMenu && subNavMenu.classList.contains('sub-nav-menu');
            
            // 阻止默认行为
            if (hasSubMenu) {
                e.preventDefault();
            }
            
            // 处理二级菜单
            if (hasSubMenu) {
                subNavMenu.style.display = subNavMenu.style.display === 'none' ? 'block' : 'none';
            }
            
            // 隐藏其他导航项的二级菜单
            navLinks.forEach(otherLink => {
                if (otherLink !== link) {
                    const otherSubNavMenu = otherLink.nextElementSibling;
                    if (otherSubNavMenu && otherSubNavMenu.classList.contains('sub-nav-menu')) {
                        otherSubNavMenu.style.display = 'none';
                    }
                }
            });
        });
    });
}

// 绑定我的资产导航菜单事件
function bindMyAssetsNavEvents() {
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            // 检查点击的目标是否是二级导航链接
            if (e.target.closest('.sub-nav-link')) {
                return; // 如果是二级导航链接，不处理
            }
            
            // 检查是否有子菜单
            const subNavMenu = link.nextElementSibling;
            const hasSubMenu = subNavMenu && subNavMenu.classList.contains('sub-nav-menu');
            
            // 只有点击我的资产导航时才处理二级菜单
            if (link.getAttribute('href') === 'my-assets.html' && hasSubMenu) {
                e.preventDefault();
                subNavMenu.style.display = subNavMenu.style.display === 'none' ? 'block' : 'none';
            }
            
            // 隐藏其他导航项的二级菜单
            navLinks.forEach(otherLink => {
                if (otherLink !== link) {
                    const otherSubNavMenu = otherLink.nextElementSibling;
                    if (otherSubNavMenu && otherSubNavMenu.classList.contains('sub-nav-menu')) {
                        otherSubNavMenu.style.display = 'none';
                    }
                }
            });
        });
    });
}

// 绑定默认导航菜单事件
function bindDefaultNavEvents() {
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            // 检查点击的目标是否是二级导航链接
            if (e.target.closest('.sub-nav-link')) {
                return; // 如果是二级导航链接，不处理
            }
            
            // 其他页面不处理二级菜单，直接跳转
        });
    });
}

// 绑定二级导航菜单事件
function bindSubNavEvents(callback) {
    const subNavLinks = document.querySelectorAll('.sub-nav-link');
    subNavLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            // 阻止事件冒泡，防止触发导航链接的点击事件
            e.stopPropagation();
            
            // 切换二级导航项的active状态
            subNavLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            
            // 调用回调函数处理具体逻辑
            if (callback) {
                callback(link);
            }
        });
    });
}