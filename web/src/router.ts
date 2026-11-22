import { createRouter, createWebHistory } from 'vue-router';
export const router = createRouter({ history: createWebHistory(), routes: [
  { path: '/', name: 'overview', component: () => import('./pages/OverviewPage.vue'), meta: { title: '工作总览' } },
  { path: '/shops', name: 'shops', component: () => import('./pages/ShopsPage.vue'), meta: { title: '店铺账号' } },
  { path: '/prices', name: 'prices', component: () => import('./pages/PricesPage.vue'), meta: { title: '商品价格' } },
  { path: '/tasks', name: 'tasks', component: () => import('./pages/TasksPage.vue'), meta: { title: '采集任务' } },
  { path: '/tasks/new', component: () => import('./pages/TaskEditPage.vue'), meta: { title: '新建采集任务' } },
  { path: '/tasks/:id/edit', component: () => import('./pages/TaskEditPage.vue'), meta: { title: '编辑采集任务' } },
  { path: '/alert-tasks', name: 'alert-tasks', component: () => import('./pages/AlertTasksPage.vue'), meta: { title: '预警任务' } },
  { path: '/alert-tasks/new', component: () => import('./pages/AlertTaskEditPage.vue'), meta: { title: '新建预警任务' } },
  { path: '/alert-tasks/:id/edit', component: () => import('./pages/AlertTaskEditPage.vue'), meta: { title: '编辑预警任务' } },
  { path: '/alerts', name: 'alerts', component: () => import('./pages/AlertsPage.vue'), meta: { title: '预警记录' } },
  { path: '/settings', name: 'settings', component: () => import('./pages/SettingsPage.vue'), meta: { title: '系统设置' } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
] });
router.afterEach(to => { document.title = `${String(to.meta.title || '控制台')} · 价巡`; });
