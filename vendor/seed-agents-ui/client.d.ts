import type { AgentResponse, ErrorResponse, ProtocolErrorCode, UnsignedAgentAction } from './protocol/index.js';
import type { SeedAgentsSigner } from './host.js';
/** Any action the agents service accepts, without its signature and timestamp. */
export type SeedAgentsAction = UnsignedAgentAction;
/** The response the agents service sends for an action: `GetSession` answers `GetSessionResponse`. */
export type SeedAgentsResponseFor<A extends SeedAgentsAction> = [
    Extract<AgentResponse, {
        _: `${A['_']}Response`;
    }>
] extends [never] ? Exclude<AgentResponse, ErrorResponse> : Extract<AgentResponse, {
    _: `${A['_']}Response`;
}>;
/** Calls the agents service directly, outside the UI, with the host's signer. */
export type SeedAgentsClient = {
    /** Signs and sends one action. Server errors throw (`AgentServerError`, with `status` and `code`). */
    send: <A extends SeedAgentsAction>(action: A) => Promise<SeedAgentsResponseFor<A>>;
};
/** A typed client for the agents service at `serverUrl`, signing as `signer`. */
export declare function createSeedAgentsClient({ serverUrl, signer, }: {
    serverUrl: string;
    signer: SeedAgentsSigner;
}): SeedAgentsClient;
/** An error the agents server answered with (as opposed to a failed connection). */
export type AgentServerError = Error & {
    readonly status: number;
    /** The server's machine-readable cause, when it sent one. */
    readonly code?: ProtocolErrorCode;
};
/** Class of {@link AgentServerError}, for `instanceof` checks. */
export declare const AgentServerError: new (message: string, status: number, code?: ProtocolErrorCode) => AgentServerError;
/** The server no longer speaks this client's protocol version (HTTP 426): the fix is updating the app. */
export type AgentProtocolError = AgentServerError;
/** Class of {@link AgentProtocolError}, for `instanceof` checks. */
export declare const AgentProtocolError: new (message: string, status: number) => AgentProtocolError;
