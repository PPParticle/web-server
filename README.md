# MCP Web Server

**给 MCP 客户端（Claude Code、Cursor 等）装上一双能读懂互联网的眼睛。**

一个自己部署、零付费 API 依赖的网页读取与搜索服务。本地优先 + 浏览器降级的设计，让你完全掌控抓取行为、成本与隐私 —— 没有 Reader API 之类的计费中转，也没有云端黑盒。标准 MCP 协议，配置一次即可在任意 MCP 客户端中调用。

## 为什么用它

- 💸 **零第三方付费依赖**：核心能力跑在你自己的机器上，不绑定任何 Reader API 的计费表
- 🔐 **隐私可控**：所有请求从你的环境发出，URL 不经过中间云
- 🔌 **一键接入**：标准 MCP 协议，Claude Code / Cursor 配置一次永久可用
- 🎓 **学术搜索开箱即用**：DBLP + Semantic Scholar + arXiv 专用通道，无需任何 API key

## 功能特点

**🔍 搜索 & 读取** —— 一个搜,一个读,凑成完整的「搜到 → 读全」流程

- 输入关键词,拿到标题、链接、摘要;选中感兴趣的链接,一键转为干净的正文
- 内置四类搜索场景:全网 / 学术论文 / 技术问答 / 社区讨论,也能限定特定站点
- 学术搜索完全免费 —— 不必申请任何 API key

**🛤️ 主流站点专项优化** —— 对常用内容源做了定制适配,抓得更全更准

- GitHub 仓库与 issue、arXiv 论文、Stack Overflow 问答、Reddit 帖子、PDF 文档都有专属通道

**🧠 干净的正文提取** —— 拿到的不是原始网页,而是结构清晰的正文

- 代码块带语言标记、表格完整保留、正文链接不丢
- 对掘金等国内站点做了专门优化

**🧯 稳定可靠** —— 面向真实网络环境设计,不会动不动罢工

- **自动降级**:普通抓取搞不定时,自动启动浏览器去渲染页面
- **智能缓存**:重复访问的页面秒级返回,失败的链接短期不再重试
- **自动重试**:遇到服务器抖动、限流,自动退避重试
- **安全防护**:内置拦截,不会去访问内网地址或云服务的敏感端口

## 部署

1. 克隆并构建：

```bash
git clone https://github.com/PPParticle/web-server.git
cd web-server
npm install
npm run build
npx playwright install chromium   # 可选
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
| `SEARXNG_URL` | 自己部署 SearXNG 实例地址（如 `http://localhost:8080`），需开启 JSON 输出。全网搜的**首选后端** |
| `TAVILY_API_KEY` | Tavily API key（[免费注册](https://tavily.com)，1000 次/月）。全网搜的**回退后端** —— SearXNG 失败时兜底。**受限网络(无法访问 Google/Bing)也能搜**,建议配上 |
| `WEB_SERVER_CACHE_DIR` | 覆盖缓存目录（默认 `~/.cache/mcp-web-server/`） |

**搜索后端（全网搜 `web_search` 默认 topic 所需）**：

- **SearXNG**（首选，自己部署、免费、无 key，但实例要能访问 Google/Bing）：
  ```bash
  docker run -d --name searxng -p 8080:8080 searxng/searxng
  # 需在 settings.yml 的 search.formats 加 json；然后 export SEARXNG_URL=http://localhost:8080
  ```
- **Tavily**（回退，受限网络也能搜）：注册 [tavily.com](https://tavily.com) 拿 key → `export TAVILY_API_KEY=tvly-...`。建议配上，SearXNG 搜不到时兜底。

> 两个都配时：**SearXNG 优先，失败自动回退 Tavily**。只配其一则用那方；都不配则全网搜报错。`topic="academic"` **无需任何 key**，直接走 DBLP + Semantic Scholar。

## 配套 Skill（可选，强烈推荐）

仓库自带一个 `web-server` skill（`skills/web-server/SKILL.md`），教会 agent 如何用好这两个工具。

安装到 Claude Code：

```bash
cp -r skills/web-server ~/.claude/skills/
```

其它 MCP 客户端（Cursor 等）按各自 skill 加载机制放置即可。

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
| `domains` | string |（可选）| 自定义域名覆盖（优先于 topic），如 `["juejin.cn"]` |
| `num` | number | `10` | 返回结果数上限 |

典型流程：`web_search("attention mechanism", topic="academic")` → 从结果里挑 URL → `read_url(url)`。（学术搜记得按 Skill 里的 fan-out 策略发多个 query 变体。）

## 贡献

欢迎提交 Pull Request。

## 许可证

MIT License
