import Anthropic from "@anthropic-ai/sdk";
import {
	buildSearchCacheKey,
	readCachedSearchPayload,
	readConfiguredSecretString,
	readPositiveIntegerParam,
	readProviderEnvValue,
	readStringArrayParam,
	readStringParam,
	resolveSearchCacheTtlMs,
	resolveTimeoutSeconds,
	wrapWebContent,
	writeCachedSearchPayload
} from "openclaw/plugin-sdk/provider-web-search";
import { CREDENTIAL_PATH, DOCS_URL, PROVIDER_ID } from "./provider.js";

const DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_MAX_USES = 5;
// A search turn runs several searches plus Claude's own writing, so the 30s core default is too short.
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TOKENS = 16000;
// Server-side loop pauses (stop_reason "pause_turn") we resume before giving up.
const MAX_CONTINUATIONS = 3;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const FRESHNESS_WINDOWS = {
	day: "the last 24 hours",
	week: "the last week",
	month: "the last month",
	year: "the last year"
};
// Shared web_search parameters that only Brave or Perplexity implement.
const UNSUPPORTED_PARAMS = ["search_lang", "ui_lang", "max_tokens", "max_tokens_per_page"];
const MAX_DOMAIN_FILTER = 20;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Blocks that make up Claude's reply; everything else is a tool call or tool result.
const ANSWER_BLOCK_TYPES = new Set(["text", "thinking", "redacted_thinking"]);

const SYSTEM_PROMPT = "You are the web search backend for another AI assistant, which called you because it wants current information from the web. Always run at least one web search before answering, even if you think you already know the answer, then write a concise, factual answer the assistant can rely on: key facts, figures, dates, and names. Support every claim with a source you found, citing the specific page that holds the detail rather than a home page: the assistant receives only your answer and may open the cited pages to read more. If a detail the request needs is not in what you found, say so and name the page most likely to have it. If sources disagree or nothing relevant turns up, say so plainly instead of guessing. Do not address the end user and do not offer follow-ups.";

function resolveClaudeConfig(searchConfig) {
	const claude = searchConfig?.[PROVIDER_ID];
	return claude && typeof claude === "object" ? claude : {};
}

// An explicit plugin key wins. Otherwise reuse the key the Anthropic model provider already has
// (an API-key auth profile or ANTHROPIC_API_KEY); subscription and OAuth tokens are not used here.
async function resolveApiKey(claude, providerAuth) {
	const configured = readConfiguredSecretString(claude.apiKey, CREDENTIAL_PATH);
	if (configured) return configured;
	const resolveProviderKey = providerAuth?.modelAuth?.resolveApiKeyForProvider;
	if (resolveProviderKey) {
		const resolved = await resolveProviderKey({ provider: "anthropic", cfg: providerAuth.config }).catch(() => void 0);
		const apiKey = typeof resolved?.apiKey === "string" ? resolved.apiKey.trim() : "";
		if (apiKey && resolved.mode === "api-key") return apiKey;
	}
	return readProviderEnvValue(["ANTHROPIC_API_KEY"]);
}

function resolveMaxUses(claude) {
	const value = claude.maxUses;
	return Number.isInteger(value) && value >= 1 && value <= 20 ? value : DEFAULT_MAX_USES;
}

// Recency and language have no server-side filter, so they reach Claude as instructions.
function buildPrompt({ query, count, freshness, dateAfter, dateBefore, language }) {
	const lines = [`Today's date: ${new Date().toISOString().slice(0, 10)}.`, `Request: ${query}`];
	if (count) lines.push(`Draw on up to ${count} distinct sources.`);
	if (freshness) lines.push(`Prefer sources published within ${FRESHNESS_WINDOWS[freshness]}. If none are that recent, say so and use the most relevant sources available.`);
	if (dateAfter || dateBefore) {
		const range = [dateAfter && `on or after ${dateAfter}`, dateBefore && `on or before ${dateBefore}`].filter(Boolean).join(" and ");
		lines.push(`Only use sources published ${range}. If you cannot tell a source's date or none qualify, say so.`);
	}
	if (language) lines.push(`Prefer sources written in the language with ISO 639-1 code "${language}".`);
	return lines.join("\n");
}

// Perplexity-style list: plain entries allow a domain, "-" entries block it. Anthropic takes one kind per request.
function resolveDomainFilter(args) {
	const entries = readStringArrayParam(args, "domain_filter") ?? [];
	if (entries.length > MAX_DOMAIN_FILTER) return { error: `domain_filter accepts at most ${MAX_DOMAIN_FILTER} domains.` };
	const allowed = [];
	const blocked = [];
	for (const entry of entries) {
		const domain = entry.replace(/^-/, "").replace(/^https?:\/\//i, "").toLowerCase();
		if (domain) (entry.startsWith("-") ? blocked : allowed).push(domain);
	}
	if (allowed.length > 0 && blocked.length > 0) return { error: "domain_filter cannot mix allowed domains and blocked (-prefixed) domains with the claude provider." };
	if (allowed.length > 0) return { allowed_domains: allowed };
	if (blocked.length > 0) return { blocked_domains: blocked };
	return {};
}

// The final answer is the text after the last tool block; earlier text is Claude narrating its searches.
// Each cited fragment gets [n] markers that index into the returned citations list.
function collectAnswer(content) {
	let start = 0;
	content.forEach((block, index) => {
		if (!ANSWER_BLOCK_TYPES.has(block.type)) start = index + 1;
	});
	const citations = [];
	const indexByUrl = new Map();
	let text = "";
	for (const block of content.slice(start)) {
		if (block.type !== "text") continue;
		text += block.text;
		const markers = [];
		for (const citation of block.citations ?? []) {
			if (citation.type !== "web_search_result_location" || !citation.url) continue;
			if (!indexByUrl.has(citation.url)) {
				citations.push({ url: citation.url, title: citation.title ?? void 0 });
				indexByUrl.set(citation.url, citations.length);
			}
			const marker = `[${indexByUrl.get(citation.url)}]`;
			if (!markers.includes(marker)) markers.push(marker);
		}
		if (markers.length > 0) text += ` ${markers.join("")}`;
	}
	return { text: text.trim(), citations };
}

function collectSearchErrors(content) {
	const codes = [];
	for (const block of content) {
		if (block.type === "web_search_tool_result" && block.content && !Array.isArray(block.content)) codes.push(block.content.error_code);
	}
	return codes;
}

function describeApiError(error) {
	if (error instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key (401). Check the Anthropic auth profile, ANTHROPIC_API_KEY, or plugins.entries.anthropic-search.config.webSearch.apiKey.";
	if (error instanceof Anthropic.PermissionDeniedError) return "Anthropic denied the request (403). Web search may be disabled for this organization in the Claude Console.";
	if (error instanceof Anthropic.RateLimitError) return "Anthropic rate limit hit (429). Try again shortly.";
	if (error instanceof Anthropic.BadRequestError) return `Anthropic rejected the search request (400): ${error.message}`;
	return `Anthropic API error (${error.status ?? "no status"}): ${error.message}`;
}

async function runClaudeSearch(params) {
	const client = new Anthropic({ apiKey: params.apiKey, timeout: params.timeoutSeconds * 1000 });
	// Direct calls: with dynamic filtering (the default caller) the answer came back without citations
	// and simple queries used more input tokens in our tests (see README).
	const tool = { type: "web_search_20260318", name: "web_search", max_uses: params.maxUses, allowed_callers: ["direct"], ...params.domainFilter };
	if (params.country) tool.user_location = { type: "approximate", country: params.country };
	const messages = [{ role: "user", content: params.prompt }];
	const content = [];
	const usage = { searches: 0, inputTokens: 0, outputTokens: 0 };
	let stopReason;
	for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
		const message = await client.messages.stream({
			model: params.model,
			max_tokens: MAX_TOKENS,
			system: SYSTEM_PROMPT,
			messages,
			tools: [tool],
			...(params.effort ? { output_config: { effort: params.effort } } : {})
		}, { signal: params.signal }).finalMessage();
		content.push(...message.content);
		usage.searches += message.usage.server_tool_use?.web_search_requests ?? 0;
		usage.inputTokens += message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0);
		usage.outputTokens += message.usage.output_tokens;
		stopReason = message.stop_reason;
		if (stopReason !== "pause_turn") break;
		messages.push({ role: "assistant", content: message.content });
	}
	return { content, usage, stopReason };
}

async function executeClaudeSearch(args, searchConfig, context, agentModel, providerAuth) {
	context?.signal?.throwIfAborted();
	const claude = resolveClaudeConfig(searchConfig);
	const apiKey = await resolveApiKey(claude, providerAuth);
	context?.signal?.throwIfAborted();
	if (!apiKey) return {
		error: "missing_anthropic_api_key",
		message: `web_search (${PROVIDER_ID}) needs an Anthropic API key. Set up Anthropic with an API key (an auth profile or ANTHROPIC_API_KEY in the Gateway environment) or configure ${CREDENTIAL_PATH}.`,
		docs: DOCS_URL
	};
	const unsupported = UNSUPPORTED_PARAMS.find((name) => args?.[name] !== void 0);
	if (unsupported) return {
		error: `unsupported_${unsupported}`,
		message: `${unsupported} is not supported by the ${PROVIDER_ID} provider.`,
		docs: DOCS_URL
	};
	const query = readStringParam(args, "query", { required: true });
	const count = readPositiveIntegerParam(args, "count", { max: 10, message: "count must be an integer from 1 to 10." });
	const country = readStringParam(args, "country")?.toUpperCase();
	if (country && !/^[A-Z]{2}$/.test(country)) return {
		error: "invalid_country",
		message: "country must be a two-letter ISO 3166-1 alpha-2 code, e.g. CA.",
		docs: DOCS_URL
	};
	const freshness = readStringParam(args, "freshness")?.toLowerCase();
	if (freshness && !(freshness in FRESHNESS_WINDOWS)) return {
		error: "invalid_freshness",
		message: "freshness must be day, week, month, or year.",
		docs: DOCS_URL
	};
	const dateAfter = readStringParam(args, "date_after");
	const dateBefore = readStringParam(args, "date_before");
	if ([dateAfter, dateBefore].some((date) => date && !ISO_DATE.test(date))) return {
		error: "invalid_date",
		message: "date_after and date_before must be YYYY-MM-DD.",
		docs: DOCS_URL
	};
	const language = readStringParam(args, "language")?.toLowerCase();
	if (language && !/^[a-z]{2}$/.test(language)) return {
		error: "invalid_language",
		message: "language must be a two-letter ISO 639-1 code, e.g. en.",
		docs: DOCS_URL
	};
	const domainFilter = resolveDomainFilter(args);
	if (domainFilter.error) return {
		error: "invalid_domain_filter",
		message: domainFilter.error,
		docs: DOCS_URL
	};
	const model = typeof claude.model === "string" && claude.model.trim() ? claude.model.trim() : agentModel ?? DEFAULT_MODEL;
	const maxUses = resolveMaxUses(claude);
	const effort = EFFORTS.has(claude.effort) ? claude.effort : void 0;
	const cacheKey = buildSearchCacheKey([PROVIDER_ID, query, model, maxUses, effort, count, country, freshness, dateAfter, dateBefore, language, JSON.stringify(domainFilter)]);
	const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
	const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
	if (cached) return cached;
	const start = Date.now();
	let result;
	try {
		result = await runClaudeSearch({
			apiKey,
			model,
			maxUses,
			effort,
			country,
			domainFilter,
			prompt: buildPrompt({ query, count, freshness, dateAfter, dateBefore, language }),
			timeoutSeconds: resolveTimeoutSeconds(searchConfig?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
			signal: context?.signal
		});
	} catch (error) {
		if (error instanceof Anthropic.APIUserAbortError) throw error;
		if (error instanceof Anthropic.APIError) throw new Error(describeApiError(error));
		throw error;
	}
	context?.signal?.throwIfAborted();
	if (result.stopReason === "refusal") return {
		error: "search_refused",
		message: "Claude declined this search request.",
		docs: DOCS_URL
	};
	const answer = collectAnswer(result.content);
	if (!answer.text) {
		const codes = collectSearchErrors(result.content);
		const detail = codes.length > 0 ? `web_search errors: ${codes.join(", ")}` : `stop_reason ${result.stopReason}`;
		throw new Error(`Claude search returned no answer (${detail}).`);
	}
	const payload = {
		query,
		provider: PROVIDER_ID,
		model,
		tookMs: Date.now() - start,
		usage: result.usage,
		externalContent: {
			untrusted: true,
			source: "web_search",
			provider: PROVIDER_ID,
			wrapped: true
		},
		content: wrapWebContent(answer.text),
		citations: answer.citations
	};
	writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
	return payload;
}

export { collectAnswer, executeClaudeSearch };
