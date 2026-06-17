# MCP Web Reader

一个自托管的 MCP (Model Context Protocol) 服务器，把网页内容读取并转换为 Markdown，供 Claude、Cursor 等 MCP 客户端使用。零第三方付费 API 依赖。

## 功能特点

- 🔌 **两个工具**：`read_url`（读网页）/ `web_search`（搜索）
- 🔎 **搜索**：`web_search` 经 Tavily 或 SearXNG 搜索关键词，返回 URL 列表 → 再用 `read_url` 读全文
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
git clone https://github.com/PPParticle/web-reader.git
cd web-reader
npm install
npm run build
npx playwright install chromium   # 可选，用于 JS 渲染 / 反爬降级
```

2. 接入 MCP 客户端：在所用 MCP 客户端配置中加入（Linux 下配置文件路径自行查阅客户端文档）：

```json
{
  "mcpServers": {
    "web-reader": {
      "command": "node",
      "args": ["/absolute/path/to/web-reader/dist/index.js"]
    }
  }
}
```

3. 环境变量（可选）：

| 变量 | 作用 |
|------|------|
| `GITHUB_TOKEN` | GitHub Personal Access Token。仅 issue 通道走 REST API（api.github.com），不设时限 60 次/小时、设置后 5000 次/小时；README 通道走 raw 不受影响。不设也能读公开仓库 |
| `TAVILY_API_KEY` | Tavily API key（[免费注册](https://tavily.com)，1000 次/月）。`web_search` 用 Tavily —— **受限网络(无法访问 Google/Bing)也能搜**。优先于此项 |
| `SEARXNG_URL` | 自托管 SearXNG 实例地址（如 `http://localhost:8080`），需开启 JSON 输出。Tavily 未配时用它 |
| `WEB_READER_CACHE_DIR` | 覆盖缓存目录（默认 `~/.cache/mcp-web-reader/`） |

**搜索后端（二选一，启用 `web_search` 所需）**：

- **Tavily**（推荐，受限网络可用）：注册 [tavily.com](https://tavily.com) 拿 key → `export TAVILY_API_KEY=tvly-...`。
- **SearXNG**（自托管、免费、无 key，但实例要能访问 Google/Bing）：
  ```bash
  docker run -d --name searxng -p 8080:8080 searxng/searxng
  # 需在 settings.yml 的 search.formats 加 json；然后 export SEARXNG_URL=http://localhost:8080
  ```

> 两个都配时优先 Tavily。

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
搜索关键词，返回结果列表（标题 + URL + 摘要）。拿到 URL 后用 `read_url` 读全文。后端：配 `TAVILY_API_KEY` 用 Tavily，否则配 `SEARXNG_URL` 用 SearXNG。

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `query` | string |（必填）| 搜索关键词 |
| `topic` | enum | `general` | `general`=全网；`academic`=arxiv/dblp/semanticscholar/github；`technical`=stackoverflow/github/dev.to/MDN；`community`=reddit/HN |
| `domains` | string[] |（可选）| 自定义域名覆盖（优先于 topic），如 `["juejin.cn"]` |
| `num` | number | `10` | 返回结果数上限 |

典型流程：`web_search("attention mechanism", topic="academic")` → 从结果里挑 URL → `read_url(url)`。

## 贡献

欢迎提交 Pull Request。

## 许可证

MIT License
