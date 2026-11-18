import { ref } from 'vue'
import { en } from './locales/en'

type Key = keyof typeof en
type PluralMessage = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }
export type Catalog = Partial<Record<Key, string | PluralMessage>>
type Params = Record<string, string | number>

const catalogs: Record<string, Catalog> = { en }
export const locale = ref('en')

export function registerLocale(name: string, catalog: Catalog) {
  catalogs[name.toLowerCase()] = catalog
}

export function selectLocale(preferences: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages) {
  for (const preference of preferences) {
    let candidate = preference.toLowerCase()
    while (candidate) {
      if (catalogs[candidate]) { locale.value = candidate; return candidate }
      const separator = candidate.lastIndexOf('-')
      if (separator < 0) break
      candidate = candidate.slice(0, separator)
    }
  }
  locale.value = 'en'
  return locale.value
}

export function t(key: Key, params: Params = {}): string {
  const translated = catalogs[locale.value]?.[key]
  const message: string | PluralMessage = translated ?? en[key]
  const text = typeof message === 'string' ? message : message[new Intl.PluralRules(translated === undefined ? 'en' : locale.value).select(Number(params.count ?? 0))] ?? message.other
  return text.replace(/\{(\w+)\}/g, (match, name: string) => params[name] === undefined ? match : String(params[name]))
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleString(locale.value)
}
