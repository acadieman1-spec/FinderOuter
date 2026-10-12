/**
 * Trait model + derivation.
 *
 * `deriveCore(tokenId)` is the single source of truth: one pure function turns
 * a token id into a palette, a composition, continuous art parameters and the
 * discrete traits shown in the UI. `deriveToken` wraps it with the noise field
 * the renderer needs and attaches rarity.
 *
 * Because `deriveCore` never touches a canvas, the rarity table is computed by
 * simply running it over the whole supply (`buildRarityTable`) — the numbers in
 * the UI are the real distribution, not hand-written marketing copy.
 */

import { COLLECTION } from '@/config'
import { Noise, Rng, clamp, luminance } from './prng'

export const GENERATOR_VERSION = COLLECTION.generatorVersion

export interface Palette {
  id: string
  name: string
  bg: string
  colors: string[]
  weight: number
}

/** Vibrant fields. Weights drive both pick probability and reported rarity. */
export const PALETTES: readonly Palette[] = [
  {
    id: 'solar_flare',
    name: 'Solar Flare',
    bg: '#14060c',
    colors: ['#FF3D68', '#FF7A45', '#FFC24B', '#FFE9A8', '#C41E5A'],
    weight: 26,
  },
  {
    id: 'cyanotype',
    name: 'Cyanotype',
    bg: '#04121c',
    colors: ['#0AF0E2', '#2AB7FF', '#7B6CFF', '#E6FBFF', '#066E8C'],
    weight: 22,
  },
  {
    id: 'coral_reef',
    name: 'Coral Reef',
    bg: '#0b1418',
    colors: ['#FF6F59', '#FFB03A', '#40E0D0', '#F7FFF7', '#C73E1D'],
    weight: 14,
  },
  {
    id: 'citrus_press',
    name: 'Citrus Press',
    bg: '#141003',
    colors: ['#FFD60A', '#FF9E00', '#7CFF6B', '#FFF3B0', '#B26B00'],
    weight: 12,
  },
  {
    id: 'ultraviolet',
    name: 'Ultraviolet',
    bg: '#08061a',
    colors: ['#7C4DFF', '#3D8BFF', '#FF4DD2', '#C9D6FF', '#2A1B6B'],
    weight: 10,
  },
  {
    id: 'acid_bloom',
    name: 'Acid Bloom',
    bg: '#08120a',
    colors: ['#B8FF4D', '#4DFFB4', '#F2FF7A', '#1FBF75', '#0A3D2A'],
    weight: 8,
  },
  {
    id: 'magenta_static',
    name: 'Magenta Static',
    bg: '#14041a',
    colors: ['#FF3DF0', '#A56BFF', '#FF8AD8', '#6D2BD9', '#FFE6FF'],
    weight: 6,
  },
  {
    id: 'void_prism',
    name: 'Void Prism',
    bg: '#05050a',
    colors: ['#F5F5F7', '#FF3D68', '#37E7FF', '#B8FF4D', '#A06BFF'],
    weight: 2,
  },
]

export const COMPOSITIONS = [
  { id: 'flow', name: 'Flowfield', weight: 24 },
  { id: 'strata', name: 'Strata', weight: 22 },
  { id: 'orbit', name: 'Orbital', weight: 18 },
  { id: 'bloom', name: 'Rosette', weight: 16 },
  { id: 'shards', name: 'Fracture', weight: 12 },
  { id: 'halo', name: 'Eclipse', weight: 8 },
] as const

export type CompositionId = (typeof COMPOSITIONS)[number]['id']

export const DENSITIES = ['Sparse', 'Balanced', 'Dense'] as const
export type Density = (typeof DENSITIES)[number]

export const LUMINOSITIES = ['Nocturnal', 'Balanced', 'Solar'] as const
export type Luminosity = (typeof LUMINOSITIES)[number]

export const GRAINS = ['Silky', 'Textured', 'Coarse'] as const
export type Grain = (typeof GRAINS)[number]

export const ANOMALIES = [
  { id: 'none', name: 'None', weight: 76 },
  { id: 'ghost_ring', name: 'Ghost Ring', weight: 8 },
  { id: 'chroma_bleed', name: 'Chroma Bleed', weight: 7 },
  { id: 'void_core', name: 'Void Core', weight: 5 },
  { id: 'prism_fracture', name: 'Prism Fracture', weight: 4 },
] as const

export type AnomalyId = (typeof ANOMALIES)[number]['id']

export interface ArtParams {
  rotation: number
  warp: number
  noiseScale: number
  layers: number
  particles: number
  bands: number
  rings: number
  blobScale: number
  contrast: number
  offset: { x: number; y: number }
  strokeScale: number
  glow: number
}

/** Everything the renderer + rarity table need, derived without a canvas. */
export interface CoreSpec {
  tokenId: number
  seed: number
  palette: Palette
  composition: CompositionId
  compositionName: string
  density: Density
  luminosity: Luminosity
  grain: Grain
  anomaly: AnomalyId
  anomalyName: string
  params: ArtParams
}

export interface Trait {
  key: string
  name: string
  value: string
  /** 0..1 — share of the supply carrying this exact value. */
  frequency: number
  count: number
}

export interface TokenSpec extends CoreSpec {
  noise: Noise
  traits: Trait[]
  /** 1..100, higher = rarer (normalised inverse-frequency sum). */
  rarityScore: number
}

const PALETTE_WEIGHTS = PALETTES.map((p) => p.weight)
const COMPOSITION_IDS = COMPOSITIONS.map((c) => c.id)
const COMPOSITION_WEIGHTS = COMPOSITIONS.map((c) => c.weight)
const ANOMALY_IDS = ANOMALIES.map((a) => a.id)
const ANOMALY_WEIGHTS = ANOMALIES.map((a) => a.weight)

const COMPOSITION_NAMES: Record<CompositionId, string> = Object.fromEntries(
  COMPOSITIONS.map((c) => [c.id, c.name]),
) as Record<CompositionId, string>

const ANOMALY_NAMES: Record<AnomalyId, string> = Object.fromEntries(
  ANOMALIES.map((a) => [a.id, a.name]),
) as Record<AnomalyId, string>

function seedForToken(tokenId: number): number {
  return new Rng(`CHROMAFIELD|${GENERATOR_VERSION}|${tokenId}`).int(1, 0x7fffffff)
}

/**
 * The generator's discrete decisions + continuous parameters.
 * RNG call order is load-bearing: changing it changes every artwork.
 */
export function deriveCore(tokenId: number): CoreSpec {
  const seed = seedForToken(tokenId)
  const rng = new Rng(seed)

  const palette = rng.weighted(PALETTES, PALETTE_WEIGHTS)
  const composition = rng.weighted(COMPOSITION_IDS, COMPOSITION_WEIGHTS)
  const anomaly = rng.weighted(ANOMALY_IDS, ANOMALY_WEIGHTS)

  const densityRoll = rng.float()
  const density: Density = densityRoll < 0.3 ? 'Sparse' : densityRoll < 0.75 ? 'Balanced' : 'Dense'
  const densityMul = density === 'Sparse' ? 0.55 : density === 'Balanced' ? 1 : 1.7

  const lumaRoll = rng.float()
  const luminosity: Luminosity =
    lumaRoll < 0.3 ? 'Nocturnal' : lumaRoll < 0.75 ? 'Balanced' : 'Solar'
  const lumaMul = luminosity === 'Nocturnal' ? 0.55 : luminosity === 'Balanced' ? 1 : 1.4

  const grainRoll = rng.float()
  const grain: Grain = grainRoll < 0.4 ? 'Silky' : grainRoll < 0.8 ? 'Textured' : 'Coarse'

  const params: ArtParams = {
    rotation: rng.float(0, Math.PI * 2),
    warp: rng.float(0.15, 1) * (density === 'Dense' ? 1.25 : 1),
    noiseScale: rng.float(0.7, 2.6),
    layers: Math.round(clamp(4 + 9 * densityMul, 3, 18)),
    particles: Math.round(clamp(120 * densityMul, 40, 260)),
    bands: Math.round(clamp(6 * densityMul, 3, 14)),
    rings: Math.round(clamp(7 * densityMul, 3, 16)),
    blobScale: rng.float(0.55, 1.5),
    contrast: 0.75 + rng.float(0, 0.6) * lumaMul,
    offset: { x: rng.float(-0.18, 0.18), y: rng.float(-0.18, 0.18) },
    strokeScale: rng.float(0.6, 2.1),
    glow: clamp(0.25 + rng.float(0, 0.75) * lumaMul, 0.1, 1),
  }

  return {
    tokenId,
    seed,
    palette,
    composition,
    compositionName: COMPOSITION_NAMES[composition],
    density,
    luminosity,
    grain,
    anomaly,
    anomalyName: ANOMALY_NAMES[anomaly],
    params,
  }
}

const coreCache = new Map<number, CoreSpec>()
const specCache = new Map<number, TokenSpec>()

export function coreOf(tokenId: number): CoreSpec {
  const hit = coreCache.get(tokenId)
  if (hit) return hit
  const spec = deriveCore(tokenId)
  coreCache.set(tokenId, spec)
  return spec
}

export function deriveToken(tokenId: number): TokenSpec {
  const hit = specCache.get(tokenId)
  if (hit) return hit

  const core = coreOf(tokenId)
  const light = traitsFor(tokenId)
  const spec: TokenSpec = {
    ...core,
    noise: new Noise(core.seed ^ 0x9e3779b9),
    traits: light.traits,
    rarityScore: light.rarityScore,
  }
  specCache.set(tokenId, spec)
  return spec
}

const lightCache = new Map<number, { traits: Trait[]; rarityScore: number }>()

/**
 * Traits + rarity score without allocating a noise field — cheap enough to run
 * over the whole supply for filtering and sorting in the gallery.
 */
export function traitsFor(tokenId: number): { traits: Trait[]; rarityScore: number } {
  const hit = lightCache.get(tokenId)
  if (hit) return hit
  const traits = traitsOf(coreOf(tokenId))
  const value = { traits, rarityScore: rarityScoreOf(traits) }
  lightCache.set(tokenId, value)
  return value
}

function traitsOf(spec: CoreSpec): Trait[] {
  const table = buildRarityTable()
  const make = (key: string, name: string, value: string): Trait => {
    const entry = table.get(`${key}:${value}`)
    return { key, name, value, count: entry?.count ?? 0, frequency: entry?.frequency ?? 0 }
  }
  return [
    make('palette', 'Palette', spec.palette.name),
    make('composition', 'Composition', spec.compositionName),
    make('density', 'Density', spec.density),
    make('luminosity', 'Luminosity', spec.luminosity),
    make('grain', 'Grain', spec.grain),
    make('anomaly', 'Anomaly', spec.anomalyName),
  ]
}

/* ------------------------------------------------------------------ rarity */

export interface RarityEntry {
  key: string
  value: string
  count: number
  frequency: number
  /** supply / count — rarer values score higher. */
  weight: number
}

export interface RaritySummary {
  supply: number
  byKey: Record<string, RarityEntry[]>
  groups: { key: string; name: string }[]
}

const tables = new Map<number, Map<string, RarityEntry>>()
const summaries = new Map<number, RaritySummary>()

export const TRAIT_GROUPS = [
  { key: 'palette', name: 'Palette' },
  { key: 'composition', name: 'Composition' },
  { key: 'anomaly', name: 'Anomaly' },
  { key: 'density', name: 'Density' },
  { key: 'luminosity', name: 'Luminosity' },
  { key: 'grain', name: 'Grain' },
] as const

/** Runs the real generator over the whole supply once, then memoises. */
export function buildRarityTable(supply: number = COLLECTION.maxSupply): Map<string, RarityEntry> {
  const cached = tables.get(supply)
  if (cached) return cached

  const counts = new Map<string, number>()
  const bump = (key: string, value: string) => {
    const id = `${key}:${value}`
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  for (let id = 1; id <= supply; id++) {
    const core = deriveCore(id)
    bump('palette', core.palette.name)
    bump('composition', core.compositionName)
    bump('density', core.density)
    bump('luminosity', core.luminosity)
    bump('grain', core.grain)
    bump('anomaly', core.anomalyName)
  }

  const out = new Map<string, RarityEntry>()
  for (const [id, count] of counts) {
    const sep = id.indexOf(':')
    const key = id.slice(0, sep)
    const value = id.slice(sep + 1)
    out.set(id, { key, value, count, frequency: count / supply, weight: supply / count })
  }
  tables.set(supply, out)
  return out
}

export function raritySummary(supply: number = COLLECTION.maxSupply): RaritySummary {
  const cached = summaries.get(supply)
  if (cached) return cached
  const table = buildRarityTable(supply)
  const byKey: Record<string, RarityEntry[]> = {}
  for (const entry of table.values()) {
    ;(byKey[entry.key] ??= []).push(entry)
  }
  for (const key of Object.keys(byKey)) byKey[key].sort((a, b) => a.count - b.count)
  const summary: RaritySummary = { supply, byKey, groups: [...TRAIT_GROUPS] }
  summaries.set(supply, summary)
  return summary
}

/** 1..100 — inverse-frequency score normalised across six traits. */
function rarityScoreOf(traits: Trait[]): number {
  const raw = traits.reduce((sum, t) => sum + (t.frequency > 0 ? 1 / t.frequency : 12), 0)
  return clamp(Math.round(((raw - 12) / 90) * 100), 1, 100)
}

export function tokenLabel(tokenId: number): string {
  return `#${tokenId.toString().padStart(4, '0')}`
}

/** Mean luma of a palette — used to choose readable overlay text. */
export function paletteLuma(palette: Palette): number {
  return palette.colors.reduce((sum, c) => sum + luminance(c), 0) / palette.colors.length
}
