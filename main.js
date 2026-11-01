import App from './App'
import { createSSRApp } from 'vue'
import AuroraBg from './components/aurora-bg/aurora-bg.vue'
import AnnBanner from './components/ann-banner/ann-banner.vue'

export function createApp() {
  const app = createSSRApp(App)
  // 全局注册极光背景，各页面直接写 <aurora-bg />
  app.component('AuroraBg', AuroraBg)
  // 全局注册公告横幅，各页面直接写 <ann-banner />
  app.component('AnnBanner', AnnBanner)
  return {
    app
  }
}
