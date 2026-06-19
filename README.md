# MCP Web Server

一个自托管的 MCP (Model Context Protocol) 服务器，把网页内容读取并转换为 Markdown，供 Claude、Cursor 等 MCP 客户端使用。零第三方付费 API 依赖。

## 功能特点

- 🔌 **两个工具**：`read_url`（读网页）/ `web_search`（搜索）
- 🔎 **搜索**：`web_search` 搜索关键词返回 URL 列表 → 再用 `read_url` 读全文。全网搜后端 **SearXNG（自托管）优先、Tavily 回退**；`topic="academic"` 走 DBLP + Semantic Scholar（免费，无需 key）
- 🛤️ **专用通道**：GitHub（raw README / Issue API）、arXiv（Atom API）、Stack Overflow（SE API）、Reddit（.json）、PDF 交接
- 📄 **统一提取**：本地 fetch + Mozilla Readability + turndown，代码语言 / 表格 / 链接 / og: 元数据保真
- 🌐 **站点适配**：掘金等按 host 优先选择器（知乎/微信实测被反爬,已移除）
- 🧯 **降级策略**：本地解析 → 检测到访问限制（403 / 429 / Cloudflare 等）→ Playwright 浏览器渲染
- ⚡ **缓存**：文件系统缓存，按 host 分级 TTL；失败 URL 短期负缓存；自动淘汰
- 🔁 **重试**：5xx / 429 / 网络错误指数退避重试
- 🛡️ **SSRF 防护**：拦截私有 IP / 云元数据端点 / 危险 host

## 部署

1. 克隆并构建：

```bash
git clone https://github.com/PPParticle/web-server.git
cd web-server
npm install
npm run build
npx playwright install chromium   # 可选，用于 JS 渲染 / 反爬降级
```

2. 接入 MCP 客户端：在所用 MCP 客户端配置中加入（Linux 下配置文件路径自行查阅客户端文档）：

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

3. 环境变量（可选）：

| 变量 | 作用 |
|------|------|
| `GITHUB_TOKEN` | GitHub Personal Access Token。仅 issue 通道走 REST API（api.github.com），不设时限 60 次/小时、设置后 5000 次/小时；README 通道走 raw 不受影响。不设也能读公开仓库 |
| `SEARXNG_URL` | 自托管 SearXNG 实例地址（如 `http://localhost:8080`），需开启 JSON 输出。全网搜的**首选后端** |
| `TAVILY_API_KEY` | Tavily API key（[免费注册](https://tavily.com)，1000 次/月）。全网搜的**回退后端** —— SearXNG 失败时兜底。**受限网络(无法访问 Google/Bing)也能搜**,建议配上 |
| `WEB_SERVER_CACHE_DIR` | 覆盖缓存目录（默认 `~/.cache/mcp-web-server/`） |

**搜索后端（全网搜 `web_search` 默认 topic 所需）**：

- **SearXNG**（首选，自托管、免费、无 key，但实例要能访问 Google/Bing）：
  ```bash
  docker run -d --name searxng -p 8080:8080 searxng/searxng
  # 需在 settings.yml 的 search.formats 加 json；然后 export SEARXNG_URL=http://localhost:8080
  ```
- **Tavily**（回退，受限网络也能搜）：注册 [tavily.com](https://tavily.com) 拿 key → `export TAVILY_API_KEY=tvly-...`。建议配上，SearXNG 搜不到时兜底。

> 两个都配时：**SearXNG 优先，失败自动回退 Tavily**。只配其一则用那方；都不配则全网搜报错。`topic="academic"` **无需任何 key**，直接走 DBLP + Semantic Scholar。

## 配套 Skill（可选，强烈推荐）

仓库自带一个 `web-server` skill（`skills/web-server/SKILL.md`），教会 agent 如何用好这两个工具 —— 尤其**学术搜索的关键词 fan-out 策略**：DBLP 按标题精确匹配，多词 query（如 `kv offloading storage`）单发会返回 0，必须拆子集 / 换同义词 / 搜系统名并行再合并，否则召回严重偏低。

安装到 Claude Code：

```bash
cp -r skills/web-server ~/.claude/skills/
```

其它 MCP 客户端（Cursor 等）按各自 skill 加载机制放置即可。不装也能用工具，只是 agent 不会自动遵循 fan-out 策略，学术搜索召回会偏低。

## 工具

### `read_url`
读取单个 URL 并转为 Markdown。

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `url` | string |（必填）| http/https URL |
| `engine` | enum | `auto` | `auto`=自动；`local`=强制本地解析；`playwright`=强制浏览器；`jina`=已移除（付费第三方，调用会返回明确错误） |
| `no_cache` | bool | `false` | 为 `true` 时跳过缓存、重新抓取 |
| `with_links` | bool | `false` | 为 `true` 时在结果末尾附上正文链接清单，供 agent 决定是否进一步探索 |

### `web_search`
搜索关键词，返回结果列表（标题 + URL + 摘要）。拿到 URL 后用 `read_url` 读全文。全网搜后端：SearXNG 优先、Tavily 回退；`topic="academic"` 走 DBLP + Semantic Scholar（免 key）。

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `query` | string |（必填）| 搜索关键词 |
| `topic` | enum | `general` | `general`=全网；`academic`=arxiv/dblp/semanticscholar/github；`technical`=stackoverflow/github/dev.to/MDN；`community`=reddit/HN |
| `domains` | string[] |（可选）| 自定义域名覆盖（优先于 topic），如 `["juejin.cn"]` |
| `num` | number | `10` | 返回结果数上限 |

典型流程：`web_search("attention mechanism", topic="academic")` → 从结果里挑 URL → `read_url(url)`。（学术搜记得按 Skill 里的 fan-out 策略发多个 query 变体。）

## 贡献

欢迎提交 Pull Request。

## 许可证

MIT License
