import fs from 'fs';
import path from 'path';
import { formatApiDoc } from './formatters/api-doc-formatter.js';
import { formatMcpDoc } from './formatters/mcp-doc-formatter.js';

/**
 * API 文档类型列表 - 这些类型应该使用统一格式
 */
const API_DOC_TYPES = new Set([
  'alphavantage-api',
  'eulerpool-api',
  'finnhub-api',
  'tiingo-api',
  'polyrouter-api',
  'polyrouter-doc',
  'financial-modeling-prep-api',
  'financial-datasets-api',
  'massive-api',
  'serpapi-ai-overview',
  'serpapi-doc',
  'brave-search-api',
  'api-doc',
  'qveris-api',
  'tavily-api',
  'tickdb-api',
  'infoway-api',
  'itick-doc',
  'itick-api',
  'eodhd-api',
  'alltick-api',
  'apitracker-category',
  'apitracker-api-detail',
  'google-discovery-doc',
  '60s-api-doc',
  // 新增的 API 类型
  'yfinance-api',
  'apify-openapi',
  'apify-api-doc',
  'investoday-api-doc',
  'tsanghi-api'
]);

/**
 * MCP 文档类型列表 - 这些类型应该使用统一 MCP 格式
 */
const MCP_DOC_TYPES = new Set([
  'modelscope-mcp-server',
  'aliyun-bailian-mcp-list',
  'aliyun-bailian-mcp-detail',
  'lanyun-mcp',
  'tokenflux-mcp'
]);

/**
 * 非 API 文档类型 - 这些类型有特定的生成器
 */
const NON_API_TYPES = new Set([
  'portal',
  'list-page',
  'article',
  'search-result',
  'ecommerce-product',
  'ecommerce-list',
  'rsshub-route',
  'eodhd-blog',
  'tokenflux-doc',
  'tushare-pro-api',
  'generic'
]);

/**
 * Markdown Generator - 负责将解析的页面数据转换为Markdown格式
 */
class MarkdownGenerator {
  /**
   * 生成Markdown内容
   * @param {PageData} pageData - 页面数据
   * @returns {string} Markdown文本
   */
  generate(pageData) {
    let markdown = '';

    // 理杏仁财务页面：只输出表格，不加 frontmatter
    if (pageData.type === 'lixinger') {
      markdown = this.generateLixinger(pageData);
      return markdown || '';
    }

    if (pageData.type === 'google-discovery-doc') {
      markdown = this.generateGoogleDiscoveryDoc(pageData);
    }

    // MCP 文档类型使用统一 MCP 格式
    if (!markdown && MCP_DOC_TYPES.has(pageData.type)) {
      const unifiedMcpData = formatMcpDoc(pageData);
      markdown = this.generateUnifiedMcp(unifiedMcpData);
    }

    // 非 API 类型使用特定生成器
    if (!markdown && NON_API_TYPES.has(pageData.type)) {
      markdown = this.generateNonApi(pageData);
    }

    // API 文档类型使用统一格式
    if (!markdown && API_DOC_TYPES.has(pageData.type)) {
      const unifiedData = formatApiDoc(pageData);
      markdown = this.generateUnified(unifiedData);
    }

    // 如果已经是统一格式（有 api 字段），直接使用统一生成方法
    if (!markdown && pageData.api && typeof pageData.api === 'object') {
      markdown = this.generateUnified(pageData);
    }

    // 如果已经是统一 MCP 格式（有 mcp 字段），直接使用 MCP 生成方法
    if (!markdown && pageData.mcp && typeof pageData.mcp === 'object') {
      markdown = this.generateUnifiedMcp(pageData);
    }

    // 尝试转换为统一格式
    if (!markdown) {
      const unifiedData = formatApiDoc(pageData);
      if (unifiedData.api.endpoint || unifiedData.parameters.length > 0 || unifiedData.codeExamples.length > 0) {
        markdown = this.generateUnified(unifiedData);
      }
    }

    // 兼容旧格式（没有type字段）- 作为最后的后备
    if (!markdown) {
      markdown = this.generateGeneric(pageData);
    }

    return this.normalizeMarkdownOutput(markdown, pageData);
  }

  /**
   * 处理非 API 类型的文档
   * @param {PageData} pageData - 页面数据
   * @returns {string} Markdown文本
   */
  generateNonApi(pageData) {
    switch (pageData.type) {
      case 'portal':
        return this.generatePortal(pageData);
      case 'list-page':
        return this.generateListPage(pageData);
      case 'article':
        return this.generateArticle(pageData);
      case 'search-result':
        return this.generateSearchResult(pageData);
      case 'ecommerce-product':
        return this.generateEcommerceProduct(pageData);
      case 'ecommerce-list':
        return this.generateEcommerceList(pageData);
      case 'rsshub-route':
        return this.generateRsshubRoute(pageData);
      case 'eodhd-blog':
        return this.generateEodhdBlog(pageData);
      case 'tokenflux-doc':
        return this.generateTokenfluxDoc(pageData);
      case 'tushare-pro-api':
        return this.generateTushareProApi(pageData);
      case 'generic':
        return this.generateGeneric(pageData);
      default:
        return '';
    }
  }

  /**
   * 生成理杏仁财务页面Markdown — 只输出表格，不加任何其他内容
   * @param {PageData} pageData - 理杏仁页面数据
   * @returns {string} Markdown文本
   */
  generateLixinger(pageData) {
    const lines = [];

    if (pageData.tables && pageData.tables.length > 0) {
      for (const table of pageData.tables) {
        const csv = this.tableToCsv(table);
        if (csv) lines.push(csv);
      }
    }

    return lines.join('\n\n');
  }

  /**
   * 将表格转换为 CSV 字符串
   */
  tableToCsv(table) {
    if (!table || (!table.headers?.length && !table.rows?.length)) return '';

    const escapeCsv = (cell) => {
      if (cell === null || cell === undefined) return '';
      const str = String(cell);
      // 如果包含逗号、引号或换行，用引号包裹并转义内部引号
      if (/[",\n\r]/.test(str)) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const lines = [];
    if (table.headers && table.headers.length > 0) {
      lines.push(table.headers.map(escapeCsv).join(','));
    }
    if (table.rows && table.rows.length > 0) {
      for (const row of table.rows) {
        lines.push(row.map(escapeCsv).join(','));
      }
    }
    return lines.join('\n');
  }

  generate60sApiDoc(pageData) {
    const sections = [];

    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    if (pageData.description) {
      sections.push('## 描述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    if (pageData.content && pageData.content.length > 0) {
      sections.push('## 文档内容\n');
      pageData.content.forEach((item) => {
        if (item.type === 'heading') {
          sections.push(`### ${item.content}`);
        } else if (item.type === 'table' && item.rows?.length > 0) {
          const [header, ...rows] = item.rows;
          sections.push(`| ${header.join(' | ')} |`);
          sections.push(`| ${header.map(() => '---').join(' | ')} |`);
          rows.forEach((row) => sections.push(`| ${row.join(' | ')} |`));
        } else {
          sections.push(item.content || '');
        }
      });
      sections.push('');
    }

    if (pageData.codeBlocks && pageData.codeBlocks.length > 0) {
      sections.push('## 代码示例\n');
      pageData.codeBlocks.forEach((block, index) => {
        sections.push(`### 示例 ${index + 1}`);
        sections.push(`\`\`\`${block.language || 'text'}`);
        sections.push(block.code || '');
        sections.push('```\n');
      });
    }

    return sections.join('\n');
  }

  generateTokenfluxDoc(pageData) {
    const sections = [];

    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    if (pageData.description) {
      sections.push('## 描述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 处理 API 端点数据
    const apiEndpoints = pageData.metadata?.apiEndpoints || [];
    if (apiEndpoints.length > 0) {
      sections.push('## API 端点\n');

      apiEndpoints.forEach((endpoint, index) => {
        sections.push(`### ${endpoint.name || `端点 ${index + 1}`}\n`);

        if (endpoint.description) {
          sections.push(`${endpoint.description}\n`);
        }

        if (endpoint.method || endpoint.endpoint) {
          sections.push('| 属性 | 值 |');
          sections.push('|------|-----|');
          if (endpoint.method) {
            sections.push(`| Method | \`${endpoint.method}\` |`);
          }
          if (endpoint.endpoint) {
            sections.push(`| Endpoint | \`${endpoint.endpoint}\` |`);
          }
          sections.push('');
        }

        // 参数表格
        if (endpoint.parameters && endpoint.parameters.length > 0) {
          sections.push('#### 请求参数\n');
          sections.push('| 参数名 | 类型 | 必需 | 默认值 | 描述 |');
          sections.push('|--------|------|------|--------|------|');

          endpoint.parameters.forEach(param => {
            const name = param.name || '';
            const type = param.type || '-';
            const required = param.required ? '是' : '否';
            const defaultVal = param.default !== undefined ? String(param.default) : '-';
            let desc = (param.description || '-').replace(/\n/g, ' ');
            // 截断过长的描述
            if (desc.length > 100) {
              desc = desc.substring(0, 100) + '...';
            }
            sections.push(`| \`${name}\` | ${type} | ${required} | ${defaultVal} | ${desc} |`);
          });
          sections.push('');

          // 如果有枚举值，添加选项说明
          const enumParams = endpoint.parameters.filter(p => p.enum && p.enum.length > 0);
          if (enumParams.length > 0) {
            sections.push('#### 参数选项\n');
            enumParams.forEach(param => {
              sections.push(`**${param.name}** 可选值:`);
              sections.push(param.enum.slice(0, 10).map(e => `- \`${e}\``).join('\n'));
              if (param.enum.length > 10) {
                sections.push(`- ... 等 ${param.enum.length} 个选项`);
              }
              sections.push('');
            });
          }
        }
      });
    }

    // 处理内容数组（保留兼容性）
    if (pageData.content && pageData.content.length > 0) {
      // 如果有 API 端点数据，跳过重复的内容
      const hasApiEndpoints = apiEndpoints.length > 0;

      sections.push('## 文档内容\n');
      pageData.content.forEach((item) => {
        if (item.type === 'heading') {
          // 如果已有 API 端点数据，跳过工具名称标题
          if (hasApiEndpoints && item.content?.startsWith('EXA_AI__')) {
            return;
          }
          sections.push(`### ${item.content}\n`);
        } else if (item.type === 'text') {
          sections.push(item.content || '');
          sections.push('');
        } else if (item.type === 'list' && item.items?.length > 0) {
          item.items.forEach((listItem) => {
            sections.push(`- ${listItem}`);
          });
          sections.push('');
        } else if (item.type === 'code') {
          const lang = item.language || 'text';
          sections.push(`\`\`\`${lang}`);
          sections.push(item.code || '');
          sections.push('```\n');
        }
      });
    }

    // 认证信息
    if (pageData.metadata?.securitySchemes?.api_key) {
      const auth = pageData.metadata.securitySchemes.api_key;
      sections.push('## 认证方式\n');
      sections.push(`API Key 认证：通过 ${auth.location} 传递 \`${auth.name}\``);
      sections.push('');
    }

    return sections.join('\n');
  }

  generateAliyunBailianMcp(pageData) {
    const sections = [];

    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 列表页处理
    if (pageData.type === 'aliyun-bailian-mcp-list') {
      if (pageData.totalTools) {
        sections.push(`## MCP 工具总数\n`);
        sections.push(`共发现 ${pageData.totalTools} 个 MCP 工具\n`);
      }

      if (pageData.categories && pageData.categories.length > 0) {
        sections.push('## 分类\n');
        sections.push(pageData.categories.slice(0, 20).join(' | '));
        sections.push('\n');
      }

      if (pageData.tools && pageData.tools.length > 0) {
        sections.push('## MCP 工具列表\n');
        pageData.tools.forEach((tool, index) => {
          sections.push(`### ${index + 1}. ${tool.name || '未命名工具'}\n`);
          if (tool.provider) {
            sections.push(`**提供者**: ${tool.provider}\n`);
          }
          if (tool.category) {
            sections.push(`**分类**: ${tool.category}\n`);
          }
          if (tool.description) {
            sections.push(`**描述**: ${tool.description}\n`);
          }
          if (tool.stats && tool.stats.length > 0) {
            sections.push(`**统计**: ${tool.stats.join(', ')}\n`);
          }
          if (tool.toolId) {
            sections.push(`**工具ID**: ${tool.toolId}\n`);
          }
          if (tool.detailUrl) {
            sections.push(`**详情页**: ${tool.detailUrl}\n`);
          }
          sections.push('');
        });
      }

      // 添加发现的新链接摘要
      if (pageData.detailLinks && pageData.detailLinks.length > 0) {
        sections.push('## 发现的详情页链接\n');
        sections.push(`共 ${pageData.detailLinks.length} 个详情页链接可供爬取\n`);
        pageData.detailLinks.slice(0, 10).forEach(link => {
          sections.push(`- ${link}`);
        });
        if (pageData.detailLinks.length > 10) {
          sections.push(`- ... 还有 ${pageData.detailLinks.length - 10} 个链接`);
        }
        sections.push('');
      }
    }

    // 详情页处理
    if (pageData.type === 'aliyun-bailian-mcp-detail') {
      if (pageData.toolId) {
        sections.push(`## 工具ID\n`);
        sections.push(pageData.toolId);
        sections.push('');
      }

      if (pageData.provider) {
        sections.push(`## 提供者\n`);
        sections.push(pageData.provider);
        sections.push('');
      }

      if (pageData.stats && Object.keys(pageData.stats).length > 0) {
        sections.push('## 统计数据\n');
        Object.entries(pageData.stats).forEach(([key, value]) => {
          sections.push(`- **${key}**: ${value}`);
        });
        sections.push('');
      }

      if (pageData.serviceIntro && pageData.serviceIntro.length > 0) {
        sections.push('## 服务介绍\n');
        pageData.serviceIntro.forEach(intro => {
          sections.push(intro);
          sections.push('\n');
        });
      }

      if (pageData.toolList && pageData.toolList.length > 0) {
        sections.push('## 工具列表\n');
        pageData.toolList.forEach((tool, index) => {
          sections.push(`### ${index + 1}. ${tool.name}`);
          if (tool.description) {
            sections.push(`${tool.description}`);
          }
          sections.push('');
        });
      }

      if (pageData.tabs && pageData.tabs.length > 0) {
        sections.push('## 标签页\n');
        sections.push(pageData.tabs.join(' | '));
        sections.push('\n');
      }

      if (pageData.bodyText) {
        sections.push('## 页面内容\n');
        // 清理多余空行
        const cleanedText = pageData.bodyText.replace(/\n{3,}/g, '\n\n');
        sections.push(cleanedText.slice(0, 5000));
        sections.push('');
      }
    }

    return sections.join('\n');
  }

  generateInfowayApi(pageData) {
    const sections = [];

    if (pageData.markdownContent) {
      sections.push(pageData.markdownContent.trim());
      sections.push('');
    }

    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    return sections.join('\n').trim() + '\n';
  }

  /**
   * 生成统一格式的 Markdown 文档
   * @param {Object} data - 统一格式的文档数据
   * @returns {string} Markdown文本
   */
  generateUnified(data) {
    const sections = [];

    // 标题
    if (data.title) {
      sections.push(`# ${data.title}\n`);
    }

    // 源 URL
    if (data.url) {
      sections.push('## 源URL\n');
      sections.push(data.url);
      sections.push('');
    }

    // 描述
    if (data.description) {
      sections.push('## 描述\n');
      sections.push(data.description);
      sections.push('');
    }

    // API 端点信息
    if (data.api && (data.api.method || data.api.endpoint || data.api.baseUrl)) {
      sections.push('## API 端点\n');
      if (data.api.method) {
        sections.push(`**Method**: \`${data.api.method}\``);
      }
      if (data.api.endpoint) {
        sections.push(`**Endpoint**: \`${data.api.endpoint}\``);
      }
      if (data.api.baseUrl) {
        sections.push(`**Base URL**: \`${data.api.baseUrl}\``);
      }
      sections.push('');
    }

    // 请求头
    if (data.requestHeaders && data.requestHeaders.length > 0) {
      sections.push('## 请求头\n');
      sections.push('| 名称 | 类型 | 必需 | 描述 |');
      sections.push('|------|------|------|------|');
      data.requestHeaders.forEach(h => {
        const name = this.escapeMarkdown(h.name || '');
        const type = this.escapeMarkdown(h.type || '-');
        const required = h.required ? '是' : '否';
        const desc = this.escapeMarkdown(h.description || '-');
        sections.push(`| \`${name}\` | ${type} | ${required} | ${desc} |`);
      });
      sections.push('');
    }

    // 请求参数
    if (data.parameters && data.parameters.length > 0) {
      sections.push('## 请求参数\n');
      sections.push('| 参数名 | 类型 | 必需 | 默认值 | 描述 |');
      sections.push('|--------|------|------|--------|------|');
      data.parameters.forEach(p => {
        const name = this.escapeMarkdown(p.name || '');
        const type = this.escapeMarkdown(p.type || '-');
        const required = p.required ? '是' : '否';
        const defaultVal = p.default ? this.escapeMarkdown(p.default) : '-';
        const desc = this.escapeMarkdown(p.description || '-');
        sections.push(`| \`${name}\` | ${type} | ${required} | ${defaultVal} | ${desc} |`);
      });
      sections.push('');
    }

    // 请求体
    if (data.requestBody && (data.requestBody.description || data.requestBody.schema || data.requestBody.example)) {
      sections.push('## 请求体\n');
      if (data.requestBody.description) {
        sections.push(data.requestBody.description);
        sections.push('');
      }
      if (data.requestBody.schema) {
        sections.push('**Schema**:');
        sections.push('```json');
        sections.push(typeof data.requestBody.schema === 'string'
          ? data.requestBody.schema
          : JSON.stringify(data.requestBody.schema, null, 2));
        sections.push('```\n');
      }
      if (data.requestBody.example) {
        sections.push('**Example**:');
        sections.push('```json');
        sections.push(typeof data.requestBody.example === 'string'
          ? data.requestBody.example
          : JSON.stringify(data.requestBody.example, null, 2));
        sections.push('```\n');
      }
    }

    // 响应状态
    if (data.responseStatuses && data.responseStatuses.length > 0) {
      sections.push('## 响应状态\n');
      sections.push('| 状态码 | 描述 |');
      sections.push('|--------|------|');
      data.responseStatuses.forEach(s => {
        const code = this.escapeMarkdown(s.code || '');
        const desc = this.escapeMarkdown(s.description || '-');
        sections.push(`| ${code} | ${desc} |`);
      });
      sections.push('');
    }

    // 响应字段
    if (data.responseFields && data.responseFields.length > 0) {
      sections.push('## 响应字段\n');
      sections.push('| 字段名 | 类型 | 描述 |');
      sections.push('|--------|------|------|');
      data.responseFields.forEach(f => {
        const name = this.escapeMarkdown(f.name || '');
        const type = this.escapeMarkdown(f.type || '-');
        const desc = this.escapeMarkdown(f.description || '-');
        sections.push(`| \`${name}\` | ${type} | ${desc} |`);
      });
      sections.push('');
    }

    // 请求示例
    if (data.requestExamples && data.requestExamples.length > 0) {
      sections.push('## 请求示例\n');
      data.requestExamples.forEach((example, index) => {
        if (data.requestExamples.length > 1) {
          const lang = example.language || 'text';
          sections.push(`### 示例 ${index + 1} (${lang})\n`);
        }
        const lang = example.language || 'text';
        sections.push(`\`\`\`${lang}`);
        sections.push(this.sanitizeCodeBlockContent(example.code || ''));
        sections.push('```\n');
      });
    }

    // 响应示例
    if (data.responseExamples && data.responseExamples.length > 0) {
      sections.push('## 响应示例\n');
      data.responseExamples.forEach((example, index) => {
        if (data.responseExamples.length > 1) {
          const lang = example.language || 'text';
          sections.push(`### 示例 ${index + 1} (${lang})\n`);
        }
        const lang = example.language || 'json';
        sections.push(`\`\`\`${lang}`);
        sections.push(this.sanitizeCodeBlockContent(example.code || ''));
        sections.push('```\n');
      });
    }

    // 代码示例
    if (data.codeExamples && data.codeExamples.length > 0) {
      sections.push('## 代码示例\n');
      data.codeExamples.forEach((example, index) => {
        if (data.codeExamples.length > 1) {
          const lang = example.language || 'text';
          sections.push(`### 示例 ${index + 1} (${lang})\n`);
        }
        const lang = example.language || 'text';
        sections.push(`\`\`\`${lang}`);
        sections.push(this.sanitizeCodeBlockContent(example.code || ''));
        sections.push('```\n');
      });
    }

    // 认证方式
    if (data.authentication) {
      sections.push('## 认证方式\n');
      sections.push(data.authentication);
      sections.push('');
    }

    // 速率限制
    if (data.rateLimit) {
      sections.push('## 速率限制\n');
      sections.push(data.rateLimit);
      sections.push('');
    }

    // 错误处理
    if (data.errors && data.errors.length > 0) {
      sections.push('## 错误处理\n');
      sections.push('| 错误码 | 描述 | 处理建议 |');
      sections.push('|--------|------|----------|');
      data.errors.forEach(e => {
        const code = this.escapeMarkdown(e.code || '-');
        const desc = this.escapeMarkdown(e.description || '-');
        const solution = this.escapeMarkdown(e.solution || '-');
        sections.push(`| ${code} | ${desc} | ${solution} |`);
      });
      sections.push('');
    }

    // 注意事项
    if (data.notes && data.notes.length > 0) {
      sections.push('## 注意事项\n');
      data.notes.forEach(n => {
        const prefix = n.type === 'warning' ? '⚠️ ' : n.type === 'important' ? '❗ ' : '- ';
        sections.push(`${prefix}${n.content}`);
      });
      sections.push('');
    }

    // 相关链接
    if (data.relatedLinks && data.relatedLinks.length > 0) {
      sections.push('## 相关链接\n');
      data.relatedLinks.forEach(l => {
        const title = l.title || l.url;
        sections.push(`- [${title}](${l.url})`);
      });
      sections.push('');
    }

    // 更新日志
    if (data.changelog && data.changelog.length > 0) {
      sections.push('## 更新日志\n');
      data.changelog.forEach(c => {
        const version = c.version ? `${c.version}` : '';
        const date = c.date ? ` - ${c.date}` : '';
        const changes = c.changes || '';
        sections.push(`${version}${date}: ${changes}`);
      });
      sections.push('');
    }

    // 文档正文（优先使用解析器提供的结构化 markdown）
    if (data.markdownContent && data.type !== 'itick-api') {
      const cleanedMarkdownContent = data.markdownContent
        .replace(/^#\s*.+\n/, '')
        .trim();
      if (cleanedMarkdownContent) {
        sections.push('## 文档正文\n');
        sections.push(cleanedMarkdownContent);
        sections.push('');
      }
    }

    // 详细内容（原始内容作为后备）
    if (data.rawContent && !data.markdownContent && sections.join('\n').length < data.rawContent.length * 0.5) {
      sections.push('## 详细内容\n');
      let cleaned = data.rawContent
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      const maxRawContentLength = data.rawContentMaxLength || 50000;
      if (cleaned.length > maxRawContentLength) {
        cleaned = `${cleaned.substring(0, maxRawContentLength)}\n\n... (内容已截断)`;
      }

      sections.push(cleaned);
      sections.push('');
    }

    return sections.join('\n');
  }

  sanitizeCodeBlockContent(code) {
    if (!code) return '';
    return String(code).replace(/```/g, '``\\`');
  }

  /**
   * 生成统一格式的 MCP 文档 Markdown
   * @param {Object} data - 统一格式的 MCP 文档数据
   * @returns {string} Markdown文本
   */
  generateUnifiedMcp(data) {
    const sections = [];

    // 标题
    if (data.title) {
      sections.push(`# ${data.title}\n`);
    }

    // 源 URL
    if (data.url) {
      sections.push('## 源URL\n');
      sections.push(data.url);
      sections.push('');
    }

    // MCP 核心信息
    if (data.mcp && (data.mcp.serverId || data.mcp.provider || data.mcp.category)) {
      sections.push('## MCP 信息\n');
      if (data.mcp.serverId) {
        sections.push(`- **服务器ID**: ${data.mcp.serverId}`);
      }
      if (data.mcp.provider) {
        sections.push(`- **提供者**: ${data.mcp.provider}`);
      }
      if (data.mcp.category) {
        sections.push(`- **分类**: ${data.mcp.category}`);
      }
      if (data.mcp.version) {
        sections.push(`- **版本**: ${data.mcp.version}`);
      }
      sections.push('');
    }

    // 兼容旧格式：工具ID 在顶层
    if (!data.mcp?.serverId && data.serverId) {
      sections.push('## 工具ID\n');
      sections.push(data.serverId);
      sections.push('');
    }

    // 兼容旧格式：提供者在顶层
    if (!data.mcp?.provider && data.provider) {
      sections.push('## 提供者\n');
      sections.push(data.provider);
      sections.push('');
    }

    // 统计数据
    if (data.stats && Object.keys(data.stats).some(k => data.stats[k])) {
      sections.push('## 统计数据\n');
      if (data.stats.users) sections.push(`- **users**: ${data.stats.users}`);
      if (data.stats.calls) sections.push(`- **calls**: ${data.stats.calls}`);
      if (data.stats.avgTime) sections.push(`- **avgTime**: ${data.stats.avgTime}`);
      if (data.stats.toolCount) sections.push(`- **toolCount**: ${data.stats.toolCount}`);
      sections.push('');
    }

    // 描述/简介
    if (data.description) {
      sections.push('## 简介\n');
      sections.push(data.description);
      sections.push('');
    }

    // 标签
    if (data.tags && data.tags.length > 0) {
      sections.push('## 标签\n');
      sections.push(data.tags.map(tag => `\`${tag}\``).join(' '));
      sections.push('');
    }

    // 服务介绍
    if (data.serviceIntro && data.serviceIntro.length > 0) {
      sections.push('## 服务介绍\n');
      data.serviceIntro.forEach(intro => {
        sections.push(intro);
        sections.push('\n');
      });
    }

    // 工具列表
    if (data.tools && data.tools.length > 0) {
      sections.push('## 可用工具\n');
      data.tools.forEach((tool, index) => {
        const toolTitle = tool.displayName ? `${tool.displayName} (\`${tool.name}\`)` : `\`${tool.name}\``;
        sections.push(`### ${index + 1}. ${toolTitle}`);
        if (tool.description) {
          sections.push('');
          sections.push(tool.description);
        }

        // 输入参数
        if (tool.inputs && tool.inputs.length > 0) {
          sections.push('');
          sections.push('**输入参数:**');
          sections.push('');
          sections.push('| 参数名 | 类型 | 必需 | 描述 |');
          sections.push('|--------|------|------|------|');
          tool.inputs.forEach(param => {
            sections.push(`| \`${param.name}\` | ${param.type || 'string'} | ${param.required ? '是' : '否'} | ${param.description || ''} |`);
          });
        }

        // 输出
        if (tool.outputs && tool.outputs.length > 0) {
          sections.push('');
          sections.push('**输出:**');
          const structuredOutputs = tool.outputs.filter(o => o && typeof o === 'object' && (o.name || o.type || o.description));
          if (structuredOutputs.length > 0) {
            sections.push('');
            sections.push('| 字段名 | 类型 | 描述 |');
            sections.push('|--------|------|------|');
            structuredOutputs.forEach((o) => {
              sections.push(`| \`${this.escapeMarkdown(o.name || '')}\` | ${this.escapeMarkdown(o.type || '-')} | ${this.escapeMarkdown(o.description || '-')} |`);
            });
          } else {
            sections.push(tool.outputs.map(o => typeof o === 'string' ? `\`${o}\`` : `\`${o.name || ''}\``).join(', '));
          }
        }

        sections.push('');
      });
    }

    // 安装说明
    if (data.installation) {
      sections.push('## 安装\n');
      sections.push(data.installation);
      sections.push('');
    }

    // 配置说明
    if (data.configuration) {
      sections.push('## 配置\n');
      sections.push(data.configuration);
      sections.push('');
    }

    // 代码示例
    if (data.codeExamples && data.codeExamples.length > 0) {
      sections.push('## 代码示例\n');
      data.codeExamples.forEach((example, index) => {
        sections.push(`### 示例 ${index + 1}`);
        sections.push('');
        sections.push(`\`\`\`${example.language || 'text'}`);
        sections.push(example.code || '');
        sections.push('```');
        sections.push('');
      });
    }

    // 服务器详细信息
    if (data.serverInfo && Object.keys(data.serverInfo).length > 0) {
      sections.push('## 服务器信息\n');
      Object.entries(data.serverInfo).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
          sections.push(`- **${key}**: ${value}`);
        }
      });
      sections.push('');
    }

    // 注意事项
    if (data.notes && data.notes.length > 0) {
      sections.push('## 注意事项\n');
      data.notes.forEach(note => {
        if (typeof note === 'string') {
          sections.push(`- ${note}`);
        } else if (note.content) {
          sections.push(`- **${note.type || '注意'}**: ${note.content}`);
        }
      });
      sections.push('');
    }

    // 相关链接
    if (data.relatedLinks && data.relatedLinks.length > 0) {
      sections.push('## 相关链接\n');
      data.relatedLinks.forEach(link => {
        if (typeof link === 'string') {
          sections.push(`- ${link}`);
        } else if (link.url) {
          sections.push(`- [${link.title || link.url}](${link.url})`);
        }
      });
      sections.push('');
    }

    // 原始 Markdown 内容
    if (data.markdownContent && data.markdownContent.length > 100) {
      const cleaned = data.markdownContent
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .substring(0, 5000);
      sections.push('## 详细内容\n');
      sections.push(cleaned);
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 生成 Alpha Vantage API 文档 Markdown
   * @param {PageData} pageData - Alpha Vantage API 文档页面数据
   * @returns {string} Markdown文本
   */
  generateAlphavantageApi(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 概述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 如果有 API 详细信息，生成详细文档
    if (pageData.apiDetails && pageData.apiDetails.length > 0) {
      sections.push('---\n');
      sections.push('# API 详细文档\n');

      pageData.apiDetails.forEach((api, index) => {
        // API 标题
        let title = api.title || api.functionName || `API ${index + 1}`;
        const tags = [];
        if (api.premium) tags.push('Premium');
        if (api.trending) tags.push('Trending');
        if (api.utility) tags.push('Utility');
        if (tags.length > 0) {
          title += ` [${tags.join(', ')}]`;
        }
        sections.push(`## ${title}\n`);

        // 函数名
        if (api.functionName) {
          sections.push(`**函数名**: \`${api.functionName}\`\n`);
        }

        // 描述
        if (api.description) {
          sections.push('### 描述\n');
          sections.push(api.description);
          sections.push('');
        }

        // 请求端点
        sections.push('### 请求端点\n');
        sections.push('```text');
        sections.push('GET https://www.alphavantage.co/query');
        sections.push('```\n');

        // 必需参数
        const requiredParams = api.parameters.filter(p => p.required);
        if (requiredParams.length > 0) {
          sections.push('### 必需参数\n');
          sections.push('| 参数名 | 描述 |');
          sections.push('|--------|------|');
          requiredParams.forEach(p => {
            const desc = this.escapeMarkdown(p.description || '-');
            sections.push(`| \`${p.name}\` | ${desc} |`);
          });
          sections.push('');
        }

        // 可选参数
        const optionalParams = api.parameters.filter(p => !p.required);
        if (optionalParams.length > 0) {
          sections.push('### 可选参数\n');
          sections.push('| 参数名 | 描述 |');
          sections.push('|--------|------|');
          optionalParams.forEach(p => {
            const desc = this.escapeMarkdown(p.description || '-');
            sections.push(`| \`${p.name}\` | ${desc} |`);
          });
          sections.push('');
        }

        // 示例 URL
        if (api.examples && api.examples.length > 0) {
          sections.push('### 示例 URL\n');
          api.examples.forEach((example, i) => {
            const desc = example.description || '';
            if (desc && desc.length < 100) {
              sections.push(`**${desc}**`);
            }
            sections.push('```text');
            sections.push(example.url || example);
            sections.push('```\n');
          });
        }

        // 代码示例
        if (api.codeExamples && api.codeExamples.length > 0) {
          sections.push('### 代码示例\n');
          api.codeExamples.forEach((example, i) => {
            if (api.codeExamples.length > 1) {
              sections.push(`#### ${example.language.charAt(0).toUpperCase() + example.language.slice(1)}\n`);
            }
            sections.push(`\`\`\`${example.language}`);
            sections.push(example.code);
            sections.push('```\n');
          });
        }

        sections.push('---\n');
      });
    }
    // 如果有分类信息但没有详细信息，显示 API 分类概览
    else if (pageData.categories && pageData.categories.length > 0) {
      sections.push('## API 分类\n');
      pageData.categories.forEach(cat => {
        sections.push(`### ${cat.name}\n`);
        if (cat.apis && cat.apis.length > 0) {
          cat.apis.forEach(api => {
            let apiLine = `- [${api.title || api.name}](#${api.id})`;
            const apiTags = [];
            if (api.premium) apiTags.push('Premium');
            if (api.trending) apiTags.push('Trending');
            if (api.utility) apiTags.push('Utility');
            if (apiTags.length > 0) {
              apiLine += ` [${apiTags.join(', ')}]`;
            }
            sections.push(apiLine);
          });
        }
        sections.push('');
      });
    }

    // 单个 API 的详细信息
    if (pageData.functionName && !pageData.apiDetails?.length) {
      // 函数名
      sections.push('## 函数名\n');
      sections.push(`\`${pageData.functionName}\``);
      sections.push('');

      // 所属分类
      if (pageData.category) {
        sections.push('## 分类\n');
        sections.push(pageData.category);
        sections.push('');
      }

      // 请求端点
      sections.push('## 请求端点\n');
      sections.push(`**方法**: ${pageData.method || 'GET'}\n`);
      sections.push('```text');
      sections.push(pageData.endpoint);
      sections.push('```\n');

      // 必需参数
      if (pageData.requiredParams && pageData.requiredParams.length > 0) {
        sections.push('## 必需参数\n');
        sections.push('| 参数名 | 描述 |');
        sections.push('|--------|------|');
        pageData.requiredParams.forEach(p => {
          const desc = this.escapeMarkdown(p.description || '-');
          sections.push(`| \`${p.name}\` | ${desc} |`);
        });
        sections.push('');
      }

      // 可选参数
      if (pageData.optionalParams && pageData.optionalParams.length > 0) {
        sections.push('## 可选参数\n');
        sections.push('| 参数名 | 描述 |');
        sections.push('|--------|------|');
        pageData.optionalParams.forEach(p => {
          const desc = this.escapeMarkdown(p.description || '-');
          sections.push(`| \`${p.name}\` | ${desc} |`);
        });
        sections.push('');
      }

      // 示例 URL
      if (pageData.examples && pageData.examples.length > 0) {
        sections.push('## 示例 URL\n');
        pageData.examples.forEach((example, index) => {
          const url = typeof example === 'string' ? example : example.url;
          const desc = typeof example === 'object' ? example.description : '';
          if (desc && desc.length < 100) {
            sections.push(`**${desc}**`);
          }
          sections.push('```text');
          sections.push(url);
          sections.push('```\n');
        });
      }

      // 代码示例
      if (pageData.codeExamples && pageData.codeExamples.length > 0) {
        sections.push('## 代码示例\n');
        pageData.codeExamples.forEach((example, index) => {
          if (pageData.codeExamples.length > 1) {
            sections.push(`### ${example.language.charAt(0).toUpperCase() + example.language.slice(1)}\n`);
          }
          sections.push(`\`\`\`${example.language}`);
          sections.push(example.code);
          sections.push('```\n');
        });
      }
    }

    return sections.join('\n');
  }

  /**
   * 生成 Eulerpool API 文档 Markdown
   * @param {PageData} pageData - Eulerpool API 文档页面数据
   * @returns {string} Markdown文本
   */
  generateEulerpoolApi(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 描述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 添加请求方法和端点
    if (pageData.endpoint) {
      sections.push('## 请求端点\n');
      sections.push(`**方法**: ${pageData.requestMethod || 'GET'}\n`);
      sections.push('```text');
      sections.push(pageData.endpoint);
      sections.push('```');
      sections.push('');
    }

    // 添加响应信息
    if (pageData.responses && pageData.responses.length > 0) {
      sections.push('## Responses\n');
      pageData.responses.forEach(r => {
        sections.push(`### ${r.code}`);
        if (r.description) {
          sections.push(r.description);
        }
        sections.push('');
      });
    }

    // 添加 curl 示例
    if (pageData.curlExample) {
      sections.push('## 请求示例\n');
      sections.push('```bash');
      sections.push(pageData.curlExample);
      sections.push('```');
      sections.push('');
    }

    // 添加 JSON 响应示例
    if (pageData.jsonExample) {
      sections.push('## 响应示例\n');
      sections.push('```json');
      try {
        const parsed = JSON.parse(pageData.jsonExample);
        sections.push(JSON.stringify(parsed, null, 2));
      } catch {
        sections.push(pageData.jsonExample);
      }
      sections.push('```');
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 生成 Finnhub API 文档 Markdown
   * @param {PageData} pageData - Finnhub API 文档页面数据
   * @returns {string} Markdown文本
   */
  generateFinnhubApi(pageData) {
    const sections = [];

    const normalizeLang = (lang = 'text') => {
      const normalized = String(lang).toLowerCase();
      if (normalized === 'curl') return 'bash';
      if (normalized === 'c#') return 'csharp';
      if (normalized === 'node.js') return 'javascript';
      return normalized;
    };

    const mergeCodeExamples = (primary = [], fallback = []) => {
      const merged = [];
      const seen = new Set();

      for (const example of [...primary, ...fallback]) {
        if (!example || !example.code) continue;
        const language = example.language || 'text';
        const code = String(example.code).trim();
        if (!code) continue;
        const key = `${language.toLowerCase()}::${code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({ language, code });
      }

      return merged;
    };

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 如果有原始内容，解析并格式化
    if (pageData.rawContent) {
      const parsed = this.parseFinnhubRawContent(pageData.rawContent);

      // 描述
      if (parsed.description) {
        sections.push('## 描述\n');
        sections.push(parsed.description);
        sections.push('');
      }

      // API 信息
      if (parsed.method || parsed.endpoints.length > 0) {
        sections.push('## API 端点\n');
        if (parsed.method) {
          sections.push(`**Method**: \`${parsed.method}\``);
          sections.push('');
        }
        if (parsed.endpoints.length > 0) {
          sections.push('**Endpoints**:');
          sections.push('```text');
          parsed.endpoints.forEach(ep => sections.push(ep));
          sections.push('```');
          sections.push('');
        }
        if (parsed.premium) {
          sections.push(`> ⚠️ ${parsed.premium}`);
          sections.push('');
        }
      }

      // 参数表格
      if (parsed.parameters.length > 0) {
        sections.push('## 参数\n');
        sections.push('| 参数名 | 必需 | 描述 |');
        sections.push('|--------|------|------|');
        parsed.parameters.forEach(p => {
          const required = p.required ? '是' : '否';
          sections.push(`| \`${p.name}\` | ${required} | ${this.escapeMarkdown(p.description || '')} |`);
        });
        sections.push('');
      }

      // 响应字段表格
      if (parsed.responseFields.length > 0) {
        sections.push('## 响应字段\n');
        sections.push('| 字段名 | 描述 |');
        sections.push('|--------|------|');
        parsed.responseFields.forEach(f => {
          sections.push(`| \`${f.name}\` | ${this.escapeMarkdown(f.description || '')} |`);
        });
        sections.push('');
      }

      // 代码示例（优先结构化字段，回退 rawContent）
      const codeExamples = mergeCodeExamples(pageData.codeExamples, parsed.codeExamples);
      if (codeExamples.length > 0) {
        sections.push('## 代码示例\n');
        codeExamples.forEach(example => {
          if (example.language && example.code) {
            sections.push(`### ${example.language}`);
            sections.push(`\`\`\`${normalizeLang(example.language)}`);
            sections.push(example.code);
            sections.push('```');
            sections.push('');
          }
        });
      }

      // 响应示例
      const sampleResponse = pageData.sampleResponse || parsed.sampleResponse;
      if (sampleResponse) {
        sections.push('## 响应示例\n');
        sections.push('```json');
        sections.push(sampleResponse);
        sections.push('```');
        sections.push('');
      }
    } else {
      // 否则使用结构化数据

      // 添加描述
      if (pageData.description) {
        sections.push('## 描述\n');
        sections.push(pageData.description);
        sections.push('');
      }

      // 添加请求方法和端点
      if (pageData.endpoint) {
        sections.push('## 请求端点\n');
        sections.push(`**方法**: ${pageData.requestMethod || 'GET'}\n`);
        sections.push('```text');
        sections.push(pageData.endpoint);
        sections.push('```');
        sections.push('');
      }

      // 添加参数信息
      if (pageData.parameters && pageData.parameters.length > 0) {
        sections.push('## 参数\n');
        sections.push('| 参数名 | 类型 | 必填 | 描述 |');
        sections.push('|--------|------|------|------|');
        pageData.parameters.forEach(p => {
          const required = p.required ? '是' : '否';
          sections.push(`| ${p.name} | ${p.type || '-'} | ${required} | ${p.description || '-'} |`);
        });
        sections.push('');
      }

      // 添加响应信息
      if (pageData.responses && pageData.responses.length > 0) {
        sections.push('## Responses\n');
        pageData.responses.forEach(r => {
          sections.push(`### ${r.code}`);
          if (r.description) {
            sections.push(r.description);
          }
          sections.push('');
        });
      }

      // 添加 curl 示例
      if (pageData.curlExample) {
        sections.push('## 请求示例\n');
        sections.push('```bash');
        sections.push(pageData.curlExample);
        sections.push('```');
        sections.push('');
      }

      // 添加 JSON 响应示例
      if (pageData.jsonExample) {
        sections.push('## 响应示例\n');
        sections.push('```json');
        try {
          const parsed = JSON.parse(pageData.jsonExample);
          sections.push(JSON.stringify(parsed, null, 2));
        } catch {
          sections.push(pageData.jsonExample);
        }
        sections.push('```');
        sections.push('');
      }
    }

    return sections.join('\n');
  }

  /**
   * 解析 Finnhub 原始内容
   * @param {string} rawContent - 原始内容
   * @returns {Object} 解析后的结构化数据
   */
  parseFinnhubRawContent(rawContent) {
    const result = {
      description: '',
      method: '',
      endpoints: [],
      premium: '',
      parameters: [],
      responseFields: [],
      codeExamples: [],
      sampleResponse: ''
    };

    if (!rawContent) return result;

    const lines = rawContent.split('\n').map(l => l.trim()).filter(l => l);

    let currentSection = '';
    let currentParam = null;
    let currentResponseField = null;
    let currentCodeLang = '';
    let codeBuffer = [];
    let jsonResponseBuffer = [];
    let inJsonResponse = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lowerLine = line.toLowerCase();

      // 检测 section 标题
      if (lowerLine === 'method:' || lowerLine.startsWith('method: ')) {
        currentSection = 'method';
        const methodMatch = lowerLine.match(/^method:\s*(GET|POST|PUT|DELETE|PATCH)$/i);
        if (methodMatch) {
          result.method = methodMatch[1].toUpperCase();
        }
        continue;
      }
      if (lowerLine === 'examples:' || lowerLine.startsWith('examples:')) {
        currentSection = 'examples';
        continue;
      }
      if (lowerLine === 'premium:' || lowerLine.startsWith('premium:')) {
        currentSection = 'premium';
        const premiumMatch = line.match(/^premium:\s*(.+)$/i);
        if (premiumMatch) {
          result.premium = premiumMatch[1].trim();
        }
        continue;
      }
      if (lowerLine === 'arguments:' || lowerLine.startsWith('arguments:')) {
        currentSection = 'arguments';
        continue;
      }
      if (lowerLine.startsWith('response attributes')) {
        currentSection = 'response';
        continue;
      }
      if (lowerLine === 'sample code') {
        currentSection = 'code';
        continue;
      }
      if (lowerLine === 'sample response') {
        currentSection = 'json';
        inJsonResponse = false;
        jsonResponseBuffer = [];
        continue;
      }

      // 根据 section 处理内容
      switch (currentSection) {
        case '':
          // 描述部分
          if (!result.description && line.length > 10 && !lowerLine.startsWith('method') && !lowerLine.startsWith('premium')) {
            if (line !== lines[0] && !line.match(/^[A-Z][a-z]+\s+[A-Z]/)) {
              result.description = line;
            }
          }
          break;

        case 'method':
          if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(line.toUpperCase())) {
            result.method = line.toUpperCase();
          }
          break;

        case 'examples':
          if (line.startsWith('/')) {
            result.endpoints.push(line);
          }
          break;

        case 'premium':
          if (!result.premium) {
            result.premium = line;
          }
          break;

        case 'arguments':
          const paramMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*?)(REQUIRED|optional)$/i);
          if (paramMatch) {
            if (currentParam) {
              result.parameters.push(currentParam);
            }
            currentParam = {
              name: paramMatch[1],
              required: paramMatch[2]?.toUpperCase() === 'REQUIRED',
              description: ''
            };
          } else if (currentParam && !line.match(/^[A-Z]+\s*$/) && line.length > 2) {
            if (currentParam.description) {
              currentParam.description += ' ' + line;
            } else {
              currentParam.description = line;
            }
          }
          break;

        case 'response':
          if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(line) && line.length < 30) {
            if (currentResponseField) {
              result.responseFields.push(currentResponseField);
            }
            currentResponseField = {
              name: line,
              description: ''
            };
          } else if (currentResponseField && !line.match(/^[A-Z]+\s*$/)) {
            if (currentResponseField.description) {
              currentResponseField.description += ' ' + line;
            } else {
              currentResponseField.description = line;
            }
          }
          break;

        case 'code':
          if (['cURL', 'Python', 'Javascript', 'JavaScript', 'Go', 'Ruby', 'Kotlin', 'PHP', 'Rust', 'Java', 'C#', 'Swift', 'TypeScript', 'Node.js'].includes(line)) {
            if (currentCodeLang && codeBuffer.length > 0) {
              result.codeExamples.push({
                language: currentCodeLang,
                code: codeBuffer.join('\n')
              });
              codeBuffer = [];
            }
            currentCodeLang = line;
          } else if (currentCodeLang) {
            const isCode = line.startsWith('import ') || line.startsWith('from ') ||
                line.includes('finnhub') || line.includes('Client') ||
                line.startsWith('curl ') || line.startsWith('http ') ||
                line.includes('http') ||
                (line.includes('(') && (line.includes('print') || line.includes('console') || line.includes('fetch'))) ||
                line.includes('finnhub_client') || line.includes('api_key') ||
                line.includes('def ') || line.includes('async ') ||
                line.includes('await ') || line.includes('.then(') ||
                line.includes(' => ') || line.includes('->') ||
                line.startsWith('const ') || line.startsWith('let ') ||
                line.startsWith('var ') || line.startsWith('func ') ||
                line.includes('fmt.') || line.includes('Net::') ||
                line.includes('requests.') || line.includes('axios');

            if (isCode) {
              if (line.includes('import finnhub') || line.includes('finnhub_client') || line.includes('finnhub.')) {
                currentCodeLang = 'Python';
              } else if (line.includes('curl ')) {
                currentCodeLang = 'cURL';
              } else if (line.includes('console.') || line.includes('fetch(') || line.includes('axios')) {
                currentCodeLang = 'JavaScript';
              } else if (line.includes('fmt.')) {
                currentCodeLang = 'Go';
              } else if (line.includes('Net::')) {
                currentCodeLang = 'Ruby';
              }
              codeBuffer.push(line);
            }
          }
          break;

        case 'json':
          if (line.startsWith('{') || line.startsWith('[')) {
            inJsonResponse = true;
          }
          if (inJsonResponse) {
            jsonResponseBuffer.push(line);
          }
          break;
      }
    }

    // 保存最后一个参数和字段
    if (currentParam) {
      result.parameters.push(currentParam);
    }
    if (currentResponseField) {
      result.responseFields.push(currentResponseField);
    }

    // 保存最后的代码块
    if (currentCodeLang && codeBuffer.length > 0) {
      result.codeExamples.push({
        language: currentCodeLang,
        code: codeBuffer.join('\n')
      });
    }

    // 格式化 JSON 响应
    if (jsonResponseBuffer.length > 0) {
      try {
        const jsonStr = jsonResponseBuffer.join('\n');
        const parsed = JSON.parse(jsonStr);
        result.sampleResponse = JSON.stringify(parsed, null, 2);
      } catch {
        result.sampleResponse = jsonResponseBuffer.join('\n');
      }
    }

    return result;
  }

  /**
   * 生成 Tiingo API 文档 Markdown
   * @param {PageData} pageData - Tiingo API 文档页面数据
   * @returns {string} Markdown文本
   */
  generateTiingoApi(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 描述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 添加章节内容
    if (pageData.sections && pageData.sections.length > 0) {
      pageData.sections.forEach((section, index) => {
        // 跳过第一个章节标题（已作为主标题）
        if (index === 0 && section.title === pageData.title) {
          // 只输出内容，不重复标题/描述（描述已在「## 描述」输出）
          const filteredContent = section.content.filter((item, itemIndex) => {
            if (item.type !== 'text') return true;
            if (!pageData.description) return true;
            // 仅对首个段落去重，避免把正文里合法重复段落误删
            return !(itemIndex === 0 && item.content.trim() === pageData.description.trim());
          });

          filteredContent.forEach(item => {
            this.addTiingoContentItem(sections, item);
          });
        } else {
          // 输出章节标题和内容
          sections.push(`## ${section.title}\n`);
          section.content.forEach(item => {
            this.addTiingoContentItem(sections, item);
          });
        }
      });
    }

    // 添加代码示例（如果有单独提取的）
    if (pageData.codeExamples && pageData.codeExamples.length > 0) {
      const hasCodeInSections = pageData.sections?.some(s => s.content.some(c => c.type === 'code'));
      if (!hasCodeInSections) {
        sections.push('## 代码示例\n');
        pageData.codeExamples.forEach((code, index) => {
          sections.push(`\`\`\`text`);
          sections.push(code);
          sections.push('```');
          sections.push('');
        });
      }
    }

    // 添加 tab 内容（Request、Examples 等）
    if (pageData.tabContents && pageData.tabContents.length > 0) {
      // 收集主体内容中的所有表格，用于去重
      const mainTables = [];
      if (pageData.sections) {
        pageData.sections.forEach(section => {
          section.content.forEach(item => {
            if (item.type === 'table' && item.data) {
              mainTables.push(this.tableSignature(item.data));
            }
          });
        });
      }

      // 按 sectionTitle 分组
      const groupedBySection = {};
      pageData.tabContents.forEach(tab => {
        const key = tab.sectionTitle || 'Other';
        if (!groupedBySection[key]) {
          groupedBySection[key] = [];
        }
        groupedBySection[key].push(tab);
      });

      // 输出每个 section 的 tab 内容
      Object.entries(groupedBySection).forEach(([sectionTitle, tabs]) => {
        // 过滤掉与主体内容完全重复的tab组
        const filteredTabs = tabs.map(tab => {
          // 记录原始表格数量
          const originalTableCount = (tab.tables || []).length;
          // 过滤掉重复的表格
          const filteredTables = (tab.tables || []).filter(table => {
            const sig = this.tableSignature(table);
            return !mainTables.includes(sig);
          });
          // 返回包含原始表格数量信息的对象
          return {
            ...tab,
            tables: filteredTables,
            _originalTableCount: originalTableCount,
            _tablesFiltered: originalTableCount > 0 && filteredTables.length === 0
          };
        }).filter(tab => {
          // 只保留有实际内容的tab
          const hasTables = tab.tables && tab.tables.length > 0;
          const hasCode = tab.codeExamples && tab.codeExamples.length > 0;
          // 如果表格被过滤掉了，不把原始内容当作有效内容
          const hasContent = !tab._tablesFiltered && tab.content && tab.content.trim().length > 50;
          return hasTables || hasCode || hasContent;
        });

        // 如果所有tab都被过滤掉了，跳过整个section
        if (filteredTabs.length === 0) return;

        sections.push(`### ${sectionTitle} - Tab 内容\n`);

        filteredTabs.forEach((tab, tabIndex) => {
          // 使用实际的 tab label，如果没有则使用索引
          const tabLabel = tab.label || `Tab ${tab.tabIndex + 1}`;
          sections.push(`#### ${tabLabel}\n`);

          // 输出表格
          if (tab.tables && tab.tables.length > 0) {
            tab.tables.forEach((table, tableIndex) => {
              if (table && table.length > 0) {
                const headers = table[0];
                sections.push('| ' + headers.join(' | ') + ' |');
                sections.push('| ' + headers.map(() => '---').join(' | ') + ' |');
                for (let i = 1; i < table.length; i++) {
                  sections.push('| ' + table[i].join(' | ') + ' |');
                }
                sections.push('');
              }
            });
          }

          // 输出代码示例
          if (tab.codeExamples && tab.codeExamples.length > 0) {
            tab.codeExamples.forEach(code => {
              sections.push('```text');
              sections.push(code);
              sections.push('```');
              sections.push('');
            });
          }

          // 输出原始内容（如果没有表格和代码，且表格没有被过滤掉）
          const hasTablesOrCode = (tab.tables && tab.tables.length > 0) || (tab.codeExamples && tab.codeExamples.length > 0);
          if (!hasTablesOrCode && !tab._tablesFiltered) {
            if (tab.content && tab.content.trim()) {
              sections.push(tab.content);
              sections.push('');
            }
          }
        });
      });
    }

    // 如果没有结构化内容，使用原始内容
    if ((!pageData.sections || pageData.sections.length === 0) && pageData.rawContent) {
      sections.push('## 内容\n');
      sections.push(pageData.rawContent);
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 辅助方法：添加 Tiingo 内容项
   * @param {string[]} sections - sections 数组
   * @param {Object} item - 内容项
   */
  addTiingoContentItem(sections, item) {
    switch (item.type) {
      case 'text':
        sections.push(item.content);
        sections.push('');
        break;
      case 'heading':
        sections.push(`### ${item.content}\n`);
        break;
      case 'code':
        sections.push('```text');
        sections.push(item.content);
        sections.push('```');
        sections.push('');
        break;
      case 'table':
        if (item.data && item.data.length > 0) {
          const headers = item.data[0];
          sections.push('| ' + headers.join(' | ') + ' |');
          sections.push('| ' + headers.map(() => '---').join(' | ') + ' |');
          for (let i = 1; i < item.data.length; i++) {
            sections.push('| ' + item.data[i].join(' | ') + ' |');
          }
          sections.push('');
        }
        break;
      case 'list':
        item.items.forEach((listItem, i) => {
          sections.push(`- ${listItem}`);
        });
        sections.push('');
        break;
    }
  }

  /**
   * 辅助方法：生成表格签名，用于比较表格是否重复
   * @param {Array} table - 表格数据
   * @returns {string} 表格签名
   */
  tableSignature(table) {
    if (!table || table.length === 0) return '';
    // 只使用表头和前两行数据作为签名
    const header = table[0] ? table[0].join('|') : '';
    const row1 = table[1] ? table[1].join('|') : '';
    const row2 = table[2] ? table[2].join('|') : '';
    return `${header}||${row1}||${row2}`;
  }

  /**
   * 生成 PolyRouter API 文档 Markdown
   * @param {PageData} pageData - PolyRouter API 文档页面数据
   * @returns {string} Markdown文本
   */
  generatePolyrouterApi(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加描述（优先使用 description，其次使用 subtitle）
    const description = pageData.description || pageData.subtitle;
    if (description) {
      sections.push('## 描述\n');
      sections.push(description);
      sections.push('');
    }

    // 添加 API 端点信息
    if (pageData.endpoint) {
      sections.push('## API 端点\n');
      sections.push(`**方法**: \`${pageData.endpoint.method}\``);
      sections.push(`**路径**: \`${pageData.endpoint.path}\``);
      sections.push('');
    }

    // 添加章节内容
    if (pageData.sections && pageData.sections.length > 0) {
      sections.push('## 章节\n');
      pageData.sections.forEach(section => {
        const prefix = '#'.repeat(section.level + 1);
        sections.push(`${prefix} ${section.text}`);
      });
      sections.push('');
    }

    // 添加参数表格
    if (pageData.parameters && pageData.parameters.length > 0) {
      sections.push('## 参数\n');
      pageData.parameters.forEach((param, index) => {
        if (param.headers && param.headers.length > 0 && param.rows && param.rows.length > 0) {
          if (pageData.parameters.length > 1) {
            sections.push(`### 参数表 ${index + 1}\n`);
          }
          // 表头
          sections.push('| ' + param.headers.join(' | ') + ' |');
          sections.push('| ' + param.headers.map(() => '---').join(' | ') + ' |');
          // 数据行
          param.rows.forEach(row => {
            const values = param.headers.map(h => row[h] || '-');
            sections.push('| ' + values.join(' | ') + ' |');
          });
          sections.push('');
        }
      });
    }

    // 添加代码示例
    if (pageData.codeExamples && pageData.codeExamples.length > 0) {
      sections.push('## 代码示例\n');
      pageData.codeExamples.forEach((example, index) => {
        if (pageData.codeExamples.length > 1) {
          sections.push(`### 示例 ${index + 1} (${example.language || 'text'})\n`);
        }
        sections.push(`\`\`\`${example.language || 'text'}`);
        sections.push(example.code);
        sections.push('```');
        sections.push('');
      });
    }

    // 添加响应示例
    if (pageData.responses && pageData.responses.length > 0) {
      sections.push('## 响应示例\n');
      pageData.responses.forEach((response, index) => {
        if (pageData.responses.length > 1) {
          sections.push(`### 响应 ${index + 1}\n`);
        }
        if (response.status) {
          sections.push(`**状态码**: ${response.status}`);
        }
        sections.push('```json');
        if (response.body) {
          sections.push(JSON.stringify(response.body, null, 2));
        } else if (response.raw) {
          sections.push(response.raw);
        }
        sections.push('```');
        sections.push('');
      });
    }

    // 添加警告
    if (pageData.warnings && pageData.warnings.length > 0) {
      sections.push('## 警告\n');
      pageData.warnings.forEach(warning => {
        sections.push(`> ⚠️ ${warning}`);
      });
      sections.push('');
    }

    // 添加提示
    if (pageData.notes && pageData.notes.length > 0) {
      sections.push('## 提示\n');
      pageData.notes.forEach(note => {
        sections.push(`> 💡 ${note}`);
      });
      sections.push('');
    }

    // 添加提示框
    if (pageData.callouts && pageData.callouts.length > 0) {
      sections.push('## 注意事项\n');
      pageData.callouts.forEach(callout => {
        const icon = callout.type === 'warning' ? '⚠️' : (callout.type === 'info' ? '💡' : '📝');
        sections.push(`> ${icon} ${callout.content}`);
      });
      sections.push('');
    }

    // 添加原始内容作为后备 - 仅在没有足够的结构化数据时添加
    const hasStructuredData = (pageData.codeExamples && pageData.codeExamples.length > 0) ||
                               (pageData.parameters && pageData.parameters.length > 0) ||
                               pageData.endpoint ||
                               (pageData.sections && pageData.sections.length > 0);
    if (pageData.rawContent && !hasStructuredData) {
      // 清理 rawContent，移除可能的重复内容
      let cleanedContent = pageData.rawContent;
      // 移除可能的 UI 残留
      cleanedContent = cleanedContent
        .replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (cleanedContent.length > 100) {
        sections.push('## 详细内容\n');
        sections.push(cleanedContent);
        sections.push('');
      }
    }

    return sections.join('\n');
  }

  /**
   * 生成 Financial Modeling Prep API 文档 Markdown
   * @param {PageData} pageData - Financial Modeling Prep API 文档页面数据
   * @returns {string} Markdown文本
   */
  generateFinancialModelingPrepApi(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 描述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 如果有解析的 API 部分，逐个输出
    if (pageData.apis && pageData.apis.length > 0) {
      pageData.apis.forEach((api, index) => {
        // API 标题
        sections.push(`---\n`);
        sections.push(`## ${api.title}\n`);

        // 描述
        if (api.description) {
          sections.push(`${api.description}\n`);
          sections.push('');
        }

        // 端点
        if (api.endpoint) {
          sections.push('### 端点\n');
          sections.push('```text');
          sections.push(api.endpoint);
          sections.push('```');
          sections.push('');
        }

        // 参数表格
        if (api.parameters && api.parameters.length > 0) {
          sections.push('### 参数\n');
          sections.push('| 参数名 | 类型 | 必填 | 描述 |');
          sections.push('|--------|------|------|------|');
          api.parameters.forEach(p => {
            const required = p.required ? '是' : '否';
            const desc = (p.description || '-').replace(/\n/g, ' ');
            sections.push(`| ${p.name} | ${p.type || '-'} | ${required} | ${desc} |`);
          });
          sections.push('');
        }

        // 响应示例
        if (api.response) {
          sections.push('### 响应示例\n');
          sections.push('```json');
          try {
            const parsed = JSON.parse(api.response);
            sections.push(JSON.stringify(parsed, null, 2));
          } catch {
            sections.push(api.response);
          }
          sections.push('```');
          sections.push('');
        }

        // 代码示例
        if (api.codeExamples && api.codeExamples.length > 0) {
          sections.push('### 代码示例\n');
          api.codeExamples.forEach(example => {
            sections.push('```');
            sections.push(example);
            sections.push('```');
            sections.push('');
          });
        }
      });
    }

    // 如果没有解析到 API 部分，但有 markdown 内容，输出 markdown 内容
    if ((!pageData.apis || pageData.apis.length === 0) && pageData.markdownContent) {
      sections.push('## 内容\n');
      sections.push(pageData.markdownContent);
      sections.push('');
    } else if ((!pageData.apis || pageData.apis.length === 0) && pageData.rawContent) {
      sections.push('## 内容\n');
      sections.push(pageData.rawContent);
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 生成 Financial Datasets API 文档 Markdown
   * @param {PageData} pageData - Financial Datasets API 文档页面数据
   * @returns {string} Markdown文本
   */
  generateFinancialDatasetsApi(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 描述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 添加请求方法和端点
    if (pageData.endpoint) {
      sections.push('## 请求端点\n');
      sections.push(`**方法**: \`${pageData.requestMethod || 'GET'}\`\n`);
      sections.push('```text');
      sections.push(pageData.endpoint);
      sections.push('```');
      sections.push('');
    }

    // 添加请求参数
    if (pageData.requestParams && pageData.requestParams.length > 0) {
      sections.push('## 请求参数\n');
      sections.push('| 参数名 | 类型 | 必填 | 描述 |');
      sections.push('|--------|------|------|------|');
      pageData.requestParams.forEach(p => {
        const required = p.required === '是' || p.required === 'required' ? '✓' : (p.required || '-');
        sections.push(`| \`${p.name || '-'}\` | ${p.type || '-'} | ${required} | ${p.description || '-'} |`);
      });
      sections.push('');
    }

    // 添加响应字段
    if (pageData.responseFields && pageData.responseFields.length > 0) {
      sections.push('## 响应字段\n');
      sections.push('| 字段名 | 类型 | 描述 |');
      sections.push('|--------|------|------|');
      pageData.responseFields.forEach(f => {
        sections.push(`| \`${f.name || '-'}\` | ${f.type || '-'} | ${f.description || '-'} |`);
      });
      sections.push('');
    }

    // 添加代码示例（去重）
    if (pageData.codeExamples && pageData.codeExamples.length > 0) {
      // 去重：使用 code 内容作为 key
      const seenCodes = new Set();
      const uniqueExamples = pageData.codeExamples.filter(example => {
        const key = example.code.trim();
        if (seenCodes.has(key)) return false;
        seenCodes.add(key);
        return true;
      });

      // 按语言分组
      const bashExamples = uniqueExamples.filter(e => e.language === 'bash' || e.language === 'text');
      const jsonExamples = uniqueExamples.filter(e => e.language === 'json');
      const pythonExamples = uniqueExamples.filter(e => e.language === 'python');
      const jsExamples = uniqueExamples.filter(e => e.language === 'javascript');
      const otherExamples = uniqueExamples.filter(e =>
        !['bash', 'text', 'json', 'python', 'javascript'].includes(e.language)
      );

      if (bashExamples.length > 0) {
        sections.push('## cURL 示例\n');
        bashExamples.forEach((example, index) => {
          if (bashExamples.length > 1) {
            sections.push(`### 示例 ${index + 1}\n`);
          }
          sections.push('```bash');
          sections.push(example.code);
          sections.push('```');
          sections.push('');
        });
      }

      if (pythonExamples.length > 0) {
        sections.push('## Python 示例\n');
        pythonExamples.forEach((example, index) => {
          if (pythonExamples.length > 1) {
            sections.push(`### 示例 ${index + 1}\n`);
          }
          sections.push('```python');
          sections.push(example.code);
          sections.push('```');
          sections.push('');
        });
      }

      if (jsExamples.length > 0) {
        sections.push('## JavaScript 示例\n');
        jsExamples.forEach((example, index) => {
          if (jsExamples.length > 1) {
            sections.push(`### 示例 ${index + 1}\n`);
          }
          sections.push('```javascript');
          sections.push(example.code);
          sections.push('```');
          sections.push('');
        });
      }

      if (jsonExamples.length > 0) {
        sections.push('## 响应示例\n');
        jsonExamples.forEach((example, index) => {
          if (jsonExamples.length > 1) {
            sections.push(`### 示例 ${index + 1}\n`);
          }
          sections.push('```json');
          try {
            const parsed = JSON.parse(example.code);
            sections.push(JSON.stringify(parsed, null, 2));
          } catch {
            sections.push(example.code);
          }
          sections.push('```');
          sections.push('');
        });
      }

      if (otherExamples.length > 0) {
        sections.push('## 其他示例\n');
        otherExamples.forEach((example) => {
          sections.push(`\`\`\`${example.language}`);
          sections.push(example.code);
          sections.push('```');
          sections.push('');
        });
      }
    }

    // 添加原始内容（清理后）- 仅在没有足够的结构化数据时添加
    if (pageData.rawContent) {
      // 检查是否已有足够的结构化数据
      const hasStructuredData = (pageData.requestParams && pageData.requestParams.length > 0) ||
                                 (pageData.responseFields && pageData.responseFields.length > 0) ||
                                 (pageData.codeExamples && pageData.codeExamples.length > 0) ||
                                 pageData.endpoint;
      if (!hasStructuredData) {
        const cleanedContent = this.cleanRawContent(pageData.rawContent);
        if (cleanedContent.length > 100) {
          sections.push('---\n');
          sections.push('## 详细文档\n');
          sections.push('```');
          sections.push(cleanedContent);
          sections.push('```');
          sections.push('');
        }
      }
    }

    return sections.join('\n');
  }

  /**
   * 清理原始内容，移除导航等无关信息
   * @param {string} content - 原始内容
   * @returns {string} 清理后的内容
   */
  cleanRawContent(content) {
    if (!content) return '';

    let cleaned = content;

    // 移除导航相关的文本
    const navPatterns = [
      /Financial Datasets home page[\s\S]*?Discord/i,
      /Search\.\.\.[\s\S]*?Discord/i,
      /Overview[\s\S]*?Stock Prices/i,
      /⌘K/gi,
      /Try it/gi,
      /Powered by[\s\S]*$/i,
      /This documentation is built[\s\S]*$/i,
      /^x$\s*github$/im,
      /^x$/im,
      /Copy\s*$/im,
      /^Copy$/im,
      /^200$\s*400\s*401\s*404$/im,
      /^200$\s*400\s*401\s*402\s*404$/im,
    ];

    for (const pattern of navPatterns) {
      cleaned = cleaned.replace(pattern, '');
    }

    // 移除多余的空行
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // 移除零宽空格
    cleaned = cleaned.replace(/\u200B/g, '');

    // 截断到合理长度
    if (cleaned.length > 8000) {
      cleaned = cleaned.substring(0, 8000) + '\n... (内容已截断)';
    }

    return cleaned.trim();
  }

  /**
   * 生成 QVeris API 文档 Markdown
   * @param {PageData} pageData - QVeris API 文档页面数据
   * @returns {string} Markdown文本
   */
  generateQverisApi(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 概述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 添加 API 信息
    if (pageData.apiInfo) {
      // Base URL
      if (pageData.apiInfo.baseUrl) {
        sections.push('## Base URL\n');
        sections.push('```text');
        sections.push(pageData.apiInfo.baseUrl);
        sections.push('```\n');
      }

      // 认证方式
      if (pageData.apiInfo.authMethod) {
        sections.push('## 认证方式\n');
        sections.push(`${pageData.apiInfo.authMethod}\n`);
        sections.push('');
      }

      // API 端点
      if (pageData.apiInfo.endpoints && pageData.apiInfo.endpoints.length > 0) {
        sections.push('## API 端点\n');
        pageData.apiInfo.endpoints.forEach(endpoint => {
          sections.push(`### ${endpoint.method} ${endpoint.path}\n`);
          if (endpoint.description) {
            sections.push(`${endpoint.description}\n`);
          }
          if (endpoint.params && endpoint.params.length > 0) {
            sections.push('\n**参数**:\n');
            endpoint.params.forEach(param => {
              sections.push(`- \`${param}\``);
            });
            sections.push('');
          }
          sections.push('');
        });
      }
    }

    // 添加端点列表
    if (pageData.endpoints && pageData.endpoints.length > 0) {
      sections.push('## 发现的端点\n');
      pageData.endpoints.forEach(endpoint => {
        sections.push(`- ${endpoint}`);
      });
      sections.push('');
    }

    // 添加代码示例
    if (pageData.codeExamples && pageData.codeExamples.length > 0) {
      sections.push('## 代码示例\n');

      // 去重
      const seenCodes = new Set();
      const uniqueExamples = pageData.codeExamples.filter(example => {
        // 支持新旧格式
        const code = typeof example === 'object' ? example.code : example;
        const key = code.trim().substring(0, 100);
        if (seenCodes.has(key)) return false;
        seenCodes.add(key);
        return true;
      });

      uniqueExamples.forEach((example, index) => {
        if (uniqueExamples.length > 1) {
          sections.push(`### 示例 ${index + 1}\n`);
        }

        // 支持新旧格式
        let lang = 'text';
        let code = example;
        if (typeof example === 'object') {
          lang = example.language || 'text';
          code = example.code;
        } else {
          // 检测语言
          if (example.includes('curl ')) lang = 'bash';
          else if (example.startsWith('{') || example.startsWith('[')) lang = 'json';
          else if (example.includes('import ') || example.includes('async def')) lang = 'python';
          else if (example.includes('const ') || example.includes('function ')) lang = 'javascript';
        }

        sections.push(`\`\`\`${lang}`);
        sections.push(code);
        sections.push('```');
        sections.push('');
      });
    }

    // 添加章节内容
    if (pageData.sections && pageData.sections.length > 0) {
      sections.push('## 文档章节\n');
      pageData.sections.forEach(section => {
        sections.push(`### ${section.title}\n`);
        if (section.content) {
          // 清理格式化残留
          const cleanedContent = section.content
            .replace(/Line NumbersThemeCopy/g, '')
            .replace(/JSONBashPythonTypeScript/g, '')
            .replace(/BashPythonTypeScript/g, '')
            .replace(/JSONLine NumbersThemeCopy/g, '')
            // 移除行首的 JSON、bash、Python 等语言标签
            .replace(/^JSON\s*/gm, '')
            .replace(/^bash\s*/gmi, '')
            .replace(/^Python\s*\d/gm, '')
            .replace(/\n{3,}/g, '\n\n');
          sections.push(cleanedContent);
          sections.push('');
        }
      });
    }

    // 如果没有其他内容，添加原始内容
    if (pageData.rawContent && sections.length <= 4) {
      sections.push('## 完整文档\n');
      // 清理内容
      let cleaned = pageData.rawContent
        .replace(/EN\s*Sign in\s*Docs\s*API\s*SDK[\s\S]*?Quick start/g, 'Quick start')
        .replace(/© 2025 QVeris[\s\S]*$/g, '')
        .replace(/\n{3,}/g, '\n\n');

      if (cleaned.length > 10000) {
        cleaned = cleaned.substring(0, 10000) + '\n... (内容已截断)';
      }
      sections.push(cleaned);
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 生成 Massive API 文档 Markdown
   * @param {PageData} pageData - Massive API 文档页面数据
   * @returns {string} Markdown文本
   */
  generateMassiveApi(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 描述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 添加 Endpoint
    if (pageData.endpoint) {
      sections.push('## Endpoint\n');
      sections.push('```');
      sections.push(`${pageData.requestMethod || 'GET'} ${pageData.endpoint}`);
      sections.push('```');
      sections.push('');
    }

    // 添加参数
    if (pageData.parameters && pageData.parameters.length > 0) {
      sections.push('## 参数\n');
      sections.push('| 参数名称 | 类型 | 必选 | 说明 |');
      sections.push('| -------- | ---- | ---- | ---- |');
      pageData.parameters.forEach(p => {
        const desc = this.escapeMarkdown(p.description || '');
        sections.push(`| ${p.name} | ${p.type || ''} | ${p.required ? '是' : '否'} | ${desc} |`);
      });
      sections.push('');
    }

    // 添加 Response Attributes
    if (pageData.responseAttributes && pageData.responseAttributes.length > 0) {
      sections.push('## Response Attributes\n');
      sections.push('| 参数名称 | 类型 | 必选 | 说明 |');
      sections.push('| -------- | ---- | ---- | ---- |');
      pageData.responseAttributes.forEach(p => {
        const desc = this.escapeMarkdown(p.description || '');
        sections.push(`| ${p.name} | ${p.type || ''} | ${p.required ? '是' : '否'} | ${desc} |`);
      });
      sections.push('');
    }

    // 添加代码示例
    if (pageData.codeExamples && pageData.codeExamples.length > 0) {
      sections.push('## 代码示例\n');
      pageData.codeExamples.forEach((example, index) => {
        if (example.type && example.type !== 'code') {
          sections.push(`### ${example.type.charAt(0).toUpperCase() + example.type.slice(1)}\n`);
        }
        sections.push(`\`\`\`${example.language || ''}`);
        sections.push(example.code);
        sections.push('```');
        sections.push('');
      });
    }

    // 如果有原始内容且没有结构化数据，添加原始内容（清理后）
    if (pageData.rawContent) {
      const hasStructuredData = (pageData.parameters && pageData.parameters.length > 0) ||
                                 (pageData.responseAttributes && pageData.responseAttributes.length > 0) ||
                                 (pageData.codeExamples && pageData.codeExamples.length > 0) ||
                                 pageData.endpoint;
      if (!hasStructuredData) {
        let cleanedContent = this.cleanMassiveRawContent(pageData.rawContent);
        // 从清理后的内容中移除描述部分（避免重复）
        if (pageData.description && cleanedContent.includes(pageData.description.substring(0, 50))) {
          const descIndex = cleanedContent.indexOf(pageData.description.substring(0, 50));
          if (descIndex !== -1) {
            // 找到描述结束的位置
            const descEndIndex = cleanedContent.indexOf('\n\n', descIndex);
            if (descEndIndex !== -1 && descEndIndex - descIndex < pageData.description.length + 100) {
              cleanedContent = cleanedContent.substring(descEndIndex).trim();
            }
          }
        }
        if (cleanedContent.length > 100) {
          sections.push('## 内容\n');
          sections.push(cleanedContent);
          sections.push('');
        }
      }
    }

    return sections.join('\n');
  }

  /**
   * 清理 Massive API 文档的原始内容
   * @param {string} content - 原始内容
   * @returns {string} 清理后的内容
   */
  cleanMassiveRawContent(content) {
    if (!content) return '';

    let cleaned = content;

    // 移除导航和侧边栏内容
    const removePatterns = [
      /^←\s*$/gm,
      /^Docs Home\s*$/gm,
      /^Quickstart\s*$/gm,
      /^Stocks\/?\s*$/gm,
      /^Options\/?\s*$/gm,
      /^Futures\/?\s*$/gm,
      /^Indices\/?\s*$/gm,
      /^Forex\/?\s*$/gm,
      /^Crypto\/?\s*$/gm,
      /^Economy\/?\s*$/gm,
      /^Partners\/?\s*$/gm,
      /^Overview\s*$/gm,
      /^.*Overview\s*$/gm,  // Remove any line ending with "Overview"
      /^Tickers\s*$/gm,
      /^Aggregate Bars \(OHLC\)\s*$/gm,
      /^Snapshots\s*$/gm,
      /^Trades & Quotes\s*$/gm,
      /^Technical Indicators\s*$/gm,
      /^Market Operations\s*$/gm,
      /^Corporate Actions\s*$/gm,
      /^Fundamentals\s*$/gm,
      /^Filings & Disclosures\s*$/gm,
      /^News\s*$/gm,
      /^WebSocket API Docs\s*$/gm,
      /^REST API Docs\s*$/gm,
      /^Flat Files Docs\s*$/gm,
      /^Docs\/\s*$/gm,
      /^REST API\/\s*$/gm,
      /^WebSocket\/\s*$/gm,
      /^Flat Files\/\s*$/gm,
      /^Day Aggregates\s*$/gm,
      /^Minute Aggregates\s*$/gm,
      /^Trades\s*$/gm,
      /^Quotes\s*$/gm,
      /^All Tickers\s*$/gm,
      /^Ticker Types\s*$/gm,
      /^Yes\s*$/gm,
      /^No\s*$/gm,
      /^Knowledge Base\s*$/gm,
      /^Contact Support\s*$/gm,
      /^Create account\s*$/gm,
      /^Log in\s*$/gm,
    ];

    for (const pattern of removePatterns) {
      cleaned = cleaned.replace(pattern, '');
    }

    // 移除 "Did you find this page helpful?" 及其后面的所有内容
    const helpIndex = cleaned.indexOf('Did you find this page helpful?');
    if (helpIndex !== -1) {
      cleaned = cleaned.substring(0, helpIndex);
    }

    // 移除 "Do you still need help with something?" 及其后面的所有内容
    const helpIndex2 = cleaned.indexOf('Do you still need help with something?');
    if (helpIndex2 !== -1) {
      cleaned = cleaned.substring(0, helpIndex2);
    }

    // 移除 "In this article" 及其后面的所有内容
    const articleIndex = cleaned.indexOf('In this article');
    if (articleIndex !== -1) {
      cleaned = cleaned.substring(0, articleIndex);
    }

    // 移除页面标题（已单独输出）
    const firstLineEnd = cleaned.indexOf('\n');
    if (firstLineEnd > 0) {
      const firstLine = cleaned.substring(0, firstLineEnd).trim();
      if (firstLine.length < 50 && !firstLine.includes('.')) {
        cleaned = cleaned.substring(firstLineEnd + 1);
      }
    }

    // 移除多余的空行
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // 移除行首行尾空白
    cleaned = cleaned.split('\n').map(line => line.trim()).join('\n');

    // 截断到合理长度
    if (cleaned.length > 5000) {
      cleaned = cleaned.substring(0, 5000) + '\n\n... (内容已截断)';
    }

    return cleaned.trim();
  }

  /**
   * 生成 SerpApi AI Overview 文档 Markdown
   * @param {PageData} pageData - SerpApi AI Overview 文档页面数据
   * @returns {string} Markdown文本
   */
  generateSerpApi(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 概述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 添加 API 端点
    if (pageData.endpoint) {
      sections.push('## API 端点\n');
      sections.push('```');
      sections.push(`${pageData.method || 'GET'} ${pageData.endpoint}?engine=${pageData.engine || 'google'}`);
      sections.push('```\n');
    }

    // 添加参数
    if (pageData.parameters && pageData.parameters.length > 0) {
      sections.push('## 请求参数\n');
      sections.push('| 参数名 | 类型 | 必选 | 说明 |');
      sections.push('| ------ | ---- | ---- | ---- |');
      pageData.parameters.forEach(p => {
        const desc = this.escapeMarkdown(p.description || '');
        sections.push(`| ${p.name} | ${p.type || 'string'} | ${p.required ? '是' : '否'} | ${desc} |`);
      });
      sections.push('');
    }

    // 添加响应结构
    if (pageData.responseStructure && pageData.responseStructure.length > 0) {
      sections.push('## 响应结构\n');
      sections.push('| 路径 | 类型 | 说明 |');
      sections.push('| ---- | ---- | ---- |');
      pageData.responseStructure.forEach(r => {
        const desc = this.escapeMarkdown(r.description || '');
        sections.push(`| ${r.path} | ${r.type || 'object'} | ${desc} |`);
      });
      sections.push('');
    }

    // 添加重要说明
    if (pageData.importantNotes && pageData.importantNotes.length > 0) {
      sections.push('## 重要说明\n');
      pageData.importantNotes.forEach(note => {
        sections.push(`> ${this.escapeMarkdown(note)}`);
        sections.push('');
      });
    }

    // 添加 API 示例
    if (pageData.examples && pageData.examples.length > 0) {
      sections.push('## API 示例\n');
      pageData.examples.forEach((example, index) => {
        sections.push(`### ${example.title || `示例 ${index + 1}`}\n`);

        if (example.description) {
          sections.push(example.description);
          sections.push('');
        }

        // 请求参数示例
        if (example.requestParams && Object.keys(example.requestParams).length > 0) {
          sections.push('**请求参数**:\n');
          sections.push('```json');
          sections.push(JSON.stringify(example.requestParams, null, 2));
          sections.push('```\n');
        }

        // 响应示例
        if (example.responseJson) {
          sections.push('**响应示例**:\n');
          sections.push('```json');
          // 尝试格式化 JSON
          try {
            const parsed = JSON.parse(example.responseJson);
            sections.push(JSON.stringify(parsed, null, 2));
          } catch (e) {
            sections.push(example.responseJson);
          }
          sections.push('```\n');
        }

        sections.push('---\n');
      });
    }

    // 如果有原始内容且没有其他数据，添加原始内容
    if (pageData.rawContent && sections.length <= 4) {
      sections.push('## 原始内容\n');
      sections.push(pageData.rawContent);
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 生成API文档Markdown
   * @param {PageData} pageData - API文档页面数据
   * @returns {string} Markdown文本
   */
  generateApiDoc(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL（始终添加，即使其他内容为空）
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加简要描述
    if (pageData.briefDesc) {
      sections.push('## 简要描述\n');
      sections.push(pageData.briefDesc);
      sections.push('');
    }

    // 添加请求URL
    if (pageData.requestUrl) {
      sections.push('## 请求URL\n');
      sections.push('```');
      sections.push(pageData.requestUrl);
      sections.push('```');
      sections.push('');
    }

    // 添加请求方式
    if (pageData.requestMethod) {
      sections.push('## 请求方式\n');
      sections.push(pageData.requestMethod);
      sections.push('');
    }

    // 添加参数
    if (pageData.params && pageData.params.length > 0) {
      sections.push('## 参数\n');
      sections.push('| 参数名称 | 必选 | 数据类型 | 说明 |');
      sections.push('| -------- | ---- | -------- | ---- |');
      pageData.params.forEach(p => {
        const desc = this.escapeMarkdown(p.desc);
        sections.push(`| ${p.name} | ${p.required} | ${p.type} | ${desc} |`);
      });
      sections.push('');
    }

    // 添加API试用示例
    if (pageData.apiExamples && pageData.apiExamples.length > 0) {
      sections.push('## API试用示例\n');
      pageData.apiExamples.forEach((example, index) => {
        if (pageData.apiExamples.length > 1) {
          sections.push(`### ${example.name}\n`);
        }
        sections.push('```json');
        // 尝试格式化 JSON
        try {
          const parsed = JSON.parse(example.code);
          sections.push(JSON.stringify(parsed, null, 2));
        } catch {
          sections.push(example.code);
        }
        sections.push('```');
        sections.push('');
      });
    }

    // 添加返回数据说明
    if (pageData.responseData && 
        (pageData.responseData.description || pageData.responseData.table.length > 0)) {
      sections.push('## 返回数据说明\n');
      
      // 添加返回数据表格
      if (pageData.responseData.table && pageData.responseData.table.length > 0) {
        const hasDesc = pageData.responseData.table.some(r => r.desc);
        if (hasDesc) {
          sections.push('| 参数名称 | 数据类型 | 说明 |');
          sections.push('| -------- | -------- | ---- |');
          pageData.responseData.table.forEach(r => {
            const desc = this.escapeMarkdown(r.desc || '');
            sections.push(`| ${r.name} | ${r.type} | ${desc} |`);
          });
        } else {
          sections.push('| 参数名称 | 数据类型 |');
          sections.push('| -------- | -------- |');
          pageData.responseData.table.forEach(r => {
            sections.push(`| ${r.name} | ${r.type} |`);
          });
        }
        sections.push('');
      }
      
      // 添加返回数据描述文本
      if (pageData.responseData.description) {
        if (pageData.responseData.table && pageData.responseData.table.length > 0) {
          sections.push('');
        }
        sections.push(pageData.responseData.description);
        sections.push('');
      }
    }

    return sections.join('\n');
  }

  /**
   * 检查内容是否为低价值内容（应过滤掉）
   * @param {string} content - 要检查的内容
   * @returns {boolean} 是否为低价值内容
   */
  isLowValueContent(content) {
    if (!content || typeof content !== 'string') return false;

    const text = content.toLowerCase().trim();

    // 跳过太短的内容
    if (text.length < 5) return true;

    // 热搜/热点/趋势相关（动态内容，无价值）
    const hotSearchPatterns = [
      /热搜[榜列表]?/,
      /热点[新闻资讯]?/,
      /trending/,
      /热门[推荐搜索]/,
      /\d+后\s*$/, // 数字后缀（如"0厚植..."这种热搜排名）
      /^[\s]*-?\d+/, // 特殊字符开头的数字（热搜排名格式）
    ];

    for (const pattern of hotSearchPatterns) {
      if (pattern.test(text)) return true;
    }

    // 备案/许可信息（法律文本，无价值）
    const filingPatterns = [
      /备案[信息号]/,
      /icp[证备]/,
      /京公网安备/,
      /网安备/,
      /网文[〔\(].*[\)〕]/,
      /许可证[编号]/,
      /营业执照/,
      /药品.*备案/,
      /医疗器械.*备案/,
      /宗教信息.*许可/,
      /视听节目.*许可/,
      /网络文化.*许可/,
    ];

    for (const pattern of filingPatterns) {
      if (pattern.test(text)) return true;
    }

    // 版权/公司信息（无价值）
    const copyrightPatterns = [
      /版权所有/,
      /copyright/,
      /©\s*\d+/,
      /all rights reserved/i,
      /^©?\s*\d{4}\s*baidu/i,
    ];

    for (const pattern of copyrightPatterns) {
      if (pattern.test(text)) return true;
    }

    // 检查是否是纯链接到搜索引擎搜索结果（如百度搜索链接）
    if (text.includes('baidu.com/s?wd=') ||
        text.includes('baidu.com/s?wd=')) {
      return true;
    }

    return false;
  }

  /**
   * 过滤低价值内容的列表项
   * @param {string} item - 列表项内容
   * @returns {boolean} 是否应该保留
   */
  shouldKeepListItem(item) {
    return !this.isLowValueContent(item);
  }

  /**
   * 生成通用页面Markdown
   * @param {PageData} pageData - 通用页面数据
   * @returns {string} Markdown文本
   */
  generateGeneric(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 描述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 如果有mainContent（混排内容），优先使用它
    if (pageData.mainContent && pageData.mainContent.length > 0) {
      sections.push('## 内容\n');
      
      pageData.mainContent.forEach(item => {
        switch (item.type) {
          case 'heading':
            sections.push(`${'#'.repeat(item.level + 1)} ${this.cleanGenericHeadingContent(item.content)}\n`);
            break;
            
          case 'paragraph':
            sections.push(item.content);
            sections.push('');
            break;
            
          case 'image':
            const imgAlt = item.alt || item.title || '图片';
            const imgSrc = item.localPath || item.src;
            sections.push(`![${imgAlt}](${imgSrc})`);
            if (item.title && item.title !== item.alt) {
              sections.push(`*${item.title}*`);
            }
            sections.push('');
            break;
            
          case 'list':
            // 过滤低价值内容（热搜、备案信息等）
            const filteredItems = item.items.filter(listItem => this.shouldKeepListItem(listItem));
            if (filteredItems.length === 0) break; // 如果过滤后没有内容，跳过

            filteredItems.forEach((listItem, i) => {
              if (item.listType === 'ol') {
                sections.push(`${i + 1}. ${listItem}`);
              } else {
                sections.push(`- ${listItem}`);
              }
            });
            sections.push('');
            break;
            
          case 'blockquote':
            sections.push(`> ${item.content}`);
            sections.push('');
            break;
            
          case 'codeblock':
            const lang = item.language || 'text';
            sections.push(`\`\`\`${lang}`);
            sections.push(item.content);
            sections.push('```');
            sections.push('');
            break;
            
          case 'hr':
            sections.push('---');
            sections.push('');
            break;
            
          case 'table':
            if (item.headers && item.headers.length > 0) {
              sections.push('| ' + item.headers.join(' | ') + ' |');
              sections.push('| ' + item.headers.map(() => '---').join(' | ') + ' |');
            }
            if (item.rows && item.rows.length > 0) {
              item.rows.forEach(row => {
                sections.push('| ' + row.join(' | ') + ' |');
              });
            }
            sections.push('');
            break;
        }
      });
      
      // 即使使用了mainContent，也要添加单独提取的图片和图表（如果它们不在mainContent中）
      if (pageData.images && pageData.images.length > 0) {
        sections.push('## 图片\n');
        pageData.images.forEach(img => {
          const alt = img.alt || img.title || '图片';
          const src = img.localPath || img.src;
          sections.push(`![${alt}](${src})`);
          if (img.title && img.title !== img.alt) {
            sections.push(`*${img.title}*`);
          }
          sections.push('');
        });
      }

      // 添加图表（Canvas/SVG截图）
      if (pageData.charts && pageData.charts.length > 0) {
        sections.push('## 图表\n');
        pageData.charts.forEach(chart => {
          const alt = `${chart.type.toUpperCase()}图表 ${chart.index}`;
          sections.push(`![${alt}](${chart.filename})`);
          sections.push(`*尺寸: ${chart.width}x${chart.height}px*`);
          sections.push('');
        });
      }
    } else {
      // 回退到旧的分段方式
      // 添加标题结构
      if (pageData.headings && pageData.headings.length > 0) {
        sections.push('## 页面结构\n');
        pageData.headings.forEach(h => {
          const indent = '  '.repeat(h.level - 1);
          sections.push(`${indent}- ${h.text}`);
        });
        sections.push('');
      }

      // 添加Tab页内容
      if (pageData.tabs && pageData.tabs.length > 0) {
        sections.push('## Tab页内容\n');
        pageData.tabs.forEach(tab => {
          sections.push(`### ${tab.name}\n`);
          sections.push(tab.content);
          sections.push('');
        });
      }

      // 添加段落
      if (pageData.paragraphs && pageData.paragraphs.length > 0) {
        sections.push('## 正文内容\n');
        pageData.paragraphs.forEach(p => {
          if (p.trim()) {
            sections.push(p);
            sections.push('');
          }
        });
      }

      // 添加引用块
      if (pageData.blockquotes && pageData.blockquotes.length > 0) {
        sections.push('## 引用\n');
        pageData.blockquotes.forEach(quote => {
          sections.push(`> ${quote}`);
          sections.push('');
        });
      }

      // 添加定义列表
      if (pageData.definitionLists && pageData.definitionLists.length > 0) {
        sections.push('## 术语定义\n');
        pageData.definitionLists.forEach((dlist, index) => {
          if (pageData.definitionLists.length > 1) {
            sections.push(`### 定义列表 ${index + 1}\n`);
          }
          dlist.forEach(item => {
            sections.push(`**${item.term}**`);
            sections.push(`: ${item.definition}`);
            sections.push('');
          });
        });
      }

      // 添加列表
      if (pageData.lists && pageData.lists.length > 0) {
        sections.push('## 列表\n');
        pageData.lists.forEach((list, index) => {
          if (pageData.lists.length > 1) {
            sections.push(`### 列表 ${index + 1}\n`);
          }
          list.items.forEach((item, i) => {
            if (list.type === 'ol') {
              sections.push(`${i + 1}. ${item}`);
            } else {
              sections.push(`- ${item}`);
            }
          });
          sections.push('');
        });
      }

      // 添加表格
      if (pageData.tables && pageData.tables.length > 0) {
        sections.push('## 表格\n');
        pageData.tables.forEach((table, index) => {
          if (pageData.tables.length > 1) {
            sections.push(`### 表格 ${index + 1}\n`);
          }
          if (table.caption) {
            sections.push(`**${table.caption}**\n`);
          }
          const markdown = this.tableToMarkdown(table);
          if (markdown) {
            sections.push(markdown);
            sections.push('');
          }
        });
      }

      // 添加代码块
      if (pageData.codeBlocks && pageData.codeBlocks.length > 0) {
        sections.push('## 代码示例\n');
        pageData.codeBlocks.forEach((block, index) => {
          if (pageData.codeBlocks.length > 1) {
            sections.push(`### 代码 ${index + 1}\n`);
          }
          sections.push(this.codeBlockToMarkdown(block));
          sections.push('');
        });
      }

      // 添加图片
      if (pageData.images && pageData.images.length > 0) {
        sections.push('## 图片\n');
        pageData.images.forEach(img => {
          const alt = img.alt || img.title || '图片';
          // 使用本地路径（如果有）或原始URL
          const src = img.localPath || img.src;
          sections.push(`![${alt}](${src})`);
          if (img.title && img.title !== img.alt) {
            sections.push(`*${img.title}*`);
          }
          sections.push('');
        });
      }

      // 添加视频
      if (pageData.videos && pageData.videos.length > 0) {
        sections.push('## 视频\n');
        pageData.videos.forEach((video, index) => {
          sections.push(`### 视频 ${index + 1}\n`);
          sections.push(`视频链接: ${video.src}`);
          if (video.poster) {
            sections.push(`![视频封面](${video.poster})`);
          }
          sections.push('');
        });
      }

      // 添加音频
      if (pageData.audios && pageData.audios.length > 0) {
        sections.push('## 音频\n');
        pageData.audios.forEach((audio, index) => {
          sections.push(`### 音频 ${index + 1}\n`);
          sections.push(`音频链接: ${audio.src}`);
          sections.push('');
        });
      }

      // 添加图表（Canvas/SVG截图）
      if (pageData.charts && pageData.charts.length > 0) {
        sections.push('## 图表\n');
        pageData.charts.forEach(chart => {
          const alt = `${chart.type.toUpperCase()}图表 ${chart.index}`;
          sections.push(`![${alt}](${chart.filename})`);
          sections.push(`*尺寸: ${chart.width}x${chart.height}px*`);
          sections.push('');
        });
      }

      // 添加Tab页和下拉框内容
      if (pageData.tabsAndDropdowns && pageData.tabsAndDropdowns.length > 0) {
        pageData.tabsAndDropdowns.forEach(item => {
          if (item.type === 'tab') {
            sections.push(`\n## Tab页: ${item.name}\n`);
            
            if (item.paragraphs && item.paragraphs.length > 0) {
              item.paragraphs.forEach(p => {
                if (p.trim()) {
                  sections.push(p);
                  sections.push('');
                }
              });
            }
            
            if (item.tables && item.tables.length > 0) {
              item.tables.forEach(table => {
                const markdown = this.tableToMarkdown(table);
                if (markdown) {
                  sections.push(markdown);
                  sections.push('');
                }
              });
            }
          } else if (item.type === 'dropdown') {
            sections.push(`\n## 下拉框: ${item.label}\n`);
            
            item.options.forEach(option => {
              sections.push(`### 选项: ${option.text}\n`);
              
              if (option.paragraphs && option.paragraphs.length > 0) {
                option.paragraphs.forEach(p => {
                  if (p.trim()) {
                    sections.push(p);
                    sections.push('');
                  }
                });
              }
              
              if (option.tables && option.tables.length > 0) {
                option.tables.forEach(table => {
                  const markdown = this.tableToMarkdown(table);
                  if (markdown) {
                    sections.push(markdown);
                    sections.push('');
                  }
                });
              }
            });
          }
        });
      }
    }

    return sections.join('\n');
  }

  /**
   * 生成 RSSHub 路由文档 Markdown
   * @param {PageData} pageData - RSSHub 路由文档页面数据
   * @returns {string} Markdown文本
   */
  generateRsshubRoute(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加路由路径
    if (pageData.routePath) {
      sections.push('## 路由路径\n');
      sections.push(`\`${pageData.routePath}\`\n`);
    }

    // 添加路由信息
    if (pageData.routeInfo && Object.keys(pageData.routeInfo).some(k => pageData.routeInfo[k])) {
      sections.push('## 路由信息\n');
      if (pageData.routeInfo.path) {
        sections.push(`**路由**: \`${pageData.routeInfo.path}\`\n`);
      }
      if (pageData.routeInfo.author) {
        sections.push(`**作者**: ${pageData.routeInfo.author}\n`);
      }
      if (pageData.routeInfo.example) {
        sections.push(`**示例**: ${pageData.routeInfo.example}\n`);
      }
      if (pageData.routeInfo.sourceCode) {
        sections.push(`**源代码**: ${pageData.routeInfo.sourceCode}\n`);
      }
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 描述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 添加参数表格
    if (pageData.parameters && pageData.parameters.length > 0) {
      sections.push('## 参数\n');
      sections.push('| 参数名 | 必需 | 默认值 | 描述 |');
      sections.push('|--------|------|--------|------|');
      pageData.parameters.forEach(param => {
        const name = this.escapeMarkdown(param.name || '-');
        const required = param.required ? '✓' : '';
        const defaultVal = this.escapeMarkdown(param.default || '-');
        let desc = this.escapeMarkdown(param.description || '-');
        if (param.options) {
          desc += `\n选项: ${this.escapeMarkdown(param.options)}`;
        }
        sections.push(`| \`${name}\` | ${required} | ${defaultVal} | ${desc} |`);
      });
      sections.push('');
    }

    // 添加路由表格
    if (pageData.routes && pageData.routes.length > 0) {
      pageData.routes.forEach((routeTable, index) => {
        if (pageData.routes.length > 1) {
          sections.push(`## 路由表格 ${index + 1}\n`);
        } else {
          sections.push('## 路由\n');
        }

        // 使用 tableToMarkdown 方法
        const markdown = this.tableToMarkdown(routeTable);
        if (markdown) {
          sections.push(markdown);
          sections.push('');
        }
      });
    }

    // 添加代码块
    if (pageData.codeBlocks && pageData.codeBlocks.length > 0) {
      sections.push('## 代码示例\n');
      pageData.codeBlocks.forEach((block, index) => {
        if (pageData.codeBlocks.length > 1) {
          sections.push(`### 代码 ${index + 1}\n`);
        }
        sections.push(this.codeBlockToMarkdown(block));
        sections.push('');
      });
    }

    // 只添加有意义的列表（排除参数相关的内容）
    if (pageData.lists && pageData.lists.length > 0) {
      const meaningfulLists = pageData.lists.filter(list => {
        // 检查列表项是否看起来像参数定义
        const isParamList = list.items.some(item => {
          const trimmedItem = item.trim();

          // Check for standalone keywords at the start
          if (/^(Required|Optional|Description|Default|Options)\b/i.test(trimmedItem)) {
            return true;
          }

          // Check for combined patterns like:
          // - "idOptionalDescription" or "idRequiredDescription"
          // - "channelRequiredDescription"
          // - "categoryOptional"
          // - "id{.}OptionalDescription" (with special chars)
          // Pattern: word chars + (Required|Optional) + optional (Description|Default|Options)
          if (/^[a-zA-Z_{}().\[\]-]+(Required|Optional)(Description|Default|Options)?/i.test(trimmedItem)) {
            return true;
          }

          // Check for "paramNameRequired" pattern
          if (/[a-zA-Z_]+Required/i.test(trimmedItem) || /[a-zA-Z_]+Optional/i.test(trimmedItem)) {
            // Additional check: if it contains Description word, it's definitely a param
            if (/Description/i.test(trimmedItem) || /Default/i.test(trimmedItem) || /Options/i.test(trimmedItem)) {
              return true;
            }
          }

          return false;
        });
        return !isParamList;
      });

      if (meaningfulLists.length > 0) {
        sections.push('## 列表\n');
        meaningfulLists.forEach((list, index) => {
          if (meaningfulLists.length > 1) {
            sections.push(`### 列表 ${index + 1}\n`);
          }
          list.items.forEach((item, i) => {
            const cleanedItem = this.sanitizeRsshubText(item);
            if (!cleanedItem) {
              return;
            }
            if (list.type === 'ol') {
              sections.push(`${i + 1}. ${cleanedItem}`);
            } else {
              sections.push(`- ${cleanedItem}`);
            }
          });
          sections.push('');
        });
      }
    }

    // 添加原始内容（作为后备，当没有结构化数据时）
    if (pageData.rawContent && !pageData.routes?.length && !pageData.parameters?.length) {
      sections.push('## 详细内容\n');
      // 清理和格式化原始内容
      let cleaned = pageData.rawContent
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      cleaned = this.sanitizeRsshubText(cleaned);
      if (cleaned) {
        sections.push(cleaned);
      }
      sections.push('');
    }

    return sections.join('\n');
  }

  sanitizeRsshubText(text = '') {
    return text
      .split('\n')
      .map(line => line.trimEnd())
      .filter(line => !/^:::(\s+\w+)?\s*$/.test(line.trim()))
      .join('\n')
      .trim();
  }

  /**
   * 将表格转换为Markdown表格
   * @param {Table} table - 表格数据
   * @returns {string} Markdown表格
   */
  tableToMarkdown(table) {
    if (!table.headers || table.headers.length === 0) {
      // 如果没有表头，只输出数据行
      if (!table.rows || table.rows.length === 0) {
        return '';
      }
      return table.rows.map(row => 
        '| ' + row.map(cell => this.escapeMarkdown(cell)).join(' | ') + ' |'
      ).join('\n');
    }

    const lines = [];

    // 表头行
    const headerRow = '| ' + table.headers.map(h => this.escapeMarkdown(h)).join(' | ') + ' |';
    lines.push(headerRow);

    // 分隔行
    const separator = '| ' + table.headers.map(() => '---').join(' | ') + ' |';
    lines.push(separator);

    // 数据行
    if (table.rows && table.rows.length > 0) {
      table.rows.forEach(row => {
        // 处理两种格式：数组格式和对象格式
        let cells;
        if (Array.isArray(row)) {
          cells = row.map(cell => this.escapeMarkdown(cell));
        } else if (typeof row === 'object') {
          // 对象格式：根据 headers 提取值
          cells = table.headers.map(h => this.escapeMarkdown(row[h] || ''));
        } else {
          cells = [this.escapeMarkdown(String(row))];
        }

        // 确保行的列数与表头一致
        while (cells.length < table.headers.length) {
          cells.push('');
        }
        const dataRow = '| ' + cells.slice(0, table.headers.length).join(' | ') + ' |';
        lines.push(dataRow);
      });
    }

    return lines.join('\n');
  }

  /**
   * 将代码块转换为Markdown代码块
   * @param {CodeBlock} codeBlock - 代码块数据
   * @returns {string} Markdown代码块
   */
  codeBlockToMarkdown(codeBlock) {
    const language = codeBlock.language || 'text';
    return `\`\`\`${language}\n${codeBlock.code}\n\`\`\``;
  }

  /**
   * 转义Markdown特殊字符
   * @param {string} text - 原始文本
   * @returns {string} 转义后的文本
   */
  escapeMarkdown(text) {
    if (typeof text !== 'string') {
      return String(text);
    }
    // 转义表格中的管道符和换行符
    return text
      .replace(/\|/g, '\\|')
      .replace(/\n/g, '<br>');
  }

  /**
   * 清理通用解析器里的标题内容，移除空锚文本链接和不可见字符
   * @param {string} text
   * @returns {string}
   */
  cleanGenericHeadingContent(text) {
    if (typeof text !== 'string') {
      return '';
    }

    return text
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/^\s*\[\]\([^)]*\)\s*/g, '')
      .trim();
  }

  /**
   * 清理标题（移除特殊字符和冗余信息）
   * @param {string} title - 原始标题
   * @returns {string} 清理后的标题
   */
  cleanTitle(title) {
    if (!title || typeof title !== 'string') {
      return '';
    }

    return title
      .replace(/\|/g, '_')              // 管道符转下划线
      .replace(/\s+/g, '_')             // 空格转下划线
      .replace(/_-_理杏仁$/i, '')       // 移除网站名后缀
      .replace(/_-_[^_]+$/i, '')        // 移除其他网站名后缀
      .replace(/[\/\\?*:|"<>]/g, '_')   // 替换文件系统不允许的字符
      .replace(/_{2,}/g, '_')           // 合并多个下划线
      .replace(/^_|_$/g, '');           // 移除首尾下划线
  }

  /**
   * 从URL中提取关键部分
   * @param {string} url - URL字符串
   * @returns {string[]} 关键部分数组
   */
  extractKeyParts(url) {
    const parts = [];
    
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const searchParams = urlObj.searchParams;
      
      // 1. 提取市场代码 (cn/hk/us/a/b/h)
      const marketCodes = ['cn', 'hk', 'us', 'a', 'b', 'h'];
      marketCodes.forEach(code => {
        const pattern = new RegExp(`\\/${code}\\/|\\/${code}$|=${code}(?:&|$)|\\/${code}\\/`);
        if (pattern.test(pathname) || pattern.test(searchParams.toString())) {
          if (!parts.includes(code)) {
            parts.push(code);
          }
        }
      });
      
      // 2. 提取数据类型/周期
      const dataTypes = {
        'weekly': 'weekly',
        'monthly': 'monthly',
        'quarterly': 'quarterly',
        'annually': 'annually',
        'daily': 'daily',
        'custom': 'custom',
        'realtime': 'realtime'
      };
      
      Object.entries(dataTypes).forEach(([key, value]) => {
        if (pathname.includes(key) || searchParams.toString().includes(key)) {
          if (!parts.includes(value)) {
            parts.push(value);
          }
        }
      });
      
      // 3. 提取 API Key 的关键部分
      const apiKey = searchParams.get('api-key');
      if (apiKey && apiKey !== 'undefined') {
        // 取最后两段作为关键部分
        const apiParts = apiKey.split('/').filter(p => p && p !== 'undefined');
        
        // 如果第一段是市场代码，单独提取
        if (apiParts.length > 0 && marketCodes.includes(apiParts[0])) {
          if (!parts.includes(apiParts[0])) {
            parts.push(apiParts[0]);
          }
        }
        
        // 提取最后两段（排除市场代码）
        const nonMarketParts = apiParts.filter(p => !marketCodes.includes(p));
        if (nonMarketParts.length > 0) {
          const keyParts = nonMarketParts.slice(-2).join('_');
          if (keyParts && !parts.includes(keyParts)) {
            parts.push(keyParts);
          }
        }
      }
      
      // 4. 提取查询参数中的关键字
      const importantParams = [
        'chart-granularity',
        'date-range',
        'period',
        'type',
        'category',
        'granularity'
      ];
      
      importantParams.forEach(param => {
        const value = searchParams.get(param);
        if (value && value !== 'undefined') {
          // 简化参数值（只取前10个字符，移除特殊字符）
          const shortValue = value.substring(0, 10).replace(/[^a-zA-Z0-9]/g, '');
          if (shortValue && !parts.includes(shortValue)) {
            parts.push(shortValue);
          }
        }
      });
      
      // 5. 提取路径中的关键段
      const pathSegments = pathname.split('/').filter(s => s);
      const keywordSegments = [
        'index', 'constituents', 'fundamental', 'financial',
        'non-financial', 'industry', 'company', 'macro',
        'analytics', 'chart-maker', 'shareholders', 'treasury',
        'money-supply', 'cpi', 'ppi', 'gdp', 'bs', 'pl', 'cf'
      ];
      
      pathSegments.forEach(segment => {
        if (keywordSegments.includes(segment) && !parts.includes(segment)) {
          parts.push(segment);
        }
      });
      
    } catch (error) {
      // URL解析失败，返回空数组
    }
    
    return parts;
  }

  /**
   * 生成 Brave Search API 文档 Markdown
   * @param {PageData} pageData - Brave Search API 文档页面数据
   * @returns {string} Markdown文本
   */
  generateBraveSearchApi(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 概述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 添加 API 端点信息
    if (pageData.endpoint) {
      sections.push('## API 端点\n');
      sections.push(`\`${pageData.method || 'GET'} ${pageData.endpoint}\``);
      sections.push('');
    }

    // 添加各个章节内容
    if (pageData.sections && pageData.sections.length > 0) {
      pageData.sections.forEach(section => {
        const level = section.level === 'H3' ? '###' : '##';
        sections.push(`${level} ${section.title}\n`);

        // 添加段落内容
        if (section.content && section.content.length > 0) {
          section.content.forEach(para => {
            sections.push(para);
            sections.push('');
          });
        }

        // 添加代码块
        if (section.codeBlocks && section.codeBlocks.length > 0) {
          section.codeBlocks.forEach(code => {
            const lang = code.includes('curl') ? 'bash' : (code.startsWith('{') ? 'json' : 'text');
            sections.push(`\`\`\`${lang}`);
            sections.push(code);
            sections.push('```\n');
          });
        }
      });
    }

    // 添加表格
    if (pageData.tables && pageData.tables.length > 0) {
      pageData.tables.forEach((table, idx) => {
        // 检查表格是否有标题
        const hasTitle = pageData.sections?.some(s => s.title.toLowerCase().includes('parameter') || s.title.toLowerCase().includes('参数'));
        if (!hasTitle || idx > 0) {
          sections.push(`## 表格 ${idx + 1}\n`);
        } else {
          sections.push('## 参数\n');
        }

        if (table.headers && table.headers.length > 0) {
          sections.push('| ' + table.headers.join(' | ') + ' |');
          sections.push('| ' + table.headers.map(() => '---').join(' | ') + ' |');

          if (table.rows && table.rows.length > 0) {
            table.rows.forEach(row => {
              sections.push('| ' + row.map(cell => cell.replace(/\n/g, ' ').replace(/\|/g, '\\|')).join(' | ') + ' |');
            });
          }
          sections.push('');
        }
      });
    }

    // 添加代码示例
    if (pageData.examples && pageData.examples.length > 0) {
      const requestExamples = pageData.examples.filter(e => e.type === 'request');
      const responseExamples = pageData.examples.filter(e => e.type === 'response');

      if (requestExamples.length > 0) {
        sections.push('## 请求示例\n');
        requestExamples.forEach((example, idx) => {
          if (requestExamples.length > 1) {
            sections.push(`### 示例 ${idx + 1}\n`);
          }
          sections.push(`\`\`\`${example.language}`);
          sections.push(example.code);
          sections.push('```\n');
        });
      }

      if (responseExamples.length > 0) {
        sections.push('## 响应示例\n');
        responseExamples.forEach((example, idx) => {
          if (responseExamples.length > 1) {
            sections.push(`### 响应 ${idx + 1}\n`);
          }
          sections.push(`\`\`\`${example.language}`);
          sections.push(example.code);
          sections.push('```\n');
        });
      }
    }

    // 如果没有提取到足够的章节内容，使用原始内容
    // 只有标题、URL、端点等基础内容时，需要补充 rawContent
    const hasRealContent = pageData.sections?.length > 0 ||
                           pageData.tables?.length > 0 ||
                           pageData.examples?.length > 0;
    if (!hasRealContent && pageData.rawContent && pageData.rawContent.length > 100) {
      sections.push('## 页面内容\n');
      sections.push(pageData.rawContent);
    }

    return sections.join('\n');
  }

  /**
   * 生成 ApiTracker 页面 Markdown
   * @param {PageData} pageData
   * @returns {string}
   */
  generateApiTracker(pageData) {
    const sections = [];

    if (pageData.title) {
      sections.push(`# ${pageData.title}`);
      sections.push('');
    }

    if (pageData.url) {
      sections.push('## 源URL');
      sections.push('');
      sections.push(pageData.url);
      sections.push('');
    }

    if (pageData.type === 'apitracker-category') {
      if (pageData.category) {
        sections.push(`**分类**: \`${pageData.category}\``);
        sections.push('');
      }
      const entries = Array.isArray(pageData.entries) ? pageData.entries : [];
      sections.push(`**入口数量**: ${entries.length}`);
      sections.push('');
      if (entries.length > 0) {
        sections.push('## 入口列表');
        sections.push('');
        entries.forEach((entry, index) => {
          const name = this.escapeMarkdown(entry.name || entry.slug || `entry-${index + 1}`);
          sections.push(`${index + 1}. [${name}](${entry.url})`);
        });
        sections.push('');
      }
    }

    if (pageData.type === 'apitracker-api-detail') {
      if (pageData.companyName) sections.push(`**公司**: ${this.escapeMarkdown(pageData.companyName)}`);
      if (pageData.slug) sections.push(`**Slug**: \`${pageData.slug}\``);
      if (pageData.apiBaseEndpoint) sections.push(`**API Base Endpoint**: \`${pageData.apiBaseEndpoint}\``);
      if (pageData.graphqlEndpoint) sections.push(`**GraphQL Endpoint**: \`${pageData.graphqlEndpoint}\``);
      sections.push('');

      const docs = Array.isArray(pageData.docsEntrances) ? pageData.docsEntrances : [];
      if (docs.length > 0) {
        sections.push('## 文档入口');
        sections.push('');
        docs.forEach((doc, i) => sections.push(`${i + 1}. ${doc}`));
        sections.push('');
      }

      const specs = Array.isArray(pageData.apiSpecs) ? pageData.apiSpecs : [];
      if (specs.length > 0) {
        sections.push('## API 规格链接');
        sections.push('');
        specs.forEach((spec) => {
          const left = [spec.type, spec.format].filter(Boolean).join(' / ') || 'spec';
          sections.push(`- ${this.escapeMarkdown(left)}: ${spec.url}`);
        });
        sections.push('');
      }

      const postman = Array.isArray(pageData.postmanCollections) ? pageData.postmanCollections : [];
      if (postman.length > 0) {
        sections.push('## Postman 集合');
        sections.push('');
        postman.forEach((item) => {
          const label = this.escapeMarkdown(item.name || 'collection');
          sections.push(`- ${label}: ${item.url}`);
        });
        sections.push('');
      }

      if (pageData.urlRules) {
        sections.push('## URL 规则建议');
        sections.push('');
        if (Array.isArray(pageData.urlRules.include) && pageData.urlRules.include.length > 0) {
          sections.push('### include');
          pageData.urlRules.include.forEach((rule) => sections.push(`- \`${rule}\``));
          sections.push('');
        }
        if (Array.isArray(pageData.urlRules.exclude) && pageData.urlRules.exclude.length > 0) {
          sections.push('### exclude');
          pageData.urlRules.exclude.forEach((rule) => sections.push(`- \`${rule}\``));
          sections.push('');
        }
      }
    }

    if (sections.length === 0 && pageData.rawContent) {
      sections.push(pageData.rawContent);
    }

    return sections.join('\n');
  }

  /**
   * 生成安全的文件名
   * @param {string} title - 原始标题
   * @param {string} url - 页面URL（可选，用于生成更好的文件名）
   * @returns {string} 安全的文件名
   */
  safeFilename(title, url = null) {
    // 特殊处理 eulerpool API URL：直接从 URL 路径生成文件名
    if (url && /^https?:\/\/eulerpool\.com\/developers\/api\//.test(url)) {
      try {
        const urlObj = new URL(url);
        let pathname = urlObj.pathname;
        // 移除 /developers/api/ 前缀
        pathname = pathname.replace(/^\/developers\/api\//, '');
        // 移除尾部斜杠
        pathname = pathname.replace(/\/$/, '');
        // 将 / 替换为 _
        const filename = pathname.replace(/\//g, '_');
        if (filename) {
          return this.cleanTitle(filename);
        }
      } catch (e) {
        // 忽略错误，继续使用默认逻辑
      }
    }

    // 特殊处理 finnhub API URL：直接从 URL 路径生成文件名
    if (url && /^https?:\/\/finnhub\.io\/docs\/api/.test(url)) {
      try {
        const urlObj = new URL(url);
        let pathname = urlObj.pathname;
        // 移除 /docs/api 前缀
        pathname = pathname.replace(/^\/docs\/api\/?/, '');
        // 移除尾部斜杠
        pathname = pathname.replace(/\/$/, '');
        // 将 / 替换为 _
        const filename = pathname.replace(/\//g, '_');
        if (filename) {
          return this.cleanTitle(filename);
        }
      } catch (e) {
        // 忽略错误，继续使用默认逻辑
      }
    }

    if (!title || typeof title !== 'string') {
      return 'untitled';
    }

    // 1. 清理标题
    let cleanedTitle = this.cleanTitle(title);
    
    // 2. 如果提供了URL，提取关键部分
    let urlParts = [];
    if (url) {
      urlParts = this.extractKeyParts(url);
    }
    
    // 3. 组合文件名
    let filename = cleanedTitle;
    
    if (urlParts.length > 0) {
      // 限制URL部分最多3个关键字
      const limitedParts = urlParts.slice(0, 3);
      filename += '_' + limitedParts.join('_');
    }
    
    // 4. 限制总长度
    if (filename.length > 60) {
      // 优先保留标题，截断URL部分
      const titlePart = cleanedTitle.substring(0, 40);
      const urlPart = urlParts.slice(0, 2).join('_').substring(0, 18);
      filename = titlePart + (urlPart ? '_' + urlPart : '');
    }
    
    // 5. 最终清理
    filename = filename
      .replace(/_{2,}/g, '_')
      .replace(/^_|_$/g, '');
    
    // 6. 如果文件名为空，使用默认值
    if (!filename) {
      filename = 'untitled';
    }
    
    // 7. 限制最终长度（保险起见）
    if (filename.length > 200) {
      filename = filename.substring(0, 200);
    }

    return filename;
  }

  /**
   * 生成 Tavily API 文档 Markdown
   * @param {PageData} pageData - Tavily API 文档页面数据
   * @returns {string} Markdown文本
   */
  generateTavilyApi(pageData) {
    // 如果已经有 markdown 内容，直接返回
    if (pageData.markdown) {
      return pageData.markdown;
    }

    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 概述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 添加 API 端点信息
    if (pageData.method || pageData.endpoint) {
      sections.push('## API 端点\n');
      if (pageData.method && pageData.endpoint) {
        sections.push(`**方法**: \`${pageData.method}\``);
        sections.push(`**端点**: \`${pageData.baseUrl || 'https://api.tavily.com'}${pageData.endpoint}\``);
      } else if (pageData.endpoint) {
        sections.push(`**端点**: \`${pageData.baseUrl || 'https://api.tavily.com'}${pageData.endpoint}\``);
      }
      sections.push('');
    }

    // 添加参数表格
    if (pageData.parameters && pageData.parameters.length > 0) {
      sections.push('## 参数\n');
      sections.push('| 参数名 | 类型 | 必需 | 默认值 | 描述 |');
      sections.push('|--------|------|------|--------|------|');
      pageData.parameters.forEach(param => {
        const required = param.required ? '是' : '否';
        const defaultVal = param.default || '-';
        const name = param.name || '-';
        const type = param.type || '-';
        const desc = param.description || '-';
        sections.push(`| \`${name}\` | ${type} | ${required} | ${defaultVal} | ${desc} |`);
      });
      sections.push('');
    }

    // 从 mainContent 生成结构化内容
    if (pageData.mainContent && pageData.mainContent.length > 0) {
      sections.push('## 详细内容\n');

      pageData.mainContent.forEach(item => {
        switch (item.type) {
          case 'heading':
            const headingLevel = '#'.repeat(Math.min(item.level + 1, 6));
            sections.push(`${headingLevel} ${item.content}\n`);
            break;

          case 'paragraph':
            sections.push(item.content);
            sections.push('');
            break;

          case 'codeblock':
            sections.push(`\`\`\`${item.language || 'text'}`);
            sections.push(item.content);
            sections.push('```\n');
            break;

          case 'list':
            item.items.forEach(listItem => {
              const prefix = item.listType === 'ol' ? '1. ' : '- ';
              sections.push(`${prefix}${listItem}`);
            });
            sections.push('');
            break;

          case 'table':
            if (item.headers && item.headers.length > 0) {
              sections.push(`| ${item.headers.join(' | ')} |`);
              sections.push(`| ${item.headers.map(() => '------').join(' | ')} |`);
              if (item.rows) {
                item.rows.forEach(row => {
                  sections.push(`| ${row.join(' | ')} |`);
                });
              }
              sections.push('');
            }
            break;

          case 'blockquote':
            sections.push(`> ${item.content}`);
            sections.push('');
            break;

          case 'parameter':
            if (item.name) {
              let paramLine = `- **\`${item.name}\`**`;
              if (item.paramType) {
                paramLine += ` (${item.paramType})`;
              }
              sections.push(paramLine);
              if (item.description) {
                sections.push(`  ${item.description}`);
              }
              sections.push('');
            }
            break;
        }
      });
    }

    // 添加代码示例（如果 mainContent 为空）
    if ((!pageData.mainContent || pageData.mainContent.length === 0) &&
        pageData.examples && pageData.examples.length > 0) {
      sections.push('## 代码示例\n');
      pageData.examples.forEach((example, index) => {
        if (pageData.examples.length > 1) {
          sections.push(`### 示例 ${index + 1}\n`);
        }
        const lang = example.language || 'text';
        sections.push(`\`\`\`${lang}`);
        sections.push(example.code);
        sections.push('```\n');
      });
    }

    return sections.join('\n');
  }

  /**
   * 生成 Tushare Pro API 文档 Markdown
   * @param {PageData} pageData - Tushare Pro API 文档页面数据
   * @returns {string} Markdown文本
   */
  generateTushareProApi(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加 API 名称
    if (pageData.apiName) {
      sections.push('## 接口名称\n');
      sections.push(`\`${pageData.apiName}\``);
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 接口描述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 添加限量说明
    if (pageData.limit) {
      sections.push('## 限量\n');
      sections.push(pageData.limit);
      sections.push('');
    }

    // 添加权限说明
    if (pageData.permission) {
      sections.push('## 权限\n');
      sections.push(pageData.permission);
      sections.push('');
    }

    // 添加积分要求
    if (pageData.pointsRequired) {
      sections.push('## 积分要求\n');
      sections.push(`用户需要至少 **${pageData.pointsRequired}** 积分可以调取`);
      sections.push('');
    }

    // 添加分类路径
    if (pageData.category) {
      sections.push('## 所属分类\n');
      sections.push(pageData.category);
      sections.push('');
    }

    // 添加段落内容（用于分类页面）
    if (pageData.paragraphs && pageData.paragraphs.length > 0) {
      sections.push('## 简介\n');
      pageData.paragraphs.forEach(p => {
        sections.push(p);
        sections.push('');
      });
    }

    // 添加列表内容（用于分类页面）
    if (pageData.lists && pageData.lists.length > 0) {
      pageData.lists.forEach((list, index) => {
        if (list.items && list.items.length > 0) {
          // 检查是否是有链接的列表
          const hasLinks = list.items.some(item => item.link);
          if (hasLinks) {
            sections.push(`## 相关接口\n`);
          } else {
            sections.push(`## 列表\n`);
          }
          list.items.forEach(item => {
            if (item.link) {
              sections.push(`- [${item.text}](${item.link})`);
            } else {
              sections.push(`- ${item.text}`);
            }
          });
          sections.push('');
        }
      });
    }

    // 添加输入参数
    if (pageData.inputParams && pageData.inputParams.length > 0) {
      sections.push('## 输入参数\n');
      sections.push('| 名称 | 类型 | 必选 | 描述 |');
      sections.push('| --- | --- | --- | --- |');
      pageData.inputParams.forEach(param => {
        const name = param['名称'] || param.name || '';
        const type = param['类型'] || param.type || '';
        const required = param['必选'] || param.required || '';
        const desc = param['描述'] || param.description || '';
        sections.push(`| ${name} | ${type} | ${required} | ${desc} |`);
      });
      sections.push('');
    }

    // 添加输出参数
    if (pageData.outputParams && pageData.outputParams.length > 0) {
      sections.push('## 输出参数\n');
      sections.push('| 名称 | 类型 | 默认显示 | 描述 |');
      sections.push('| --- | --- | --- | --- |');
      pageData.outputParams.forEach(param => {
        const name = param['名称'] || param.name || '';
        const type = param['类型'] || param.type || '';
        const display = param['默认显示'] || param.display || '';
        const desc = param['描述'] || param.description || '';
        sections.push(`| ${name} | ${type} | ${display} | ${desc} |`);
      });
      sections.push('');
    }

    // 添加其他表格（如参考表格）
    if (pageData.additionalTables && pageData.additionalTables.length > 0) {
      pageData.additionalTables.forEach(table => {
        // 添加表格标题
        if (table.title) {
          sections.push(`## ${table.title}\n`);
        }
        // 添加表头
        if (table.headers && table.headers.length > 0) {
          sections.push(`| ${table.headers.join(' | ')} |`);
          sections.push(`| ${table.headers.map(() => '---').join(' | ')} |`);
          // 添加数据行
          if (table.rows && table.rows.length > 0) {
            table.rows.forEach(row => {
              const values = table.headers.map(h => row[h] || '');
              sections.push(`| ${values.join(' | ')} |`);
            });
          }
          sections.push('');
        }
      });
    }

    // 添加接口示例
    if (pageData.codeExample) {
      sections.push('## 接口示例\n');
      sections.push('```python');
      sections.push(pageData.codeExample);
      sections.push('```');
      sections.push('');
    }

    // 添加数据示例
    if (pageData.dataExample) {
      sections.push('## 数据示例\n');
      sections.push('```');
      sections.push(pageData.dataExample);
      sections.push('```');
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 生成 TickDB API 文档 Markdown
   * @param {PageData} pageData - TickDB API 文档页面数据
   * @returns {string} Markdown文本
   */
  generateTickdbApi(pageData) {
    const sections = [];

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加 API 路径
    if (pageData.apiPath) {
      sections.push('## API 端点\n');
      sections.push(`\`${pageData.apiPath}\``);
      sections.push('');
    }

    // TickDB 解析器已经生成了完整的 Markdown 内容，直接使用
    if (pageData.markdownContent) {
      sections.push(pageData.markdownContent);
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 生成 ModelScope MCP 文档 Markdown
   * @param {PageData} pageData - ModelScope MCP 文档页面数据
   * @returns {string} Markdown文本
   */
  generateModelscopeMcp(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源 URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 简介\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 添加服务器信息
    if (pageData.serverInfo && Object.keys(pageData.serverInfo).length > 0) {
      sections.push('## 服务器信息\n');
      Object.entries(pageData.serverInfo).forEach(([key, value]) => {
        sections.push(`- **${key}**: ${value}`);
      });
      sections.push('');
    }

    // 添加标签
    if (pageData.tags && pageData.tags.length > 0) {
      sections.push('## 标签\n');
      sections.push(pageData.tags.map(tag => `\`${tag}\``).join(' '));
      sections.push('');
    }

    // 添加工具列表
    if (pageData.tools && pageData.tools.length > 0) {
      sections.push('## 可用工具\n');
      pageData.tools.forEach(tool => {
        const toolTitle = tool.displayName ? `${tool.displayName} (\`${tool.name}\`)` : `\`${tool.name}\``;
        sections.push(`### ${toolTitle}`);
        if (tool.description) {
          sections.push('');
          sections.push(tool.description);
        }

        // 输入参数
        if (tool.inputs && tool.inputs.length > 0) {
          sections.push('');
          sections.push('**输入参数:**');
          sections.push('');
          sections.push('| 参数名 | 描述 |');
          sections.push('|--------|------|');
          tool.inputs.forEach(param => {
            sections.push(`| \`${param.name}\` | ${param.description || ''} |`);
          });
        }

        // 输出
        if (tool.outputs && tool.outputs.length > 0) {
          sections.push('');
          sections.push('**输出:**');
          sections.push(tool.outputs.map(o => `\`${o}\``).join(', '));
        }

        // 兼容旧的 parameters 格式
        if (tool.parameters && tool.parameters.length > 0 && !tool.inputs) {
          sections.push('');
          sections.push('| 参数 | 类型 | 必需 | 描述 |');
          sections.push('|------|------|------|------|');
          tool.parameters.forEach(param => {
            sections.push(`| ${param.name} | ${param.type || 'string'} | ${param.required ? '是' : '否'} | ${param.description || ''} |`);
          });
        }
        sections.push('');
      });
    }

    // 添加 Prompts
    if (pageData.prompts && pageData.prompts.length > 0) {
      sections.push('## Prompts\n');
      pageData.prompts.forEach(prompt => {
        sections.push(prompt);
        sections.push('');
      });
    }

    // 添加安装说明
    if (pageData.installation) {
      sections.push('## 安装\n');
      sections.push(pageData.installation);
      sections.push('');
    }

    // 添加配置说明
    if (pageData.configuration) {
      sections.push('## 配置\n');
      sections.push(pageData.configuration);
      sections.push('');
    }

    // 添加代码块
    if (pageData.codeBlocks && pageData.codeBlocks.length > 0) {
      sections.push('## 代码示例\n');
      pageData.codeBlocks.forEach((block, index) => {
        sections.push(`### 示例 ${index + 1}`);
        sections.push('');
        sections.push(`\`\`\`${block.language}`);
        sections.push(block.code);
        sections.push('```');
        sections.push('');
      });
    }

    // 添加表格
    if (pageData.tables && pageData.tables.length > 0) {
      sections.push('## 数据表格\n');
      pageData.tables.forEach((table, index) => {
        sections.push(`### 表格 ${index + 1}`);
        sections.push('');
        if (table.headers && table.headers.length > 0) {
          sections.push('| ' + table.headers.join(' | ') + ' |');
          sections.push('| ' + table.headers.map(() => '---').join(' | ') + ' |');
          if (table.rows) {
            table.rows.forEach(row => {
              const values = table.headers.map(h => row[h] || '');
              sections.push('| ' + values.join(' | ') + ' |');
            });
          }
        }
        sections.push('');
      });
    }

    // 添加相关链接
    if (pageData.links && pageData.links.length > 0) {
      sections.push('## 相关链接\n');
      pageData.links.forEach(link => {
        sections.push(`- [${link.text}](${link.href})`);
      });
      sections.push('');
    }

    // 添加原始内容（如果有额外内容未解析）
    if (pageData.rawContent) {
      // 检查是否有未包含的内容
      const capturedContent = sections.join('\n');
      if (capturedContent.length < pageData.rawContent.length * 0.5) {
        sections.push('## 完整内容\n');
        sections.push('```');
        sections.push(pageData.rawContent);
        sections.push('```');
        sections.push('');
      }
    }

    return sections.join('\n');
  }

  /**
   * 生成 iTick 普通文档的 Markdown
   * @param {Object} pageData - 页面数据
   * @returns {string} Markdown文本
   */
  generateItickDoc(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 添加描述
    if (pageData.description) {
      sections.push('## 描述\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 优先使用解析器生成的结构化 Markdown 内容
    if (pageData.markdownContent) {
      const content = pageData.markdownContent
        .replace(/^#\s*.+\n/, '')
        .trim();
      if (content) {
        sections.push(content);
        sections.push('');
        return sections.join('\n');
      }
    }

    // 添加章节内容
    if (pageData.sections && pageData.sections.length > 0) {
      pageData.sections.forEach(section => {
        if (section.title) {
          sections.push(`## ${section.title}\n`);
        }
        if (section.content) {
          sections.push(section.content);
          sections.push('');
        }
      });
    }

    // 如果没有章节内容，使用原始内容
    if ((!pageData.sections || pageData.sections.length === 0) && pageData.rawContent) {
      sections.push('## 内容\n');
      sections.push(pageData.rawContent);
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 生成 EODHD 博客文章 Markdown
   * @param {PageData} pageData - EODHD 博客页面数据
   * @returns {string} Markdown文本
   */
  generateEodhdBlog(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 如果解析器已经生成了 markdownContent，直接使用
    if (pageData.markdownContent) {
      // 移除标题（已经添加过了）
      const content = pageData.markdownContent
        .replace(/^#\s*.+\n/, '')
        .replace(/^##\s*源URL\n.+?\n\n/s, '');
      sections.push(content);
    }

    return sections.join('\n');
  }

  /**
   * 生成 EODHD API 文档 Markdown
   * @param {PageData} pageData - EODHD API 文档页面数据
   * @returns {string} Markdown文本
   */
  generateEodhdApi(pageData) {
    const sections = [];

    // 添加标题
    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    // 添加源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 如果解析器已经生成了 markdownContent，直接使用
    if (pageData.markdownContent) {
      // 移除标题和源URL（已经添加过了）
      const content = pageData.markdownContent
        .replace(/^#\s*.+\n/, '')
        .replace(/^##\s*源URL\n.+?\n\n/s, '');
      sections.push(content);
    }

    return sections.join('\n');
  }

  /**
   * 生成 AllTick API 文档 Markdown
   * @param {PageData} pageData - AllTick API 页面数据
   * @returns {string} Markdown文本
   */
  generateAlltickApi(pageData) {
    const sections = [];

    if (pageData.title) {
      sections.push(`# ${pageData.title}\n`);
    }

    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    if (pageData.markdownContent) {
      const content = pageData.markdownContent
        .replace(/^#\s*.+\n/, '')
        .replace(/^##\s*源URL\n.+?\n\n/s, '')
        .trim();

      if (content) {
        sections.push(content);
      }
    } else if (pageData.rawContent) {
      sections.push(pageData.rawContent);
    }

    return sections.join('\n');
  }

  /**
   * 生成 Google Discovery 文档 Markdown
   * @param {PageData} pageData - Discovery 页面数据
   * @returns {string} Markdown文本
   */
  generateGoogleDiscoveryDoc(pageData) {
    const sections = [];

    sections.push(`# ${pageData.title || 'Google Discovery Document'}\n`);

    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    sections.push('## 入口信息\n');
    sections.push(`- Service Name: \`${pageData.serviceName || '-'}\``);
    sections.push(`- Canonical Name: \`${pageData.canonicalName || '-'}\``);
    sections.push(`- Version: \`${pageData.version || '-'}\``);
    sections.push(`- Revision: \`${pageData.revision || '-'}\``);
    sections.push(`- Protocol: \`${pageData.protocol || '-'}\``);
    sections.push(`- Discovery Version: \`${pageData.discoveryVersion || '-'}\``);
    sections.push(`- Root URL: \`${pageData.rootUrl || '-'}\``);
    sections.push(`- Base URL: \`${pageData.baseUrl || '-'}\``);
    sections.push(`- Service Path: \`${pageData.servicePath || '-'}\``);
    sections.push(`- Base Path: \`${pageData.basePath || '-'}\``);
    sections.push(`- Batch Path: \`${pageData.batchPath || '-'}\``);
    if (pageData.mtlsRootUrl) {
      sections.push(`- mTLS Root URL: \`${pageData.mtlsRootUrl}\``);
    }
    if (pageData.documentationLink) {
      sections.push(`- Documentation: ${pageData.documentationLink}`);
    }
    sections.push('');

    if (pageData.ownerName || pageData.ownerDomain) {
      sections.push('## 归属信息\n');
      sections.push(`- Owner Name: ${this.escapeMarkdown(pageData.ownerName || '-')}`);
      sections.push(`- Owner Domain: ${this.escapeMarkdown(pageData.ownerDomain || '-')}`);
      sections.push('');
    }

    sections.push('## 完整性摘要\n');
    sections.push(`- 资源总数（含嵌套）: ${pageData.resourcesCount ?? 0}`);
    sections.push(`- Schema 数量: ${pageData.schemasCount ?? 0}`);
    sections.push(`- 全局参数数量: ${pageData.parametersCount ?? 0}`);
    sections.push(`- 顶层 methods 数量: ${pageData.topLevelMethodCount ?? 0}`);
    sections.push(`- 接口总数: ${pageData.endpointCount ?? (pageData.urlRuleInterfaces || []).length}`);
    sections.push('');

    if (Array.isArray(pageData.authScopes) && pageData.authScopes.length > 0) {
      sections.push(`## OAuth Scopes（共 ${pageData.authScopes.length} 个）\n`);
      sections.push('| Scope | 描述 |');
      sections.push('|-------|------|');
      pageData.authScopes.forEach((scope) => {
        sections.push(`| \`${this.escapeMarkdown(scope.name || '-')}\` | ${this.escapeMarkdown(scope.description || '-')} |`);
      });
      sections.push('');
    }

    const interfaces = pageData.urlRuleInterfaces || [];
    sections.push(`## URL规则接口（共 ${interfaces.length} 个）\n`);

    if (interfaces.length > 0) {
      sections.push('| 资源 | 方法ID | HTTP | Path | Full URL Template | 参数数量 | 参数 | Request | Response |');
      sections.push('|------|--------|------|------|-------------------|----------|------|---------|----------|');
      interfaces.forEach((item) => {
        const params = (item.parameterNames || []).join(', ');
        sections.push(`| ${this.escapeMarkdown(item.resource || '-')} | \`${this.escapeMarkdown(item.id || item.methodName || '-')}\` | \`${this.escapeMarkdown(item.httpMethod || '-')}\` | \`${this.escapeMarkdown(item.path || '-')}\` | \`${this.escapeMarkdown(item.fullUrlTemplate || '-')}\` | ${item.parameterCount ?? (item.parameterNames || []).length} | ${this.escapeMarkdown(params || '-')} | \`${this.escapeMarkdown(item.requestRef || '-')}\` | \`${this.escapeMarkdown(item.responseRef || '-')}\` |`);
      });
      sections.push('');
    }

    if (pageData.rawContent) {
      sections.push('## Discovery 原始内容\n');
      sections.push('```json');
      sections.push(pageData.rawContent);
      sections.push('```');
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 生成门户首页的 Markdown
   * @param {Object} pageData - 门户页面数据
   * @returns {string} Markdown文本
   */
  generatePortal(pageData) {
    const sections = [];

    // 标题
    sections.push(`# ${pageData.title || '门户首页'}\n`);

    // 源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 站点描述
    if (pageData.description) {
      sections.push('## 站点简介\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 关键词
    if (pageData.keywords) {
      sections.push('## 关键词\n');
      sections.push(pageData.keywords);
      sections.push('');
    }

    // 导航菜单
    if (pageData.navigation && pageData.navigation.length > 0) {
      sections.push('## 导航菜单\n');
      pageData.navigation.forEach((nav) => {
        if (nav.items && nav.items.length > 0) {
          sections.push(`### ${nav.type === 'main' ? '主导航' : nav.type === 'top' ? '顶部导航' : nav.type === 'channel' ? '频道导航' : '导航'}\n`);
          const links = nav.items.map((item) => `[${this.escapeMarkdown(item.text)}](${item.href})`);
          sections.push(links.join(' | '));
          sections.push('');
        }
      });
    }

    // 热门榜单
    if (pageData.hotTopics && pageData.hotTopics.length > 0) {
      sections.push('## 热门榜单\n');
      pageData.hotTopics.forEach((topic) => {
        sections.push(`### ${this.escapeMarkdown(topic.title)}\n`);
        if (topic.items && topic.items.length > 0) {
          topic.items.forEach((item) => {
            const link = item.href ? `[${this.escapeMarkdown(item.text)}](${item.href})` : this.escapeMarkdown(item.text);
            const hot = item.hotScore ? ` 🔥${item.hotScore}` : '';
            sections.push(`${item.rank}. ${link}${hot}`);
          });
          sections.push('');
        }
      });
    }

    // 内容区块
    if (pageData.contentBlocks && pageData.contentBlocks.length > 0) {
      sections.push('## 内容区块\n');
      pageData.contentBlocks.forEach((block) => {
        sections.push(`### ${this.escapeMarkdown(block.title)}\n`);
        if (block.items && block.items.length > 0) {
          block.items.forEach((item) => {
            const link = `[${this.escapeMarkdown(item.text)}](${item.href})`;
            if (item.summary) {
              sections.push(`- ${link}`);
              sections.push(`  > ${this.escapeMarkdown(item.summary.slice(0, 150))}${item.summary.length > 150 ? '...' : ''}`);
            } else {
              sections.push(`- ${link}`);
            }
          });
          sections.push('');
        }
      });
    }

    // 频道分类
    if (pageData.channels && pageData.channels.length > 0) {
      sections.push('## 频道分类\n');
      pageData.channels.forEach((channel) => {
        if (channel.items && channel.items.length > 0) {
          sections.push(`### ${this.escapeMarkdown(channel.title)}\n`);
          const links = channel.items.map((item) => `[${this.escapeMarkdown(item.text)}](${item.href})`);
          sections.push(links.join(' | '));
          sections.push('');
        }
      });
    }

    // 快捷入口
    if (pageData.quickLinks && pageData.quickLinks.length > 0) {
      sections.push('## 快捷入口\n');
      pageData.quickLinks.forEach((quick) => {
        if (quick.items && quick.items.length > 0) {
          sections.push(`### ${this.escapeMarkdown(quick.title)}\n`);
          const links = quick.items.map((item) => `[${this.escapeMarkdown(item.text)}](${item.href})`);
          sections.push(links.join(' | '));
          sections.push('');
        }
      });
    }

    // 侧边栏
    if (pageData.sidebars && pageData.sidebars.length > 0) {
      sections.push('## 侧边栏\n');
      pageData.sidebars.forEach((sidebar) => {
        sections.push(`### ${this.escapeMarkdown(sidebar.title)}\n`);
        if (sidebar.items && sidebar.items.length > 0) {
          sidebar.items.slice(0, 15).forEach((item) => {
            sections.push(`- [${this.escapeMarkdown(item.text)}](${item.href})`);
          });
          sections.push('');
        }
      });
    }

    // 关键图片（限制数量）
    if (pageData.images && pageData.images.length > 0) {
      sections.push('## 页面截图\n');
      pageData.images.slice(0, 5).forEach((img) => {
        if (img.localPath) {
          sections.push(`![${this.escapeMarkdown(img.alt || '页面图片')}](${img.localPath})`);
        }
      });
      sections.push('');
    }

    // 底部信息
    if (pageData.footer) {
      const footer = pageData.footer;
      sections.push('## 底部信息\n');

      if (footer.copyright) {
        sections.push(`**版权信息**: ${this.escapeMarkdown(footer.copyright)}`);
      }

      if (footer.icp) {
        sections.push(`**ICP备案**: ${this.escapeMarkdown(footer.icp)}`);
      }

      if (footer.contact) {
        sections.push(`**联系方式**: ${this.escapeMarkdown(footer.contact)}`);
      }

      if (footer.links && footer.links.length > 0) {
        sections.push('\n**底部链接**:\n');
        const links = footer.links.slice(0, 20).map((item) => `[${this.escapeMarkdown(item.text)}](${item.href})`);
        sections.push(links.join(' | '));
      }
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 生成列表页Markdown
   */
  generateListPage(pageData) {
    const sections = [];

    // 标题
    sections.push(`# ${pageData.listTitle || pageData.title || '列表页'}\n`);

    // 源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 页面描述
    if (pageData.description) {
      sections.push('## 页面简介\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 筛选器
    if (pageData.filters && pageData.filters.length > 0) {
      sections.push('## 筛选分类\n');
      pageData.filters.forEach((filter) => {
        sections.push(`### ${this.escapeMarkdown(filter.title)}\n`);
        if (filter.options && filter.options.length > 0) {
          const links = filter.options.slice(0, 15).map((opt) =>
            opt.href ? `[${this.escapeMarkdown(opt.text)}](${opt.href})` : this.escapeMarkdown(opt.text)
          );
          sections.push(links.join(' | '));
          sections.push('');
        }
      });
    }

    // 列表项
    if (pageData.listItems && pageData.listItems.length > 0) {
      sections.push('## 列表内容\n');
      pageData.listItems.forEach((item) => {
        const link = `[${this.escapeMarkdown(item.title)}](${item.href})`;
        sections.push(`### ${item.index}. ${link}\n`);

        if (item.time) {
          sections.push(`**时间**: ${this.escapeMarkdown(item.time)}`);
        }
        if (item.source) {
          sections.push(`**来源**: ${this.escapeMarkdown(item.source)}`);
        }
        if (item.price) {
          sections.push(`**价格**: ${this.escapeMarkdown(item.price)}`);
        }
        if (item.tags && item.tags.length > 0) {
          sections.push(`**标签**: ${item.tags.map((t) => this.escapeMarkdown(t)).join(', ')}`);
        }
        if (item.summary) {
          sections.push(`\n> ${this.escapeMarkdown(item.summary.slice(0, 200))}${item.summary.length > 200 ? '...' : ''}`);
        }
        sections.push('');
      });
    }

    // 分页信息
    if (pageData.pagination) {
      const pagination = pageData.pagination;
      if (pagination.total > 1) {
        sections.push('## 分页信息\n');
        sections.push(`当前第 ${pagination.current} 页，共 ${pagination.total} 页`);
        if (pagination.pages && pagination.pages.length > 0) {
          sections.push(`，页码: ${pagination.pages.join(', ')}`);
        }
        sections.push('');
      }
    }

    // 侧边栏
    if (pageData.sidebar) {
      if (pageData.sidebar.hotItems && pageData.sidebar.hotItems.length > 0) {
        sections.push('## 热门推荐\n');
        pageData.sidebar.hotItems.forEach((item) => {
          sections.push(`- [${this.escapeMarkdown(item.text)}](${item.href})`);
        });
        sections.push('');
      }
      if (pageData.sidebar.categories && pageData.sidebar.categories.length > 0) {
        sections.push('## 相关分类\n');
        const links = pageData.sidebar.categories.map((item) => `[${this.escapeMarkdown(item.text)}](${item.href})`);
        sections.push(links.join(' | '));
        sections.push('');
      }
    }

    return sections.join('\n');
  }

  /**
   * 生成文章页Markdown
   */
  generateArticle(pageData) {
    const sections = [];

    // 标题
    sections.push(`# ${pageData.title || '文章详情'}\n`);

    // 源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 文章元信息
    sections.push('## 文章信息\n');
    if (pageData.publishTime) {
      sections.push(`**发布时间**: ${this.escapeMarkdown(pageData.publishTime)}`);
    }
    if (pageData.source) {
      sections.push(`**来源**: ${this.escapeMarkdown(pageData.source)}`);
    }
    if (pageData.views) {
      sections.push(`**阅读量**: ${this.escapeMarkdown(pageData.views)}`);
    }
    sections.push('');

    // 作者信息
    if (pageData.author && pageData.author.name) {
      sections.push('## 作者\n');
      sections.push(`**${this.escapeMarkdown(pageData.author.name)}**`);
      if (pageData.author.profile) {
        sections.push(` [作者主页](${pageData.author.profile})`);
      }
      if (pageData.author.bio) {
        sections.push(`\n> ${this.escapeMarkdown(pageData.author.bio)}`);
      }
      sections.push('');
    }

    // 关键词/标签
    if (pageData.keywords) {
      sections.push('## 关键词\n');
      sections.push(pageData.keywords);
      sections.push('');
    }
    if (pageData.tags && pageData.tags.length > 0) {
      sections.push('## 标签\n');
      sections.push(pageData.tags.map((t) => `\`${this.escapeMarkdown(t)}\``).join(' '));
      sections.push('');
    }

    // 文章摘要
    if (pageData.description) {
      sections.push('## 摘要\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 文章正文
    if (pageData.content) {
      sections.push('## 正文内容\n');
      sections.push(pageData.content);
      sections.push('');
    }

    // 评论信息
    if (pageData.comments && pageData.comments.enabled) {
      sections.push('## 评论区\n');
      if (pageData.comments.count > 0) {
        sections.push(`共 ${pageData.comments.count} 条评论`);
      } else {
        sections.push('暂无评论');
      }
      sections.push('');
    }

    // 相关文章
    if (pageData.relatedArticles && pageData.relatedArticles.length > 0) {
      sections.push('## 相关文章\n');
      pageData.relatedArticles.forEach((article) => {
        sections.push(`- [${this.escapeMarkdown(article.title)}](${article.href})`);
      });
      sections.push('');
    }

    // 内容图片
    if (pageData.images && pageData.images.length > 0) {
      sections.push('## 文章图片\n');
      pageData.images.slice(0, 10).forEach((img) => {
        if (img.localPath) {
          sections.push(`![${this.escapeMarkdown(img.alt || '图片')}](${img.localPath})`);
        } else if (img.src) {
          sections.push(`![${this.escapeMarkdown(img.alt || '图片')}](${img.src})`);
        }
      });
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 生成搜索结果页Markdown
   */
  generateSearchResult(pageData) {
    const sections = [];

    // 标题
    sections.push(`# 搜索结果: ${pageData.query || '搜索'}\n`);

    // 源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 搜索信息
    sections.push('## 搜索信息\n');
    sections.push(`**搜索词**: ${this.escapeMarkdown(pageData.query || '')}`);
    if (pageData.totalResults > 0) {
      sections.push(`\n**结果数**: 约 ${pageData.totalResults.toLocaleString()} 条`);
    }
    if (pageData.searchTime) {
      sections.push(`\n**搜索耗时**: ${this.escapeMarkdown(pageData.searchTime)}`);
    }
    sections.push('');

    // 搜索结果
    if (pageData.results && pageData.results.length > 0) {
      sections.push('## 搜索结果\n');
      pageData.results.forEach((result) => {
        const adMark = result.isAd ? ' [广告]' : '';
        sections.push(`### ${result.rank}. ${this.escapeMarkdown(result.title)}${adMark}\n`);

        if (result.displayUrl) {
          sections.push(`**链接**: [${this.escapeMarkdown(result.displayUrl)}](${result.href})`);
        } else {
          sections.push(`**链接**: [${result.href}](${result.href})`);
        }

        if (result.snippet) {
          sections.push(`\n> ${this.escapeMarkdown(result.snippet)}`);
        }
        sections.push('');
      });
    }

    // 相关搜索
    if (pageData.relatedSearches && pageData.relatedSearches.length > 0) {
      sections.push('## 相关搜索\n');
      const links = pageData.relatedSearches.map((item) => `[${this.escapeMarkdown(item.text)}](${item.href})`);
      sections.push(links.join(' | '));
      sections.push('');
    }

    // 广告
    if (pageData.ads && pageData.ads.length > 0) {
      sections.push('## 广告推广\n');
      pageData.ads.forEach((ad) => {
        sections.push(`- [${this.escapeMarkdown(ad.title)}](${ad.href})`);
      });
      sections.push('');
    }

    // 分页
    if (pageData.pagination && pageData.pagination.total > 1) {
      sections.push('## 分页\n');
      sections.push(`当前第 ${pageData.pagination.current} 页，共 ${pageData.pagination.total} 页`);
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 生成电商商品详情页Markdown
   */
  generateEcommerceProduct(pageData) {
    const sections = [];

    // 标题
    sections.push(`# ${pageData.title || '商品详情'}\n`);

    // 源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 商品基本信息
    sections.push('## 商品信息\n');
    if (pageData.subtitle) {
      sections.push(`**副标题**: ${this.escapeMarkdown(pageData.subtitle)}`);
    }
    if (pageData.brand) {
      sections.push(`**品牌**: ${this.escapeMarkdown(pageData.brand)}`);
    }
    if (pageData.category) {
      sections.push(`**分类**: ${this.escapeMarkdown(pageData.category)}`);
    }
    sections.push('');

    // 价格信息
    if (pageData.price) {
      sections.push('## 价格信息\n');
      if (pageData.price.current) {
        sections.push(`**当前价格**: ${pageData.price.currency || '¥'}${pageData.price.current}`);
      }
      if (pageData.price.original) {
        sections.push(`**原价**: ${pageData.price.currency || '¥'}${pageData.price.original}`);
      }
      if (pageData.price.discount) {
        sections.push(`**优惠**: ${this.escapeMarkdown(pageData.price.discount)}`);
      }
      sections.push('');
    }

    // SKU信息
    if (pageData.sku && pageData.sku.options && pageData.sku.options.length > 0) {
      sections.push('## 规格选择\n');
      pageData.sku.options.forEach((option) => {
        sections.push(`**${this.escapeMarkdown(option.name)}**: ${option.values.map((v) => this.escapeMarkdown(v)).join(' / ')}`);
      });
      sections.push('');
    }

    // 卖家信息
    if (pageData.seller && pageData.seller.name) {
      sections.push('## 店铺信息\n');
      sections.push(`**店铺名**: ${this.escapeMarkdown(pageData.seller.name)}`);
      if (pageData.seller.type) {
        sections.push(`\n**店铺类型**: ${this.escapeMarkdown(pageData.seller.type)}`);
      }
      if (pageData.seller.rating) {
        sections.push(`\n**店铺评分**: ${this.escapeMarkdown(pageData.seller.rating)}`);
      }
      if (pageData.seller.location) {
        sections.push(`\n**所在地**: ${this.escapeMarkdown(pageData.seller.location)}`);
      }
      sections.push('');
    }

    // 评价信息
    if (pageData.reviews) {
      sections.push('## 商品评价\n');
      if (pageData.reviews.count > 0) {
        sections.push(`**评价数**: ${pageData.reviews.count}`);
        if (pageData.reviews.avgScore > 0) {
          sections.push(`\n**平均评分**: ${pageData.reviews.avgScore}`);
        }
        if (pageData.reviews.goodRate) {
          sections.push(`\n**好评率**: ${this.escapeMarkdown(pageData.reviews.goodRate)}`);
        }
      } else {
        sections.push('暂无评价');
      }
      sections.push('');
    }

    // 商品描述
    if (pageData.description) {
      sections.push('## 商品详情\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 商品图片
    if (pageData.images && pageData.images.length > 0) {
      sections.push('## 商品图片\n');
      pageData.images.forEach((img) => {
        if (img.localPath) {
          sections.push(`![${this.escapeMarkdown(img.alt || '商品图片')}](${img.localPath})`);
        } else if (img.src) {
          sections.push(`![${this.escapeMarkdown(img.alt || '商品图片')}](${img.src})`);
        }
      });
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 生成电商商品列表页Markdown
   */
  generateEcommerceList(pageData) {
    const sections = [];

    // 标题
    sections.push(`# ${pageData.title || '商品列表'}\n`);

    // 源URL
    if (pageData.url) {
      sections.push('## 源URL\n');
      sections.push(pageData.url);
      sections.push('');
    }

    // 页面描述
    if (pageData.description) {
      sections.push('## 页面简介\n');
      sections.push(pageData.description);
      sections.push('');
    }

    // 筛选器
    if (pageData.filters && pageData.filters.length > 0) {
      sections.push('## 筛选条件\n');
      pageData.filters.forEach((filter) => {
        sections.push(`### ${this.escapeMarkdown(filter.name)}\n`);
        if (filter.values && filter.values.length > 0) {
          const links = filter.values.slice(0, 15).map((val) =>
            val.href ? `[${this.escapeMarkdown(val.text)}](${val.href})` : this.escapeMarkdown(val.text)
          );
          sections.push(links.join(' | '));
          sections.push('');
        }
      });
    }

    // 商品列表
    if (pageData.products && pageData.products.length > 0) {
      sections.push('## 商品列表\n');
      pageData.products.forEach((product) => {
        const link = `[${this.escapeMarkdown(product.title)}](${product.href})`;
        sections.push(`### ${product.rank}. ${link}\n`);

        if (product.price) {
          sections.push(`**价格**: ¥${product.price}`);
        }
        if (product.shop) {
          sections.push(`**店铺**: ${this.escapeMarkdown(product.shop)}`);
        }
        if (product.img) {
          sections.push(`\n![商品图](${product.img})`);
        }
        sections.push('');
      });
    }

    // 分页
    if (pageData.pagination) {
      const pagination = pageData.pagination;
      if (pagination.total > 1) {
        sections.push('## 分页信息\n');
        sections.push(`当前第 ${pagination.current} 页，共 ${pagination.total} 页`);
        sections.push('');
      }
    }

    return sections.join('\n');
  }

  normalizeMarkdownOutput(markdown, pageData = {}) {
    const normalized = (markdown || '')
      .replace(/\r\n/g, '\n')
      .replace(/[\u200B\u200C\u200D]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const lines = normalized ? normalized.split('\n') : [];
    const hasH1 = lines.some((line) => /^#\s+/.test(line));

    let finalMarkdown = normalized;
    if (!hasH1) {
      const title = (pageData?.title || pageData?.api?.name || 'Untitled').toString().trim();
      if (normalized) {
        finalMarkdown = `# ${this.escapeMarkdown(title)}\n\n${normalized}`;
      } else {
        finalMarkdown = `# ${this.escapeMarkdown(title)}`;
      }
    }

    const fenceCount = (finalMarkdown.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) {
      finalMarkdown = `${finalMarkdown}\n\n\`\`\`\n`;
    }

    // 生成统一的 YAML Frontmatter
    const frontmatter = this.generateFrontmatter(pageData);
    
    return `${frontmatter}\n\n${finalMarkdown}\n`;
  }

  /**
   * 生成统一的 YAML Frontmatter
   */
  generateFrontmatter(pageData) {
    if (!pageData) return '';

    const frontmatter = [];
    frontmatter.push('---');
    
    // Core common fields
    const id = pageData.id || this.generateId(pageData.url);
    const type = this.determineType(pageData.type);
    const title = pageData.title || pageData?.api?.name || pageData?.mcp?.name || 'Untitled';
    const url = pageData.url || '';
    const description = pageData.description || pageData?.api?.description || pageData?.mcp?.description || '';
    const source = pageData.source || pageData.domain || '';
    const tags = Array.isArray(pageData.tags) ? pageData.tags : [];
    const crawl_time = pageData.crawl_time || new Date().toISOString();
    
    frontmatter.push(`id: ${JSON.stringify(id)}`);
    frontmatter.push(`type: ${JSON.stringify(type)}`);
    frontmatter.push(`title: ${JSON.stringify(title)}`);
    frontmatter.push(`url: ${JSON.stringify(url)}`);
    frontmatter.push(`description: ${JSON.stringify(description)}`);
    frontmatter.push(`source: ${JSON.stringify(source)}`);
    frontmatter.push(`tags: ${JSON.stringify(tags)}`);
    frontmatter.push(`crawl_time: ${JSON.stringify(crawl_time)}`);
    
    // Extract remaining fields into metadata
    const metadata = {};
    const excludeKeys = new Set(['id', 'type', 'title', 'url', 'description', 'source', 'tags', 'crawl_time', 'html', 'markdown', 'content', 'screenshot']);
    
    for (const [key, value] of Object.entries(pageData)) {
      if (!excludeKeys.has(key) && value !== undefined && value !== null) {
        metadata[key] = value;
      }
    }
    
    if (Object.keys(metadata).length > 0) {
      frontmatter.push('metadata:');
      const metadataLines = this.serializeToYaml(metadata, 1);
      frontmatter.push(metadataLines);
    }
    
    frontmatter.push('---');
    return frontmatter.join('\n');
  }

  generateId(url) {
    if (!url) return `id-${Date.now()}`;
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      const char = url.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `url-${Math.abs(hash).toString(16)}`;
  }

  determineType(rawType) {
    if (!rawType) return 'website';
    if (rawType.includes('api')) return 'api';
    if (rawType.includes('mcp')) return 'mcp';
    if (rawType.includes('rss')) return 'rss';
    return 'website';
  }

  serializeToYaml(obj, indentLevel = 0) {
    const indent = '  '.repeat(indentLevel);
    let lines = [];
    
    if (Array.isArray(obj)) {
      if (obj.length === 0) return '[]';
      for (const item of obj) {
        if (typeof item === 'object' && item !== null) {
          lines.push(`${indent}- ${JSON.stringify(item)}`);
        } else {
          lines.push(`${indent}- ${JSON.stringify(item)}`);
        }
      }
    } else if (typeof obj === 'object' && obj !== null) {
      if (Object.keys(obj).length === 0) return '{}';
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null) {
          if (Array.isArray(value)) {
            if (value.length === 0) {
              lines.push(`${indent}${key}: []`);
            } else {
              lines.push(`${indent}${key}:`);
              lines.push(this.serializeToYaml(value, indentLevel + 1));
            }
          } else {
            if (Object.keys(value).length === 0) {
              lines.push(`${indent}${key}: {}`);
            } else {
              lines.push(`${indent}${key}:`);
              lines.push(this.serializeToYaml(value, indentLevel + 1));
            }
          }
        } else {
          lines.push(`${indent}${key}: ${JSON.stringify(value)}`);
        }
      }
    } else {
      return `${indent}${JSON.stringify(obj)}`;
    }
    
    return lines.join('\n');
  }

  /**
   * 保存Markdown文件
   * @param {string} content - Markdown内容
   * @param {string} filename - 文件名（不含扩展名）
   * @param {string} outputDir - 输出目录
   * @returns {string} 保存的文件路径
   */
  saveToFile(content, filename, outputDir) {
    try {
      // 确保输出目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // 如果文件名已有扩展名则保留，否则默认 .md
      const filenameWithExt = filename.includes('.') ? filename : `${filename}.md`;

      // 生成完整路径
      const filepath = path.join(outputDir, filenameWithExt);

      // 写入文件
      fs.writeFileSync(filepath, content, 'utf-8');

      return filepath;
    } catch (error) {
      throw new Error(`Failed to save file: ${error.message}`);
    }
  }
}

export default MarkdownGenerator;
