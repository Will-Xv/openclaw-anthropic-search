# openclaw-anthropic-search

OpenClaw web search provider (`claude`) backed by Claude's server-side
[`web_search` tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool).
Community plugin, not affiliated with OpenClaw or Anthropic. Tested on OpenClaw
2026.10.10.

Each `web_search` call makes one Messages API request with the
`web_search_20260318` tool. Claude runs up to `maxUses` searches, then writes
a short cited answer. Searches are called directly (`allowed_callers:
["direct"]`): with dynamic filtering the answers came back without citations
and used more input tokens in testing. The provider returns that
answer with `[n]` markers and a matching `citations` list, the same shape as
the Gemini and Perplexity providers.

## Install

```bash
openclaw plugins install clawhub:@will-xv/anthropic-search --accept-capabilities
openclaw config set tools.web.search.provider claude
```

The ClawHub package is `@will-xv/anthropic-search`. To install a local build
instead, run `npm pack` and install `npm-pack:path/to/will-xv-anthropic-search-<version>.tgz`
with `--force`. `--accept-capabilities` accepts the plugin's declared capability
(the `claude` web search provider). A running Gateway picks the plugin up
without a restart.

## API key

If you already set up Anthropic in OpenClaw with an API key, the provider reuses
it: an API-key auth profile or the `ANTHROPIC_API_KEY` environment variable,
resolved through OpenClaw's public `api.runtime.modelAuth`. To use a different
key for search, set `plugins.entries.anthropic-search.config.webSearch.apiKey`;
it takes precedence. OAuth and setup tokens from a Claude subscription are not
used.

## Compatibility

Besides the public plugin API and `api.runtime.modelAuth`, the plugin imports
helpers from `openclaw/plugin-sdk/provider-web-search` and
`openclaw/plugin-sdk/provider-web-search-contract` (credential contract fields,
scoped search config, the configured-secret reader and the search cache).
OpenClaw lists both subpaths as private-local: JavaScript-only exports for
official plugins, with no compatibility promise. A later OpenClaw release may
need a plugin update.

## Settings (`plugins.entries.anthropic-search.config.webSearch`)

| Key | Default | Meaning |
|---|---|---|
| `model` | the agent's main model | Model that runs the search and writes the answer. Without it, the provider uses `agents.defaults.model.primary` when that is an `anthropic/` model, else `claude-opus-5-5`. Per-agent and per-session model overrides are not followed. |
| `maxUses` | `5` | Most searches per call (1–20); each is billed |
| `effort` | API default | `output_config.effort` for the search call |

`tools.web.search.timeoutSeconds` applies; when unset this provider waits up
to 120 s. `tools.web.search.cacheTtlMinutes` caches identical queries.

## Tool parameters

OpenClaw's shared `web_search` schema is mapped as follows:

| Parameter | Handling |
|---|---|
| `country` | `user_location.country` |
| `domain_filter` | Plain entries become `allowed_domains`, `-`-prefixed entries `blocked_domains`; mixing both is rejected |
| `freshness`, `date_after`, `date_before`, `language` | Instructions to Claude, not hard filters |
| `search_lang`, `ui_lang`, `max_tokens`, `max_tokens_per_page` | Rejected with an explicit error |

## Cost

Web search is billed at $10 per 1,000 searches plus tokens, including the
search results Claude reads.
