import express from 'express';
import axios from 'axios';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import * as prometheus from 'prom-client';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = 'https://boardgamegeek.com/xmlapi2';

// 中間件設置
app.use(cors());
app.use(express.json());

// 自定義錯誤類別
class BGGApiError extends Error {
  constructor(message, statusCode = 500, code = 'BGG_API_ERROR') {
    super(message);
    this.name = 'BGGApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// 請求日誌中間件
const requestLogger = (req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
};

app.use(requestLogger);

// 基本配置
const baseConfig = {
  schema_version: "v1",
  name_for_human: "BGG API MCP",
  name_for_model: "bgg_api",
  description_for_human: "查詢 BGG 桌遊、熱門、收藏等資料",
  description_for_model: "使用 BGG XML API 查詢桌遊、收藏、熱門項目與詳細資訊",
  auth: { type: "none" }
};

// 工具列表
const toolsList = [
  {
    name: "search_game",
    description: "Search board games by name. You can specify type (boardgame, boardgameexpansion, boardgameaccessory, rpgitem, videogame, boardgamedesigner).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword" },
        type: { type: "string", description: "Type to search, default is boardgame. Multiple types can be separated by commas.", default: "boardgame" },
        exact: { type: "boolean", description: "Whether to match exactly", default: false }
      },
      required: ["query"]
    }
  },
  {
    name: "get_thing",
    description: "Get detailed information for the specified id(s) (up to 20) of board games.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "BGG ID(s) of the game(s), can be comma-separated, up to 20" },
        type: { type: "string", description: "Filter returned types (optional)" },
        stats: { type: "boolean", description: "Whether to include ranking stats", default: true }
      },
      required: ["id"]
    }
  },
  {
    name: "get_hot_items",
    description: "Get the current hot board games.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Hot item type, e.g. boardgame", default: "boardgame" }
      }
    }
  },
  {
    name: "get_user_collection",
    description: "Get the collection list of the specified user.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username" }
      },
      required: ["username"]
    }
  }
];

// Manifest 路由
app.get('/manifest.json', (req, res) => {
  res.json({
    ...baseConfig,
    api: {
      type: "openapi",
      url: `http://${req.headers.host}/openapi.json`
    },
    logo_url: 'https://boardgamegeek.com/favicon.ico',
    contact_email: 'support@example.com',
    legal_info_url: 'https://boardgamegeek.com/terms',
    functions: toolsList
  });
});

class BGGServer {
  constructor() {
    this.server = new Server({
      name: 'bgg-mcp-server',
      version: '0.1.0'
    }, {
      capabilities: {
        resources: {},
        tools: {}
      }
    });
    this.setupToolHandlers();
    this.server.onerror = (error) => console.error('[MCP Error]', error);
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: toolsList
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      let result;

      try {
        switch (name) {
          case 'search_game': {
            const searchArgs = JSON.parse(args);
            if (!searchArgs.query) {
              throw new McpError(ErrorCode.InvalidParams, 'Query parameter is required');
            }
            result = await this.searchGame(
              searchArgs.query,
              searchArgs.type || 'boardgame',
              searchArgs.exact ?? false
            );
            break;
          }
          case 'get_thing': {
            const thingArgs = JSON.parse(args);
            if (!thingArgs.id) {
              throw new McpError(ErrorCode.InvalidParams, 'ID parameter is required');
            }
            result = await this.getThing(
              thingArgs.id,
              thingArgs.type || '',
              thingArgs.stats ?? true
            );
            break;
          }
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }

        return {
          content: [{
            type: 'text',
            text: result
          }]
        };
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(ErrorCode.InternalError, `Operation failed: ${error.message}`);
      }
    });
  }

  async searchGame(query, type = 'boardgame', exact = false) {
    try {
      const params = [
        `search=${encodeURIComponent(query)}`,
        type ? `type=${encodeURIComponent(type)}` : '',
        exact ? 'exact=1' : ''
      ].filter(Boolean).join('&');
      const response = await axios.get(`${BASE_URL}/search?${params}`);
      return response.data;
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Search failed: ${error.message}`);
    }
  }

  async getThing(id, type = '', stats = true) {
    try {
      const params = [
        `id=${encodeURIComponent(id)}`,
        type ? `type=${encodeURIComponent(type)}` : '',
        stats ? 'stats=1' : ''
      ].filter(Boolean).join('&');
      const response = await axios.get(`${BASE_URL}/thing?${params}`);
      return response.data;
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Get thing failed: ${error.message}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('BGG MCP server running on stdio');
  }
}

// 健康檢查端點
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// 改進錯誤處理中間件
const errorHandler = (err, req, res, next) => {
  console.error('Error:', {
    message: err.message,
    stack: err.stack,
    code: err.code,
    statusCode: err.statusCode
  });

  const statusCode = err.statusCode || 500;
  const errorResponse = {
    error: {
      message: err.message,
      type: err.name,
      code: err.code || 'INTERNAL_ERROR'
    }
  };

  if (process.env.NODE_ENV !== 'production') {
    errorResponse.error.stack = err.stack;
  }

  res.status(statusCode).json(errorResponse);
};

app.use(errorHandler);

// 請求限制
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分鐘
  max: 100 // 限制每個 IP 100 個請求
});

app.use('/functions', limiter);

// 監控設定
const collectDefaultMetrics = prometheus.collectDefaultMetrics;
collectDefaultMetrics({ timeout: 5000 });

// 添加監控端點
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', prometheus.register.contentType);
  res.end(await prometheus.register.metrics());
});

// 啟動伺服器
async function startServer() {
  try {
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV}`);
    });

    // 啟動 MCP 伺服器
    const server = new BGGServer();
    await server.run();
  } catch (error) {
    console.error('Server startup failed:', error);
    process.exit(1);
  }
}

startServer().catch(console.error);
