/** The Surfaces the daily sweep collects from. */
import type { SurfaceAdapter, SurfaceId } from '../types'
import { chatgptAdapter } from './chatgpt'
import { geminiAdapter } from './gemini'
import { perplexityAdapter } from './perplexity'

export const SURFACE_ADAPTERS: SurfaceAdapter[] = [chatgptAdapter, perplexityAdapter, geminiAdapter]

/** Takes a plain string so callers can validate an untrusted Surface name by lookup. */
export const adapterFor = (surface: string): SurfaceAdapter | undefined =>
  SURFACE_ADAPTERS.find((adapter) => adapter.surface === surface)

/** Surfaces offered as filters across the dashboard. */
export const ACTIVE_SURFACES: SurfaceId[] = SURFACE_ADAPTERS.map((adapter) => adapter.surface)
