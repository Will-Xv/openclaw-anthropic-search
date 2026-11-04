import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
	createWebSearchProviderContractFields,
	resolveProviderWebSearchPluginConfig
} from "openclaw/plugin-sdk/provider-web-search-contract";
import { mergeScopedSearchConfig } from "openclaw/plugin-sdk/provider-web-search";

const PLUGIN_ID = "anthropic-search";
const PROVIDER_ID = "claude";
const CREDENTIAL_PATH = `plugins.entries.${PLUGIN_ID}.config.webSearch.apiKey`;
const DOCS_URL = "https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool";

const loadRuntime = createLazyRuntimeModule(() => import("./runtime.js"));

const CLAUDE_SEARCH_PARAMETERS = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description: "What to find out. A full question works best; Claude decides the actual search queries."
		},
		count: {
			type: "integer",
			description: "How many distinct sources to draw on (1-10).",
			minimum: 1,
			maximum: 10
		},
		country: {
			type: "string",
			description: "Two-letter country code (ISO 3166-1 alpha-2) to localize results, e.g. CA."
		},
		freshness: {
			type: "string",
			description: "Recency preference: day, week, month, or year. A hint to Claude, not a hard filter."
		},
		date_after: {
			type: "string",
			description: "Only use sources published on or after this date (YYYY-MM-DD). A hint to Claude, not a hard filter."
		},
		date_before: {
			type: "string",
			description: "Only use sources published on or before this date (YYYY-MM-DD). A hint to Claude, not a hard filter."
		},
		language: {
			type: "string",
			description: "Preferred source language (ISO 639-1), e.g. en. A hint to Claude, not a hard filter."
		},
		domain_filter: {
			type: "array",
			items: { type: "string" },
			description: "Domains to search only (e.g. utoronto.ca), or to exclude with a - prefix (e.g. -reddit.com). Do not mix both. Max 20."
		}
	},
	required: ["query"]
};

// Search with the Claude model the agent already chats with; webSearch.model overrides it.
function resolveAgentClaudeModel(config) {
	const model = config?.agents?.defaults?.model;
	const primary = typeof model === "string" ? model : model?.primary;
	return typeof primary === "string" && primary.startsWith("anthropic/") ? primary.slice("anthropic/".length) : void 0;
}

function createClaudeWebSearchProvider() {
	return {
		id: PROVIDER_ID,
		label: "Claude (Anthropic web search)",
		hint: "Requires an Anthropic API key · Claude runs the searches and returns a cited answer",
		onboardingScopes: ["text-inference"],
		credentialLabel: "Anthropic API key",
		envVars: ["ANTHROPIC_API_KEY"],
		placeholder: "sk-ant-...",
		signupUrl: "https://platform.claude.com/settings/keys",
		docsUrl: DOCS_URL,
		credentialPath: CREDENTIAL_PATH,
		...createWebSearchProviderContractFields({
			credentialPath: CREDENTIAL_PATH,
			searchCredential: { type: "scoped", scopeId: PROVIDER_ID },
			configuredCredential: { pluginId: PLUGIN_ID },
			selectionPluginId: PLUGIN_ID
		}),
		createTool: (ctx) => {
			const searchConfig = mergeScopedSearchConfig(ctx.searchConfig, PROVIDER_ID, resolveProviderWebSearchPluginConfig(ctx.config, PLUGIN_ID));
			const agentModel = resolveAgentClaudeModel(ctx.config);
			return {
				description: "Search the web with Claude's web_search tool. Claude runs the searches and returns a synthesized answer with numbered citations to the sources it used.",
				parameters: CLAUDE_SEARCH_PARAMETERS,
				execute: async (args, context) => {
					context?.signal?.throwIfAborted();
					const { executeClaudeSearch } = await loadRuntime();
					return await executeClaudeSearch(args, searchConfig, context, agentModel);
				}
			};
		}
	};
}

export { createClaudeWebSearchProvider, CREDENTIAL_PATH, DOCS_URL, PROVIDER_ID };
