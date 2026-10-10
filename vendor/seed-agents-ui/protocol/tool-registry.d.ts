/**
 * The Seed agent tool surface: five always-on verbs plus a directory of callable tools.
 *
 * The model-facing surface is the five verbs — read, write, call, delegate, plan — plus the
 * hidden return_result mechanism for typed child sessions. Everything that used to be its own
 * tool (memory, ipfs, attachments, web reading, the activity feed, hypermedia writes, spawning,
 * todos) is an address form of a verb or a callable tool dispatched through `call`.
 *
 * Callable tools keep the same metadata shape but are NOT exposed as provider tools: `call`
 * validates input against the target's schema, and calling an unexpanded or mis-called tool
 * returns the tool's contract as the result (touch-expand) instead of erroring.
 */
export type JsonSchemaTypeName = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
export type JsonSchema = {
    type?: JsonSchemaTypeName | JsonSchemaTypeName[];
    description?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    additionalProperties?: boolean | JsonSchema;
    enum?: string[];
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    items?: JsonSchema;
    minItems?: number;
    maxItems?: number;
};
export type ToolRuntime = 'assistant' | 'agent-service';
export type ToolRenderKind = 'search' | 'read' | 'resolve' | 'navigate' | 'write' | 'generic' | 'hidden';
export type ToolRenderValueSource = 'input' | 'output';
export type ToolRenderLink = {
    source: ToolRenderValueSource;
    path: string;
    label?: string;
    labelPath?: string;
};
/** Input and output of a single tool call, passed to a tool's reference extractor. */
export type ToolCallIO = {
    input?: unknown;
    output?: unknown;
};
export type ToolRenderDetail = {
    label: string;
    source: ToolRenderValueSource;
    path?: string;
    format?: 'json' | 'markdown';
};
export type ToolRenderCustomView = {
    command: string;
    kind: 'write-command';
};
export type ToolRenderMetadata = {
    kind: ToolRenderKind;
    label: string;
    pendingLabel?: string;
    color: 'sky' | 'emerald' | 'violet' | 'amber' | 'indigo' | 'muted' | 'hidden';
    primaryArg?: string;
    resourceArg?: string;
    summaryArg?: string;
    summaryOutputPath?: string;
    links?: ToolRenderLink[];
    details?: ToolRenderDetail[];
    customViews?: ToolRenderCustomView[];
};
export type SeedToolMetadata = {
    name: string;
    label: string;
    description: string;
    inputSchema: JsonSchema;
    outputSchema?: JsonSchema;
    render: ToolRenderMetadata;
    /** Returns the hm:// resource URLs this tool call references, so referenced content can be synced. */
    getReferencedUrls?: (io: ToolCallIO) => string[];
    runtimes: ToolRuntime[];
    hidden?: boolean;
    userConfigurable?: boolean;
};
/** The handoff fields the runtime knows by name; every other key is an agent-invented section. */
export declare const CONTINUATION_HANDOFF_KEYS: ReadonlySet<string>;
/**
 * Top-level continue_session arguments that models routinely nest inside `handoff`. The runtime
 * hoists them when the top level lacks them; the transition cards read both places the same way.
 */
export declare const CONTINUATION_HOISTED_ARGS: readonly ["title", "description", "sources", "transfer"];
/** "riskRegister" / "risk_register" → "Risk register": an agent-invented handoff key as a section title. */
export declare function continuationSectionTitle(key: string): string;
/** The always-on model-facing surface: the five verbs plus the hidden child-result mechanism. */
export declare const seedVerbRegistry: {
    readonly read: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                address: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                format: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                options: {
                    type: "object";
                    description: string;
                };
            };
            required: string[];
        };
        render: {
            kind: "read";
            label: string;
            pendingLabel: string;
            color: "sky";
            primaryArg: string;
            summaryArg: string;
            resourceArg: string;
            summaryOutputPath: string;
            details: {
                label: string;
                source: "output";
            }[];
        };
        getReferencedUrls: (io: ToolCallIO) => string[];
        runtimes: ("assistant" | "agent-service")[];
        userConfigurable: true;
    };
    readonly write: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                address: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                content: {
                    type: "string";
                    description: string;
                };
                options: {
                    type: "object";
                    description: string;
                };
                dryRun: {
                    type: "boolean";
                    description: string;
                };
            };
            required: string[];
        };
        render: {
            kind: "write";
            label: string;
            pendingLabel: string;
            color: "emerald";
            primaryArg: string;
            summaryArg: string;
            resourceArg: string;
            summaryOutputPath: string;
            details: ({
                label: string;
                source: "input";
                path: string;
                format: "markdown";
            } | {
                label: string;
                source: "input";
                path: string;
                format?: undefined;
            } | {
                label: string;
                source: "output";
                path?: undefined;
                format?: undefined;
            })[];
            customViews: {
                command: string;
                kind: "write-command";
            }[];
        };
        getReferencedUrls: (io: ToolCallIO) => string[];
        runtimes: ("assistant" | "agent-service")[];
        userConfigurable: true;
    };
    readonly call: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                tool: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                input: {
                    type: "object";
                    description: string;
                };
                description: {
                    type: "string";
                    minLength: number;
                    maxLength: number;
                    description: string;
                };
            };
            required: string[];
        };
        render: {
            kind: "generic";
            label: string;
            pendingLabel: string;
            color: "amber";
            primaryArg: string;
            summaryArg: string;
            summaryOutputPath: string;
            details: ({
                label: string;
                source: "input";
                path: string;
            } | {
                label: string;
                source: "output";
                path?: undefined;
            })[];
        };
        runtimes: ("assistant" | "agent-service")[];
        userConfigurable: true;
    };
    readonly delegate: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                title: {
                    type: "string";
                    description: string;
                };
                brief: {
                    type: "string";
                    description: string;
                };
                script: {
                    type: "string";
                    description: string;
                };
                input: {
                    description: string;
                };
                systemPrompt: {
                    type: "string";
                    description: string;
                };
                prompt: {
                    type: "string";
                    description: string;
                };
                includeAgentSystemPrompt: {
                    type: "boolean";
                    description: string;
                };
                model: {
                    type: "string";
                    description: string;
                };
                reasoningLevel: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                tools: {
                    type: "array";
                    items: {
                        type: "string";
                    };
                    description: string;
                };
                output: {
                    type: "object";
                    description: string;
                };
                await: {
                    type: "boolean";
                    description: string;
                };
            };
            required: never[];
        };
        outputSchema: {
            type: "object";
            properties: {
                status: {
                    type: "string";
                    enum: string[];
                };
                sessionId: {
                    type: "string";
                };
                runId: {
                    type: "string";
                };
                output: {
                    description: string;
                };
                error: {
                    type: "object";
                    properties: {
                        code: {
                            type: "string";
                        };
                        message: {
                            type: "string";
                        };
                    };
                };
            };
        };
        render: {
            kind: "write";
            label: string;
            pendingLabel: string;
            color: "violet";
            primaryArg: string;
            summaryArg: string;
            details: ({
                label: string;
                source: "input";
                path: string;
                format: "markdown";
            } | {
                label: string;
                source: "input";
                path: string;
                format?: undefined;
            } | {
                label: string;
                source: "output";
                path?: undefined;
                format?: undefined;
            })[];
        };
        runtimes: "agent-service"[];
        userConfigurable: false;
    };
    readonly plan: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                title: {
                    type: "string";
                    description: string;
                };
                steps: {
                    type: "array";
                    items: {
                        type: "object";
                        additionalProperties: false;
                        properties: {
                            id: {
                                type: "string";
                                description: string;
                            };
                            label: {
                                type: "string";
                                minLength: number;
                                description: string;
                            };
                            status: {
                                type: "string";
                                enum: string[];
                            };
                        };
                        required: string[];
                    };
                };
            };
            required: string[];
        };
        render: {
            kind: "hidden";
            label: string;
            color: "hidden";
            summaryArg: string;
        };
        runtimes: "agent-service"[];
    };
    readonly status: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                title: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                description: {
                    type: "string";
                    description: string;
                };
            };
        };
        render: {
            kind: "hidden";
            label: string;
            color: "hidden";
            summaryArg: string;
        };
        runtimes: "agent-service"[];
    };
    readonly continue_session: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                reason: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                title: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                description: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                handoff: {
                    type: "object";
                    description: string;
                    properties: {
                        purpose: {
                            type: "string";
                            minLength: number;
                            description: string;
                        };
                        currentRequest: {
                            type: "string";
                            minLength: number;
                            description: string;
                        };
                        establishedFacts: {
                            type: "array";
                            items: {
                                type: "string";
                            };
                            description: string;
                        };
                        decisions: {
                            type: "array";
                            items: {
                                type: "string";
                            };
                            description: string;
                        };
                        openQuestions: {
                            type: "array";
                            items: {
                                type: "string";
                            };
                            description: string;
                        };
                        nextActions: {
                            type: "array";
                            items: {
                                type: "string";
                            };
                            description: string;
                        };
                        cautions: {
                            type: "array";
                            items: {
                                type: "string";
                            };
                            description: string;
                        };
                    };
                    required: string[];
                };
                sources: {
                    type: "array";
                    description: string;
                    items: {
                        type: "object";
                        additionalProperties: false;
                        properties: {
                            kind: {
                                type: "string";
                                enum: string[];
                            };
                            url: {
                                type: "string";
                            };
                            version: {
                                type: "string";
                            };
                            blockId: {
                                type: "string";
                            };
                            path: {
                                type: "string";
                            };
                            sessionId: {
                                type: "string";
                                description: string;
                            };
                            fromSeq: {
                                type: "number";
                            };
                            toSeq: {
                                type: "number";
                            };
                            seq: {
                                type: "number";
                            };
                            relevance: {
                                type: "string";
                                minLength: number;
                            };
                        };
                        required: string[];
                    };
                };
                transfer: {
                    type: "object";
                    additionalProperties: false;
                    properties: {
                        plan: {
                            type: "string";
                            enum: string[];
                            description: string;
                        };
                    };
                };
            };
            required: string[];
        };
        outputSchema: {
            type: "object";
            properties: {
                continuationId: {
                    type: "string";
                };
                successorSessionId: {
                    type: "string";
                };
                title: {
                    type: "string";
                };
            };
        };
        render: {
            kind: "generic";
            label: string;
            pendingLabel: string;
            color: "violet";
            primaryArg: string;
            summaryArg: string;
            details: ({
                label: string;
                source: "input";
                path: string;
            } | {
                label: string;
                source: "output";
                path?: undefined;
            })[];
        };
        runtimes: "agent-service"[];
    };
    readonly return_result: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
        };
        render: {
            kind: "generic";
            label: string;
            color: "emerald";
            details: {
                label: string;
                source: "input";
            }[];
        };
        runtimes: "agent-service"[];
    };
};
export type SeedVerbName = keyof typeof seedVerbRegistry;
/** Tools reachable through the `call` verb (and scripts' ctx.call), keyed by name. */
export declare const callableToolRegistry: {
    readonly search: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                query: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                accountUid: {
                    type: "string";
                    description: string;
                };
                includeBody: {
                    type: "boolean";
                    description: string;
                };
                contextSize: {
                    type: "integer";
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                searchType: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                pageSize: {
                    type: "integer";
                    minimum: number;
                    description: string;
                };
            };
            required: string[];
        };
        render: {
            kind: "search";
            label: string;
            color: "sky";
            primaryArg: string;
            summaryOutputPath: string;
            links: {
                source: "output";
                path: string;
                labelPath: string;
            }[];
            details: ({
                label: string;
                source: "output";
                path: string;
                format: "markdown";
            } | {
                label: string;
                source: "input";
                path?: undefined;
                format?: undefined;
            })[];
        };
        runtimes: ("assistant" | "agent-service")[];
        userConfigurable: true;
    };
    readonly query: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                q: {
                    type: "string";
                    description: string;
                };
                filter: {
                    type: "object";
                    description: string;
                };
                sort: {
                    type: "array";
                    items: {
                        type: "object";
                        additionalProperties: false;
                        properties: {
                            key: {
                                type: "string";
                                description: string;
                            };
                            attribute: {
                                type: "string";
                                enum: string[];
                                description: string;
                            };
                            descending: {
                                type: "boolean";
                            };
                        };
                    };
                };
                pageSize: {
                    type: "integer";
                    minimum: number;
                    maximum: number;
                };
                pageToken: {
                    type: "string";
                    description: string;
                };
            };
        };
        render: {
            kind: "search";
            label: string;
            color: "sky";
            primaryArg: string;
            summaryOutputPath: string;
            links: {
                source: "output";
                path: string;
                labelPath: string;
            }[];
            details: ({
                label: string;
                source: "output";
                path: string;
                format: "markdown";
            } | {
                label: string;
                source: "input";
                path?: undefined;
                format?: undefined;
            })[];
        };
        runtimes: ("assistant" | "agent-service")[];
        userConfigurable: true;
    };
    readonly attributes: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                key: {
                    type: "string";
                    description: string;
                };
                kind: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                parent: {
                    type: "string";
                    description: string;
                };
                recursive: {
                    type: "boolean";
                    description: string;
                };
                account: {
                    type: "string";
                    description: string;
                };
                prefix: {
                    type: "string";
                    description: string;
                };
                pageSize: {
                    type: "integer";
                    minimum: number;
                    maximum: number;
                };
                pageToken: {
                    type: "string";
                };
            };
        };
        render: {
            kind: "search";
            label: string;
            color: "sky";
            primaryArg: string;
            summaryOutputPath: string;
            details: ({
                label: string;
                source: "output";
                path: string;
                format: "markdown";
            } | {
                label: string;
                source: "input";
                path?: undefined;
                format?: undefined;
            })[];
        };
        runtimes: ("assistant" | "agent-service")[];
        userConfigurable: true;
    };
    readonly web_search: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                query: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                count: {
                    type: "integer";
                    minimum: number;
                    description: string;
                };
                category: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                timeRange: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                language: {
                    type: "string";
                    description: string;
                };
            };
            required: string[];
        };
        outputSchema: {
            type: "object";
            properties: {
                summary: {
                    type: "string";
                    description: string;
                };
                results: {
                    type: "array";
                    items: {
                        type: "object";
                        properties: {
                            title: {
                                type: "string";
                            };
                            url: {
                                type: "string";
                            };
                            snippet: {
                                type: "string";
                            };
                            engine: {
                                type: "string";
                                description: string;
                            };
                        };
                    };
                };
                partial: {
                    type: "boolean";
                    description: string;
                };
                markdown: {
                    type: "string";
                    description: string;
                };
            };
        };
        render: {
            kind: "search";
            label: string;
            color: "sky";
            primaryArg: string;
            summaryOutputPath: string;
            links: {
                source: "output";
                path: string;
                labelPath: string;
            }[];
            details: ({
                label: string;
                source: "output";
                path: string;
                format: "markdown";
            } | {
                label: string;
                source: "input";
                path?: undefined;
                format?: undefined;
            })[];
        };
        runtimes: ("assistant" | "agent-service")[];
        userConfigurable: true;
    };
    readonly navigate: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                url: {
                    type: "string";
                    description: string;
                };
                newWindow: {
                    type: "boolean";
                    description: string;
                };
            };
            required: string[];
        };
        render: {
            kind: "navigate";
            label: string;
            color: "muted";
            primaryArg: string;
            resourceArg: string;
        };
        getReferencedUrls: (io: ToolCallIO) => string[];
        runtimes: "assistant"[];
        userConfigurable: true;
    };
    readonly execute: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                description: {
                    type: "string";
                    minLength: number;
                    maxLength: number;
                    description: string;
                };
                runtime: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                code: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                timeout_secs: {
                    type: "integer";
                    minimum: number;
                    description: string;
                };
            };
            required: string[];
        };
        outputSchema: {
            type: "object";
            properties: {
                summary: {
                    type: "string";
                };
                exitCode: {
                    type: "integer";
                };
                success: {
                    type: "boolean";
                };
                stdout: {
                    type: "string";
                };
                stderr: {
                    type: "string";
                };
                truncated: {
                    type: "boolean";
                    description: string;
                };
                durationMs: {
                    type: "integer";
                };
                changedFiles: {
                    type: "array";
                    description: string;
                    items: {
                        type: "object";
                        properties: {
                            path: {
                                type: "string";
                            };
                            change: {
                                type: "string";
                                enum: string[];
                            };
                        };
                    };
                };
            };
        };
        render: {
            kind: "write";
            label: string;
            color: "amber";
            primaryArg: string;
            summaryArg: string;
            summaryOutputPath: string;
            details: ({
                label: string;
                source: "input";
                path: string;
            } | {
                label: string;
                source: "output";
                path: string;
            })[];
        };
        runtimes: "agent-service"[];
        userConfigurable: true;
    };
};
export type CallableToolName = keyof typeof callableToolRegistry;
/**
 * Every known tool, verbs and callables together, keyed by name. This is the lookup surface for
 * renderers and validation; the provider-facing toolset is `seedVerbRegistry` alone.
 */
export declare const seedToolRegistry: {
    readonly search: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                query: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                accountUid: {
                    type: "string";
                    description: string;
                };
                includeBody: {
                    type: "boolean";
                    description: string;
                };
                contextSize: {
                    type: "integer";
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                searchType: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                pageSize: {
                    type: "integer";
                    minimum: number;
                    description: string;
                };
            };
            required: string[];
        };
        render: {
            kind: "search";
            label: string;
            color: "sky";
            primaryArg: string;
            summaryOutputPath: string;
            links: {
                source: "output";
                path: string;
                labelPath: string;
            }[];
            details: ({
                label: string;
                source: "output";
                path: string;
                format: "markdown";
            } | {
                label: string;
                source: "input";
                path?: undefined;
                format?: undefined;
            })[];
        };
        runtimes: ("assistant" | "agent-service")[];
        userConfigurable: true;
    };
    readonly query: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                q: {
                    type: "string";
                    description: string;
                };
                filter: {
                    type: "object";
                    description: string;
                };
                sort: {
                    type: "array";
                    items: {
                        type: "object";
                        additionalProperties: false;
                        properties: {
                            key: {
                                type: "string";
                                description: string;
                            };
                            attribute: {
                                type: "string";
                                enum: string[];
                                description: string;
                            };
                            descending: {
                                type: "boolean";
                            };
                        };
                    };
                };
                pageSize: {
                    type: "integer";
                    minimum: number;
                    maximum: number;
                };
                pageToken: {
                    type: "string";
                    description: string;
                };
            };
        };
        render: {
            kind: "search";
            label: string;
            color: "sky";
            primaryArg: string;
            summaryOutputPath: string;
            links: {
                source: "output";
                path: string;
                labelPath: string;
            }[];
            details: ({
                label: string;
                source: "output";
                path: string;
                format: "markdown";
            } | {
                label: string;
                source: "input";
                path?: undefined;
                format?: undefined;
            })[];
        };
        runtimes: ("assistant" | "agent-service")[];
        userConfigurable: true;
    };
    readonly attributes: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                key: {
                    type: "string";
                    description: string;
                };
                kind: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                parent: {
                    type: "string";
                    description: string;
                };
                recursive: {
                    type: "boolean";
                    description: string;
                };
                account: {
                    type: "string";
                    description: string;
                };
                prefix: {
                    type: "string";
                    description: string;
                };
                pageSize: {
                    type: "integer";
                    minimum: number;
                    maximum: number;
                };
                pageToken: {
                    type: "string";
                };
            };
        };
        render: {
            kind: "search";
            label: string;
            color: "sky";
            primaryArg: string;
            summaryOutputPath: string;
            details: ({
                label: string;
                source: "output";
                path: string;
                format: "markdown";
            } | {
                label: string;
                source: "input";
                path?: undefined;
                format?: undefined;
            })[];
        };
        runtimes: ("assistant" | "agent-service")[];
        userConfigurable: true;
    };
    readonly web_search: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                query: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                count: {
                    type: "integer";
                    minimum: number;
                    description: string;
                };
                category: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                timeRange: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                language: {
                    type: "string";
                    description: string;
                };
            };
            required: string[];
        };
        outputSchema: {
            type: "object";
            properties: {
                summary: {
                    type: "string";
                    description: string;
                };
                results: {
                    type: "array";
                    items: {
                        type: "object";
                        properties: {
                            title: {
                                type: "string";
                            };
                            url: {
                                type: "string";
                            };
                            snippet: {
                                type: "string";
                            };
                            engine: {
                                type: "string";
                                description: string;
                            };
                        };
                    };
                };
                partial: {
                    type: "boolean";
                    description: string;
                };
                markdown: {
                    type: "string";
                    description: string;
                };
            };
        };
        render: {
            kind: "search";
            label: string;
            color: "sky";
            primaryArg: string;
            summaryOutputPath: string;
            links: {
                source: "output";
                path: string;
                labelPath: string;
            }[];
            details: ({
                label: string;
                source: "output";
                path: string;
                format: "markdown";
            } | {
                label: string;
                source: "input";
                path?: undefined;
                format?: undefined;
            })[];
        };
        runtimes: ("assistant" | "agent-service")[];
        userConfigurable: true;
    };
    readonly navigate: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                url: {
                    type: "string";
                    description: string;
                };
                newWindow: {
                    type: "boolean";
                    description: string;
                };
            };
            required: string[];
        };
        render: {
            kind: "navigate";
            label: string;
            color: "muted";
            primaryArg: string;
            resourceArg: string;
        };
        getReferencedUrls: (io: ToolCallIO) => string[];
        runtimes: "assistant"[];
        userConfigurable: true;
    };
    readonly execute: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                description: {
                    type: "string";
                    minLength: number;
                    maxLength: number;
                    description: string;
                };
                runtime: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                code: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                timeout_secs: {
                    type: "integer";
                    minimum: number;
                    description: string;
                };
            };
            required: string[];
        };
        outputSchema: {
            type: "object";
            properties: {
                summary: {
                    type: "string";
                };
                exitCode: {
                    type: "integer";
                };
                success: {
                    type: "boolean";
                };
                stdout: {
                    type: "string";
                };
                stderr: {
                    type: "string";
                };
                truncated: {
                    type: "boolean";
                    description: string;
                };
                durationMs: {
                    type: "integer";
                };
                changedFiles: {
                    type: "array";
                    description: string;
                    items: {
                        type: "object";
                        properties: {
                            path: {
                                type: "string";
                            };
                            change: {
                                type: "string";
                                enum: string[];
                            };
                        };
                    };
                };
            };
        };
        render: {
            kind: "write";
            label: string;
            color: "amber";
            primaryArg: string;
            summaryArg: string;
            summaryOutputPath: string;
            details: ({
                label: string;
                source: "input";
                path: string;
            } | {
                label: string;
                source: "output";
                path: string;
            })[];
        };
        runtimes: "agent-service"[];
        userConfigurable: true;
    };
    readonly read: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                address: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                format: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                options: {
                    type: "object";
                    description: string;
                };
            };
            required: string[];
        };
        render: {
            kind: "read";
            label: string;
            pendingLabel: string;
            color: "sky";
            primaryArg: string;
            summaryArg: string;
            resourceArg: string;
            summaryOutputPath: string;
            details: {
                label: string;
                source: "output";
            }[];
        };
        getReferencedUrls: (io: ToolCallIO) => string[];
        runtimes: ("assistant" | "agent-service")[];
        userConfigurable: true;
    };
    readonly write: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                address: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                content: {
                    type: "string";
                    description: string;
                };
                options: {
                    type: "object";
                    description: string;
                };
                dryRun: {
                    type: "boolean";
                    description: string;
                };
            };
            required: string[];
        };
        render: {
            kind: "write";
            label: string;
            pendingLabel: string;
            color: "emerald";
            primaryArg: string;
            summaryArg: string;
            resourceArg: string;
            summaryOutputPath: string;
            details: ({
                label: string;
                source: "input";
                path: string;
                format: "markdown";
            } | {
                label: string;
                source: "input";
                path: string;
                format?: undefined;
            } | {
                label: string;
                source: "output";
                path?: undefined;
                format?: undefined;
            })[];
            customViews: {
                command: string;
                kind: "write-command";
            }[];
        };
        getReferencedUrls: (io: ToolCallIO) => string[];
        runtimes: ("assistant" | "agent-service")[];
        userConfigurable: true;
    };
    readonly call: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                tool: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                input: {
                    type: "object";
                    description: string;
                };
                description: {
                    type: "string";
                    minLength: number;
                    maxLength: number;
                    description: string;
                };
            };
            required: string[];
        };
        render: {
            kind: "generic";
            label: string;
            pendingLabel: string;
            color: "amber";
            primaryArg: string;
            summaryArg: string;
            summaryOutputPath: string;
            details: ({
                label: string;
                source: "input";
                path: string;
            } | {
                label: string;
                source: "output";
                path?: undefined;
            })[];
        };
        runtimes: ("assistant" | "agent-service")[];
        userConfigurable: true;
    };
    readonly delegate: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                title: {
                    type: "string";
                    description: string;
                };
                brief: {
                    type: "string";
                    description: string;
                };
                script: {
                    type: "string";
                    description: string;
                };
                input: {
                    description: string;
                };
                systemPrompt: {
                    type: "string";
                    description: string;
                };
                prompt: {
                    type: "string";
                    description: string;
                };
                includeAgentSystemPrompt: {
                    type: "boolean";
                    description: string;
                };
                model: {
                    type: "string";
                    description: string;
                };
                reasoningLevel: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                tools: {
                    type: "array";
                    items: {
                        type: "string";
                    };
                    description: string;
                };
                output: {
                    type: "object";
                    description: string;
                };
                await: {
                    type: "boolean";
                    description: string;
                };
            };
            required: never[];
        };
        outputSchema: {
            type: "object";
            properties: {
                status: {
                    type: "string";
                    enum: string[];
                };
                sessionId: {
                    type: "string";
                };
                runId: {
                    type: "string";
                };
                output: {
                    description: string;
                };
                error: {
                    type: "object";
                    properties: {
                        code: {
                            type: "string";
                        };
                        message: {
                            type: "string";
                        };
                    };
                };
            };
        };
        render: {
            kind: "write";
            label: string;
            pendingLabel: string;
            color: "violet";
            primaryArg: string;
            summaryArg: string;
            details: ({
                label: string;
                source: "input";
                path: string;
                format: "markdown";
            } | {
                label: string;
                source: "input";
                path: string;
                format?: undefined;
            } | {
                label: string;
                source: "output";
                path?: undefined;
                format?: undefined;
            })[];
        };
        runtimes: "agent-service"[];
        userConfigurable: false;
    };
    readonly plan: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                title: {
                    type: "string";
                    description: string;
                };
                steps: {
                    type: "array";
                    items: {
                        type: "object";
                        additionalProperties: false;
                        properties: {
                            id: {
                                type: "string";
                                description: string;
                            };
                            label: {
                                type: "string";
                                minLength: number;
                                description: string;
                            };
                            status: {
                                type: "string";
                                enum: string[];
                            };
                        };
                        required: string[];
                    };
                };
            };
            required: string[];
        };
        render: {
            kind: "hidden";
            label: string;
            color: "hidden";
            summaryArg: string;
        };
        runtimes: "agent-service"[];
    };
    readonly status: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                title: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                description: {
                    type: "string";
                    description: string;
                };
            };
        };
        render: {
            kind: "hidden";
            label: string;
            color: "hidden";
            summaryArg: string;
        };
        runtimes: "agent-service"[];
    };
    readonly continue_session: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
            additionalProperties: false;
            properties: {
                reason: {
                    type: "string";
                    enum: string[];
                    description: string;
                };
                title: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                description: {
                    type: "string";
                    minLength: number;
                    description: string;
                };
                handoff: {
                    type: "object";
                    description: string;
                    properties: {
                        purpose: {
                            type: "string";
                            minLength: number;
                            description: string;
                        };
                        currentRequest: {
                            type: "string";
                            minLength: number;
                            description: string;
                        };
                        establishedFacts: {
                            type: "array";
                            items: {
                                type: "string";
                            };
                            description: string;
                        };
                        decisions: {
                            type: "array";
                            items: {
                                type: "string";
                            };
                            description: string;
                        };
                        openQuestions: {
                            type: "array";
                            items: {
                                type: "string";
                            };
                            description: string;
                        };
                        nextActions: {
                            type: "array";
                            items: {
                                type: "string";
                            };
                            description: string;
                        };
                        cautions: {
                            type: "array";
                            items: {
                                type: "string";
                            };
                            description: string;
                        };
                    };
                    required: string[];
                };
                sources: {
                    type: "array";
                    description: string;
                    items: {
                        type: "object";
                        additionalProperties: false;
                        properties: {
                            kind: {
                                type: "string";
                                enum: string[];
                            };
                            url: {
                                type: "string";
                            };
                            version: {
                                type: "string";
                            };
                            blockId: {
                                type: "string";
                            };
                            path: {
                                type: "string";
                            };
                            sessionId: {
                                type: "string";
                                description: string;
                            };
                            fromSeq: {
                                type: "number";
                            };
                            toSeq: {
                                type: "number";
                            };
                            seq: {
                                type: "number";
                            };
                            relevance: {
                                type: "string";
                                minLength: number;
                            };
                        };
                        required: string[];
                    };
                };
                transfer: {
                    type: "object";
                    additionalProperties: false;
                    properties: {
                        plan: {
                            type: "string";
                            enum: string[];
                            description: string;
                        };
                    };
                };
            };
            required: string[];
        };
        outputSchema: {
            type: "object";
            properties: {
                continuationId: {
                    type: "string";
                };
                successorSessionId: {
                    type: "string";
                };
                title: {
                    type: "string";
                };
            };
        };
        render: {
            kind: "generic";
            label: string;
            pendingLabel: string;
            color: "violet";
            primaryArg: string;
            summaryArg: string;
            details: ({
                label: string;
                source: "input";
                path: string;
            } | {
                label: string;
                source: "output";
                path?: undefined;
            })[];
        };
        runtimes: "agent-service"[];
    };
    readonly return_result: {
        name: string;
        label: string;
        description: string;
        inputSchema: {
            type: "object";
        };
        render: {
            kind: "generic";
            label: string;
            color: "emerald";
            details: {
                label: string;
                source: "input";
            }[];
        };
        runtimes: "agent-service"[];
    };
};
export type SeedToolName = keyof typeof seedToolRegistry;
/** Resolves a possibly-legacy tool name to its current registry name. */
export declare function normalizeSeedToolName(name: string): string;
export declare function getSeedTool(name: string): SeedToolMetadata | undefined;
/** hm:// URLs a tool call references, from the registry's structured reference extractors. */
export declare function getToolReferencedUrls(toolName: string, io: ToolCallIO): string[];
/** One-line summary for a tool, used by the ~/tools listing and the call description. */
export declare function toolSummaryLine(tool: SeedToolMetadata): string;
/** Renders a tool's full contract as markdown, returned by touch-expand and ~/tools reads. */
export declare function toolContractMarkdown(tool: SeedToolMetadata): string;
