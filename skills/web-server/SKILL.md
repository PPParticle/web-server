---
name: web-server
description: Search and read web content via the web-server MCP server. Use for web search, reading web pages, GitHub repos, arXiv papers, Stack Overflow Q&A, Reddit posts. Provides web_search + read_url tools.
---

# Web Server MCP 使用指南

两个工具,组合使用:**搜索 → 读取**。

## web_search: 搜索关键词

```
web_search(query, topic?, domains?, num?)
```

- `topic="academic"` → 搜 arxiv/dblp/semanticscholar/github(论文+代码)
- `topic="technical"` → 搜 stackoverflow/github/dev.to/MDN(文档+问答)
- `topic="community"` → 搜 reddit/HackerNews(讨论+评测)
- `domains=["site.com"]` → 自定义站点限定(覆盖 topic)
- 不设 topic/domains → 全网搜

## read_url: 读网页内容

```
read_url(url, engine?, no_cache?, with_links?)
```

- 默认 `engine="auto"`:自动识别 GitHub/arXiv/SO/Reddit 走 API(结构化),其他走 Readability,SPA 降级 Playwright
- `engine="playwright"`:强制浏览器渲染(JS 页/反爬站)
- `no_cache=true`:强制刷新
- `with_links=true`:末尾附正文链接列表(供你决定是否递归探索)

## 典型工作流

### 研究一个技术话题
```
1. web_search("topic", topic="technical") → 拿到 SO/博客 URL 列表
2. read_url(url) → 读最有价值的 1-2 篇
3. with_links=true → 看正文里的链接,决定是否深入
```

### 读论文
```
1. web_search(..., topic="academic") → 论文 URL 列表(注意 fan-out,见下节)
2. read_url("https://arxiv.org/abs/xxxx") → 结构化 metadata(标题/作者/摘要)
3. 需要全文?read_url("https://arxiv.org/html/xxxx") 或手动下载 PDF
```

## 学术搜索:关键词 fan-out 策略(重要)

`topic="academic"` 走 DBLP / arXiv / Semantic Scholar。**DBLP 是论文库,按标题精确匹配关键词**(多词 query 是 AND 语义,标题里不全有就返回 0)。所以**绝不能只发一个字面 query**,要对同一研究主题并行发多个 query 变体,合并去重:

- **同义词替换**:`offload / offloading / spill / swap / evict / displace`
- **存储/介质词**:`SSD / disk / NVMe / storage / tier / hierarchy`
- **缩写展开**:`KV cache / KV-cache / key-value cache`
- **子集拆分**:多词 query 拆成 2-3 词子 query 再并行 —— `kv cache offloading storage` → `kv cache ssd` + `kv cache disk` + `kv offloading` + `kv cache storage`(单发原词返回 0,拆开后能命中标题含 SSD/disk 的论文)
- **已知系统名**:研究某领域时直接搜代表性系统名(KV offload 领域:`mooncake`、`flexgen`、`vllm`、`tutti`、`infercept`)
- **目标 venue**:按会议名搜(`OSDI / SOSP / ASPLOS / FAST / SIGMOD / ICDE / VLDB / ISCA / MICRO`)

**流程**:并行发 3-6 个 query 变体 → 合并所有结果去重(按 URL)→ 按相关度/年份筛 → `read_url` 读 1-3 篇高价值论文。

> 残留缺口:若领域全新且你不知道任何系统名,纯标题搜仍可能漏(标题词汇与你 query 完全正交时)。此时考虑改 `domains` 或全网 `topic` 搜补充。

### 读 GitHub 项目
```
read_url("https://github.com/owner/repo") → 原始 README(1:1 markdown)
read_url("https://github.com/owner/repo/issues/123") → issue + 评论(API 结构化)
```

### 读 Stack Overflow
```
read_url("https://stackoverflow.com/questions/12345") → 问题 + 所有答案(含 Accepted)
```

## 注意事项

- **PDF**:read_url 检测到 PDF 会返回交接信号(不解析)。如需 PDF 内容,自己 curl 下载 + Python 读取。
- **缓存**:默认走缓存(同 URL 1h 内直接返回)。要最新内容用 `no_cache=true`。
- **掘金**:支持(Playwright 反检测渲染)。知乎/微信不支持(反爬封)。
- **搜索结果质量**:全网搜质量取决于后端(Tavily/SearXNG,Tavily 在受限网络也能搜)。**学术搜(DBLP/arXiv)按标题精确匹配,多词 query 易返回 0 —— 必须按上面「关键词 fan-out 策略」发多个变体并行,再合并。**
