/**
 * Curation helpers — which tokens get shown as "featured".
 *
 * Rarity scores come from the real generator, so the hero and the gallery lead
 * with fields that are genuinely scarce rather than hand-picked ids.
 */

import { COLLECTION } from '@/config'
import { deriveToken } from './traits'

let cache: number[] | null = null

/** Token ids with the highest rarity score across a sample of the supply. */
export function topRarityTokens(count = 8, sample = 900): number[] {
  if (cache) return cache.slice(0, count)
  const scored: { id: number; score: number }[] = []
  const supply = COLLECTION.maxSupply
  const step = Math.max(1, Math.floor(supply / sample))
  for (let id = 1; id <= supply; id += step) {
    scored.push({ id, score: deriveToken(id).rarityScore })
  }
  scored.sort((a, b) => b.score - a.score)
  cache = scored.map((s) => s.id)
  return cache.slice(0, count)
}

/** A spread of tokens for the gallery: some rare, some typical, evenly spaced. */
export function galleryTokens(count = 12): number[] {
  const rare = topRarityTokens(Math.ceil(count / 3))
  const supply = COLLECTION.maxSupply
  const rest: number[] = []
  const step = Math.max(1, Math.floor(supply / count))
  for (let id = 7; id <= supply && rest.length < count - rare.length; id += step) {
    if (!rare.includes(id)) rest.push(id)
  }
  return [...rare, ...rest].slice(0, count)
}

/** A single deterministic "hero" token. */
export function heroToken(): number {
  return topRarityTokens(1)[0] ?? 1
}
