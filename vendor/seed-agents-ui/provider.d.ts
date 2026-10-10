import * as React from 'react';
import type { SeedAgentsHost, SeedAgentsNavigationMode } from './host.js';
import { type SeedAgentsRoute } from './routes.js';
/** The host the nearest {@link SeedAgentsProvider} was given. */
export declare function useSeedAgentsHost(): SeedAgentsHost;
/** Navigates the agents UI from host code (a sidebar, a command palette, a notification). */
export declare function useSeedAgentsNavigate(): (route: SeedAgentsRoute, mode?: SeedAgentsNavigationMode) => void;
/** The route the agents UI currently shows. */
export declare function useSeedAgentsRoute(): SeedAgentsRoute;
export type SeedAgentsProviderProps = {
    host: SeedAgentsHost;
    /**
     * The route to show. Pass it to keep the agents UI in step with the host's URL; the provider
     * follows changes to it. Omit it to let the agents UI navigate on its own.
     */
    route?: SeedAgentsRoute;
    /** Called after every navigation inside the agents UI (push or replace), with the new route. */
    onRouteChange?: (route: SeedAgentsRoute, mode: Exclude<SeedAgentsNavigationMode, 'spawn'>) => void;
    /**
     * Opens a route in a new window ("open in new tab"). Without it, such links open Seed's web app
     * on the gateway.
     */
    openRouteInNewWindow?: (route: SeedAgentsRoute) => void;
    children: React.ReactNode;
};
/**
 * Supplies everything the Seed agents UI needs: the host's signer and server, a query cache, its
 * own navigation stack, and a Seed API client for accounts and documents. Render one per page;
 * the agents UI registers a single platform adapter.
 */
export declare function SeedAgentsProvider({ host, route, onRouteChange, openRouteInNewWindow, children, }: SeedAgentsProviderProps): import("react/jsx-runtime").JSX.Element;
