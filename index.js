import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createClaudeWebSearchProvider } from "./src/provider.js";

export default definePluginEntry({
	id: "anthropic-search",
	name: "Anthropic Search",
	description: "Web search through Claude's server-side web_search tool",
	register(api) {
		api.registerWebSearchProvider(createClaudeWebSearchProvider(api.runtime?.modelAuth));
	}
});
