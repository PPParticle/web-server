# MCP Web Server

**Give MCP clients (Claude Code, Cursor, etc.) a pair of eyes that can read the web.**

A self-hosted, zero-paid-API web reading and search service. Local-first with browser fallback — you stay in full control of crawling behavior, cost, and privacy. No metered Reader API middlemen, no cloud black box. Standard MCP protocol: configure once and use from any MCP client.

## Why use it

- 💸 **Zero paid third-party deps**: core capability runs on your own machine, no Reader API billing attached
- 🔐 **Privacy in your hands**: every request leaves from your environment, URLs never touch an intermediary cloud
- 🔌 **One-shot onboarding**: standard MCP protocol — configure once in Claude Code / Cursor and you're done
- 🎓 **Academic search out of the box**: dedicated channels for DBLP + Semantic Scholar + arXiv, no API key required

## Features

**🔍 Search & Read** — one tool to search, one to read; together they cover the full "find → digest" loop

- Type a keyword, get back titles + URLs + snippets; pick a link and convert it to clean article text in one shot
- Four built-in search scenes: web / academic papers / technical Q&A / community discussions — and you can scope to specific sites
- Academic search is completely free — no API key application needed

**🛤️ Dedicated channels for major sources** — custom adapters for the sites you actually read, more accurate than generic extraction

- GitHub repos & issues, arXiv papers, Stack Overflow Q&A, Reddit threads, and PDF documents all have purpose-built paths

**🧠 Clean article extraction** — what you get back isn't raw HTML, but structured text

- Code blocks keep their language tag, tables stay intact, body links are preserved
- Tuned for Chinese dev sites like Juejin

**🧯 Stable & reliable** — built for the real web, won't quit on you

- **Automatic fallback**: when plain fetch can't get through, a real browser spins up to render the page
- **Smart caching**: repeat visits return in seconds; failed URLs get short negative caching
- **Auto retry**: server hiccups and rate limits trigger exponential backoff retries
- **Safety guards**: built-in blocks prevent access to private IPs and cloud metadata endpoints

## Deployment

The walkthrough below assumes a **fresh Linux server** and goes from zero to working. macOS / Windows commands differ slightly but the order is the same.

### Prerequisites

**1. System packages** — `git` and `curl` are required; `docker` is only needed if you want to run the SearXNG search backend.

```bash
# Debian / Ubuntu
sudo apt update
sudo apt install -y git curl
sudo apt install -y docker.io       # optional, for SearXNG

# RHEL / CentOS / openEuler / Fedora (uses dnf)
sudo dnf install -y git curl
sudo dnf install -y docker          # optional, for SearXNG
```

**2. Node.js ≥ 20** (22 LTS recommended; npm 10+ ships with Node). [nvm](https://github.com/nvm-sh/nvm) is the recommended way — it sidesteps root permissions and version conflicts:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc        # make nvm visible to the current shell (or reopen the terminal)
nvm install 22
nvm use 22
node --version          # should print v22.x.x
npm --version           # should print 10.x.x
```

If you'd rather skip nvm, download the LTS installer from [nodejs.org](https://nodejs.org/), or use your distro's package manager (`apt install nodejs` / `dnf install nodejs`) — but distro-packaged Node is often too old to satisfy the ≥ 20 requirement.

### Steps

1. **Clone and build**:

```bash
git clone https://github.com/PPParticle/web-server.git
cd web-server
npm install            # install deps, ~1-2 min on first run
npm run build          # compile TypeScript into dist/
ls dist/index.js       # verify the artifact exists
```

Build output lands in `dist/`, entry point is `dist/index.js`.

2. **(Optional) Install the browser** — only if you need JS-rendered fallback. Playwright downloads Chromium and depends on a set of system libraries:

```bash
# One-liner (recommended): Chromium + system deps auto-detected for your distro (needs sudo)
npx playwright install --with-deps chromium
```

3. **Hook it into your MCP client** — add the following to your MCP client's config (on Linux, check your client's docs for the config file path):

```json
{
  "mcpServers": {
    "web-server": {
      "command": "node",
      "args": ["/absolute/path/to/web-server/dist/index.js"]
    }
  }
}
```

4. **Environment variables (optional)**:

| Variable | Purpose |
|----------|---------|
| `GITHUB_TOKEN` | GitHub Personal Access Token. Only the issue channel hits the REST API (api.github.com): without a token you're capped at 60 req/hour, with one at 5000/hour. The README channel uses raw and is unaffected. Public repos are readable without a token. |
| `SEARXNG_URL` | URL of a self-hosted SearXNG instance (e.g. `http://localhost:8080`); must have JSON output enabled. The **preferred backend** for web search. |
| `WEB_SERVER_PROXY_URL` | Optional HTTP proxy for direct external providers such as Reddit, e.g. `http://127.0.0.1:7888`. If unset, `HTTPS_PROXY` / `HTTP_PROXY` are also honored. |
| `TAVILY_API_KEY` | Tavily API key ([free signup](https://tavily.com), 1000 req/month). The **fallback backend** — kicks in when SearXNG fails. Also works in restricted networks (no Google/Bing access), recommended to configure. |
| `WEB_SERVER_CACHE_DIR` | Override the cache directory (default `~/.cache/mcp-web-server/`). |

**Search backends** (required for `web_search` with the default topic):

- **SearXNG** (preferred, self-hosted, free, no key — but the instance must be able to reach Google/Bing):
  ```bash
  docker run -d --name searxng -p 8080:8080 searxng/searxng
  # add "json" to search.formats in settings.yml, then: export SEARXNG_URL=http://localhost:8080
  ```
- **Tavily** (fallback, works in restricted networks): sign up at [tavily.com](https://tavily.com) to get a key, then `export TAVILY_API_KEY=tvly-...`. Recommended — catches what SearXNG misses.

> When both are configured: **SearXNG is tried first, Tavily is the automatic fallback**. Configure only one and that one is used; configure neither and web search returns an error. `topic="academic"` **needs no key at all** — it goes straight to DBLP + Semantic Scholar.

## Companion Skill (optional, strongly recommended)

The repo ships a `web-server` skill (`skills/web-server/SKILL.md`) that teaches the agent how to get the most out of both tools.

Install it into Claude Code:

```bash
cp -r skills/web-server ~/.claude/skills/
```

For other MCP clients (Cursor, etc.), place it according to that client's skill-loading mechanism.

## Tools

### `read_url`
Read a single URL and convert it to Markdown.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | (required) | http/https URL |
| `engine` | enum | `auto` | `auto`=automatic; `local`=force local parser; `playwright`=force browser; `jina`=removed (paid third-party, returns an explicit error) |
| `no_cache` | bool | `false` | When `true`, bypass the cache and re-fetch |
| `with_links` | bool | `false` | When `true`, append a list of body links so the agent can decide whether to explore further |

### `web_search`
Search by keyword and get back a result list (title + URL + snippet). Take a URL from the results and pass it to `read_url` for the full text. Web search backend: SearXNG first, Tavily fallback; `topic="academic"` goes through DBLP + Semantic Scholar (no key needed).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | Search keyword |
| `topic` | enum | `general` | `general`=web; `academic`=arxiv/dblp/semanticscholar/github; `technical`=stackoverflow/github/dev.to/MDN; `community`=reddit/HN |
| `domains` | string | (optional) | Custom domain override (takes precedence over topic), e.g. `["juejin.cn"]` |
| `num` | number | `10` | Max number of results |

Typical flow: `web_search("attention mechanism", topic="academic")` → pick a URL from results → `read_url(url)`. (For academic search, follow the fan-out strategy in the Skill — send multiple query variants.)

## Contributing

Pull requests welcome.

## License

MIT License
