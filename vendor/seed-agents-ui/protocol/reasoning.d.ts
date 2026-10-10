/**
 * Model reasoning knowledge shared by the agents server and every model-picker UI.
 *
 * The level lists are empirically verified against the live provider APIs (see the
 * per-provider notes below) rather than scraped from a catalog, because providers
 * gate levels per model generation — e.g. OpenAI's gpt-5 family accepts `minimal`
 * but not `none`, gpt-5.1+ accepts `none` but not `minimal`, and gpt-6 drops `none`
 * again while adding `max`.
 *
 * The matrix is a first guess, not the last word: the server also learns from a
 * provider's own rejection of an effort value at run time (see
 * `learnReasoningEffortSupport` in the agents server), so a model this file does not
 * know yet degrades to a corrected request rather than a permanently failing agent.
 */
/** A user-selectable reasoning level, ordered from least to most reasoning. */
export type ReasoningLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** All levels in display order. */
export declare const REASONING_LEVELS: ReasoningLevel[];
/** Display label per level, used by dropdowns and tags. */
export declare const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string>;
/** Short human explanation per level, used by dropdowns and tag tooltips. */
export declare const REASONING_LEVEL_DESCRIPTIONS: Record<ReasoningLevel, string>;
/**
 * What "no level selected" means for a model:
 * - `off`: the model does no reasoning (the server disables or omits it).
 * - `default`: reasoning cannot be turned off; the provider's default level applies.
 */
export type ReasoningOffBehavior = 'off' | 'default';
export type ModelReasoningSupport = {
    /** Levels the model accepts, in display order. */
    levels: ReasoningLevel[];
    /** Meaning of leaving the reasoning level unset. */
    offBehavior: ReasoningOffBehavior;
    /**
     * The model accepts an explicit "no reasoning" value (OpenAI `reasoning_effort:
     * 'none'`). Newer OpenAI chat models (gpt-5.1+) default reasoning ON server-side
     * and reject function tools unless reasoning is explicitly disabled, so the
     * server must send `none` rather than omitting the field.
     */
    supportsEffortNone: boolean;
    /**
     * The model must be driven through OpenAI's Responses API even when no level is
     * chosen. gpt-5.1 and newer reason by default server-side and reject function
     * tools on /v1/chat/completions unless reasoning is explicitly configured there;
     * the Responses API is OpenAI's supported path for tools plus reasoning. Older
     * reasoning models (gpt-5.0, o-series) accept tools on chat completions and stay
     * on that path while their level is unset.
     */
    requiresResponsesApi: boolean;
};
/**
 * Returns the reasoning support for a model, or null when the model (or the
 * provider type) has no controllable reasoning. `providerType` is the agents
 * server provider type ('openai' | 'anthropic' | 'google' | ...).
 */
export declare function modelReasoningSupport(providerType: string, modelId: string): ModelReasoningSupport | null;
/** Type guard for values arriving from stored definitions or API input. */
export declare function isReasoningLevel(value: unknown): value is ReasoningLevel;
