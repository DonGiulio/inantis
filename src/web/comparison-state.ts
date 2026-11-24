export type ComparisonMode = 'working' | 'upstream' | 'branch' | 'ref'

export function restoreComparison(saved: { mode?: unknown; reference?: unknown; launchBase?: unknown }, launchBase: string | null): { mode: ComparisonMode; reference: string } {
  if ((saved.launchBase ?? null) === launchBase && (saved.mode === 'working' || saved.mode === 'upstream' || saved.mode === 'branch' || saved.mode === 'ref')) {
    return { mode: saved.mode, reference: typeof saved.reference === 'string' ? saved.reference : launchBase ?? '' }
  }
  return { mode: 'branch', reference: launchBase ?? '' }
}
