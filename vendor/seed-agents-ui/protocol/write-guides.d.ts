/** A detailed write guide loaded only when an agent asks for that Seed resource group. */
export type WriteGuide = {
    summary: string;
    markdown: string;
};
/** Detailed Seed write guides, loaded progressively through reads of ~/tools/write/<resource>. */
export declare const writeGuideRegistry: {
    memory: {
        summary: string;
        markdown: string;
    };
    tools: {
        summary: string;
        markdown: string;
    };
    triggers: {
        summary: string;
        markdown: string;
    };
    ipfs: {
        summary: string;
        markdown: string;
    };
    documents: {
        summary: string;
        markdown: string;
    };
    comments: {
        summary: string;
        markdown: string;
    };
    capabilities: {
        summary: string;
        markdown: string;
    };
    contacts: {
        summary: string;
        markdown: string;
    };
    profiles: {
        summary: string;
        markdown: string;
    };
    drafts: {
        summary: string;
        markdown: string;
    };
};
