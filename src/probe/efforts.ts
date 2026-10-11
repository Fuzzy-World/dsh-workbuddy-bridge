/**
 * The one place that decides what thinking levels a model offers, and why.
 *
 * Both halves of the plugin ask this question — the model picker (through the
 * adapter's `thinkingLevelMap`) and the composer's bulb (through the status
 * document) — and a second implementation of it is how the two came to
 * disagree: the picker offered levels for a model the composer showed no
 * control for, so "no bulb" and "switchable" looked unrelated to the user.
 *
 * The rule, in strict order:
 *
 * 1. **A declared set wins.** When the upstream names a non-empty
 *    `supportedEfforts`, exactly those values are offered. No observation ever
 *    widens or narrows it, which is also why such a row is not detectable: a
 *    sweep would spend credit to learn something already known.
 * 2. **A validating observation supplies a set** for rows the upstream left
 *    undeclared. The offered set is "verified accepted", never "verified
 *    effective" — acceptance proves the upstream did not reject the spelling,
 *    not that it changes what the model does.
 * 3. **Otherwise there is no switch.** A `non-validating` observation lands
 *    here deliberately: the upstream accepts values that cannot exist
 *    (measured on `glm-5.2`), so every per-level acceptance it produced would
 *    be a false positive. Such a row stays *detectable*, because that verdict
 *    describes today's upstream rather than the model.
 *
 * `off` is a separate capability, offered only when the upstream declares
 * `canDisableThinking: true` alongside a declared set. It is never probed:
 * disabling thinking cannot be inferred from a row's shape.
 *
 * A second, smaller judgement lives here too: {@link resolveDefaultEffort},
 * which names the one level a switchable model should *default* to. It stays
 * beside {@link resolveEfforts} because it is a function of the offered set —
 * the default must be a member of it — and splitting the two across modules is
 * how the offered set and its default come to disagree.
 *
 * @module dsh-workbuddy-bridge/probe/efforts
 */

import type { WorkBuddyModelInfo } from '../catalog/index.ts'
import type { WorkBuddyEffort } from '../protocol/client.ts'
import type { WorkBuddyProbeRecord } from '../probe/store.ts'

/** Where a model's offered levels came from. */
export type WorkBuddyEffortSource = 'declared' | 'observed' | 'none'

/** What a model's thinking-level switch looks like right now. */
export interface WorkBuddyEffortResolution {
  /**
   * Levels the picker offers, in upstream order.
   *
   * **Empty means the model cannot switch thinking.** This is the single field
   * both halves key on, so the picker's list and the composer's bulb cannot
   * describe different things.
   */
  efforts: readonly WorkBuddyEffort[]
  /** Where {@link efforts} came from. */
  source: WorkBuddyEffortSource
  /**
   * Whether a detection could change this answer.
   *
   * False for a declared set (the declaration wins) and for a model that does
   * not reason at all.
   */
  detectable: boolean
  /**
   * Whether the picker also offers "off".
   *
   * Declaration-only, and phrased as its own fact rather than a member of
   * {@link efforts}: it is not a thinking level, so counting it as one would
   * make a model with no levels look switchable.
   */
  canDisable: boolean
}

/** The resolution for a model that does not reason: no switch, nothing to detect. */
const NO_SWITCH: WorkBuddyEffortResolution = {
  efforts: [],
  source: 'none',
  detectable: false,
  canDisable: false,
}

/**
 * Resolve one model's thinking-level switch.
 *
 * @param info - the catalog row, whose `reasoning` block carries any declaration.
 * @param observed - this account's recorded detection for the model, if any.
 */
export function resolveEfforts(
  info: WorkBuddyModelInfo,
  observed?: WorkBuddyProbeRecord | undefined,
): WorkBuddyEffortResolution {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) return NO_SWITCH

  const declared = reasoning.supportedEfforts
  if (declared !== undefined && declared.length > 0) {
    return {
      efforts: declared,
      source: 'declared',
      // A declaration always wins, so there is nothing a sweep could add.
      detectable: false,
      canDisable: reasoning.canDisableThinking === true,
    }
  }

  // Undeclared. Only a validating observation may supply a set; anything else
  // (no record, `unknown`, `non-validating`) leaves the model without a switch
  // but still worth detecting — `unknown` because the last run proved nothing,
  // `non-validating` because that verdict can change with the upstream.
  if (observed?.validation === 'validating' && observed.efforts.length > 0) {
    return { efforts: observed.efforts, source: 'observed', detectable: true, canDisable: false }
  }
  return { efforts: [], source: 'none', detectable: true, canDisable: false }
}

/**
 * The level a switchable model defaults to, or undefined when it has no switch.
 *
 * **Why this is not simply the upstream's `defaultEffort`.** The host's model
 * picker adds a "Default" item — "follow whatever the provider does" — exactly
 * when a model reports no default; reporting one is what removes that item. The
 * upstream's own answer is used whenever it names a level the offered set
 * contains, because that is the only defensible source: it is what the provider
 * itself would do with no `reasoning_effort` on the wire.
 *
 * `high` backs it up otherwise, and the asymmetry is deliberate. A row can
 * declare a set while naming no default, and a stale `defaultEffort` can name a
 * level a narrower declared set no longer offers (`defaultEffort: 'low'` beside
 * `supportedEfforts: ['high']`). Both leave the level unpinned, and the chosen
 * behaviour is to pin it anyway: a wrong-but-explicit level is a one-click fix
 * in the picker, while a silent "follow the provider" is not even visible.
 *
 * The fallback therefore never strays outside the offered set. A model whose set
 * excludes `high` falls back to its first offered level — naming a level the
 * model cannot accept would make every request that omits an effort fail
 * `UNSUPPORTED_REASONING_EFFORT`, which is the failure the `reasoning-merge`
 * specs exist to prevent.
 *
 * @param info - the catalog row, whose `reasoning.defaultEffort` may name one.
 * @param offered - the offered levels, in order; the answer is always a member.
 * @returns a member of `offered`, or undefined when nothing is offered.
 */
export function resolveDefaultEffort(
  info: WorkBuddyModelInfo,
  offered: readonly WorkBuddyEffort[],
): WorkBuddyEffort | undefined {
  if (offered.length === 0) return undefined
  const declared = info.reasoning?.defaultEffort
  if (declared !== undefined && offered.includes(declared)) return declared
  return offered.includes('high') ? 'high' : offered[0]
}
