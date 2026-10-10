/**
 * Delegation budgets shared by the agents server and every settings UI.
 *
 * A run tree can fan out (children per run) and nest (delegation depth). Both are bounded by a
 * budget the root run is created with and every child inherits. "Thoroughness" is the
 * user-facing knob: a preset that maps onto those two numbers, chosen per agent as the default
 * and overridable per session, so a quick question and a deep research task can run under the
 * same agent without either being wrong.
 */
/** A user-selectable delegation preset, ordered from least to most delegation. */
export type Thoroughness = 'quick' | 'normal' | 'deep';
/** All presets in display order. */
export declare const THOROUGHNESS_LEVELS: Thoroughness[];
/** The preset in effect when neither the agent nor the session names one. */
export declare const DEFAULT_THOROUGHNESS: Thoroughness;
/** Delegation limits enforced from the run tree. */
export type DelegationLimits = {
    /**
     * Deepest allowed delegation depth. A user's or trigger's run is depth 0, a model child it
     * delegates is 1, that child's children are 2, and so on. Script children do not count: a
     * script is orchestration, not thinking, so a model child spawned from a script sits one level
     * below the script's own parent. A run at this depth is a leaf: it cannot delegate at all.
     */
    maxDepth: number;
    /** Most children one run may spawn (awaited or detached, model or script). */
    maxChildren: number;
};
export declare const THOROUGHNESS_PRESETS: Record<Thoroughness, DelegationLimits>;
/** Display label per preset, used by dropdowns and tags. */
export declare const THOROUGHNESS_LABELS: Record<Thoroughness, string>;
/** Short human explanation per preset, used by dropdowns and tooltips. */
export declare const THOROUGHNESS_DESCRIPTIONS: Record<Thoroughness, string>;
/** Type guard for values arriving from stored definitions or API input. */
export declare function isThoroughness(value: unknown): value is Thoroughness;
/** The limits a preset stands for. */
export declare function delegationLimitsFor(thoroughness: Thoroughness | undefined): DelegationLimits;
