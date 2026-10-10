/**
 * Model input-capability knowledge shared by the agents server and clients.
 *
 * Mirrors the approach of `reasoning.ts`: provider-specific model-id heuristics
 * rather than a scraped catalog, so the server can decide whether to send image
 * content to a model. Unknown providers/models default to text-only, which
 * degrades gracefully — attachments are then described to the model as metadata
 * instead of being sent as image parts.
 */
/**
 * Whether a model accepts image content in user messages. `providerType` is the
 * agents server provider type ('openai' | 'anthropic' | 'google' | ...); unknown
 * providers return false so image attachments fall back to metadata text.
 */
export declare function modelSupportsImageInput(providerType: string, modelId: string): boolean;
/** Default assumed for models no heuristic recognizes; conservative on purpose. */
export declare const DEFAULT_MODEL_CONTEXT_WINDOW = 128000;
/**
 * The context window (tokens) of a model, by the same provider-id heuristics as the input
 * capabilities above. Used to tell the model — and show the user — how full its context is, so
 * continuation can be decided while there is still room to write a careful handoff. Errs low
 * for unknown ids: a meter that reads a little high is a safer failure than one that reads
 * "plenty of room" as the provider starts rejecting requests.
 */
export declare function modelContextWindow(providerType: string, modelId: string): number;
