/**
 * Seed agents UI for apps outside the Seed monorepo.
 *
 * ```tsx
 * import {SeedAgentsProvider, SeedAgentsView} from '@seed-hypermedia/agents-ui'
 * import '@seed-hypermedia/agents-ui/styles.css'
 *
 * <SeedAgentsProvider host={{serverUrl, signer}}>
 *   <SeedAgentsView />
 * </SeedAgentsProvider>
 * ```
 */
export { SeedAgentsProvider, useSeedAgentsHost, useSeedAgentsNavigate, useSeedAgentsRoute } from './provider.js';
export type { SeedAgentsProviderProps } from './provider.js';
export { SeedAgentsAssistant, SeedAgentsView } from './view.js';
export type { SeedAgentsAssistantProps } from './view.js';
export { isSeedAgentsRoute, seedAgentsRouteFromPath, seedAgentsRouteToPath, seedAgentsRouteToWebUrl } from './routes.js';
export type { SeedAgentTab, SeedAgentsRoute } from './routes.js';
export { AgentProtocolError, AgentServerError, createSeedAgentsClient } from './client.js';
export type { SeedAgentsAction, SeedAgentsClient, SeedAgentsResponseFor } from './client.js';
export type { SeedAgentsBlockNode, SeedAgentsDelegation, SeedAgentsEditorGetContent, SeedAgentsEditorHandle, SeedAgentsEditorProps, SeedAgentsHost, SeedAgentsNavigationMode, SeedAgentsSettingsStore, SeedAgentsSigner, } from './host.js';
/** Wire types of the agents service: actions, responses, sessions, events, runs, tools. */
export type * as AgentsProtocol from './protocol/index.js';
export { AGENTS_PROTOCOL_VERSION } from './protocol/index.js';
