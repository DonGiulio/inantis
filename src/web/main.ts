import { createApp, watchEffect } from 'vue'
import App from './App.vue'
import './style.css'
import { locale, selectLocale, t } from './i18n'

selectLocale()
watchEffect(() => {
  document.documentElement.lang = locale.value
  document.title = t('appTitle')
})

createApp(App).mount('#app')
