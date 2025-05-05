import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { createClient } from 'redis';
import rateLimit from 'express-rate-limit';
import prometheus from 'prom-client';

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

// 首先安裝 Redis 依賴
// npm install redis

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

// 快取工具列表
const TOOLS_CACHE_KEY = 'bgg:tools:list';
const CACHE_TTL = 3600; // 1小時

async function getToolsList() {
  try {
    const cachedTools = await redisClient.get(TOOLS_CACHE_KEY);
    if (cachedTools) {
      return JSON.parse(cachedTools);
    }

    // 如果快取不存在，使用靜態工具列表
    await redisClient.setEx(TOOLS_CACHE_KEY, CACHE_TTL, JSON.stringify(toolsList));
    return toolsList;
  } catch (error) {
    console.error('Redis error:', error);
    return toolsList; // 降級使用靜態列表
  }
}

// 快取基本配置
const baseConfig = {
  schema_version: "v1",
  name_for_human: "BGG API MCP",
  name_for_model: "bgg_api",
  description_for_human: "查詢 BGG 桌遊、熱門、收藏等資料",
  description_for_model: "使用 BGG XML API 查詢桌遊、收藏、熱門項目與詳細資訊",
  auth: { type: "none" }
};

// 快取工具列表
const toolsList = [
  {
    name: "search_game",
    description: "依照名稱搜尋桌遊",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜尋關鍵字" },
        exact: { type: "boolean", description: "是否要精確比對", default: false }
      },
      required: ["query"]
    }
  },
  {
    name: "get_thing",
    description: "查詢指定 id 的桌遊詳細資料",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "遊戲的 BGG ID" },
        stats: { type: "boolean", description: "是否取得排名資料", default: true }
      },
      required: ["id"]
    }
  },
  {
    name: "get_hot_items",
    description: "取得目前熱門的桌遊",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "熱門類型，如 boardgame", default: "boardgame" }
      }
    }
  },
  {
    name: "get_user_collection",
    description: "查詢指定使用者的收藏清單",
    parameters: {
      type: "object",
      properties: {
        username: { type: "string", description: "使用者帳號名稱" }
      },
      required: ["username"]
    }
  }
];

// Manifest 路由 - 使用快取的配置
app.get('/manifest.json', (req, res) => {
  res.json({
    ...baseConfig,
    api: {
      type: "openai_function",
      url: `http://${req.headers.host}/functions`
    },
    functions: toolsList
  });
});

// Functions 路由
app.post('/functions', async (req, res, next) => {
  try {
    const { function_call, arguments: argsString } = req.body;
    const args = JSON.parse(argsString || '{}');

    // 建立單一 Axios 實例
    const bggApi = axios.create({
      baseURL: BASE_URL,
      timeout: 30000,
      headers: {
        'Accept': 'application/xml',
        'User-Agent': 'BGG-MCP-Server/1.0'
      }
    });

    // 添加重試機制
    bggApi.interceptors.response.use(null, async (error) => {
      const { config } = error;
      if (!config || !config.retry) {
        return Promise.reject(error);
      }

      config.retry -= 1;
      const backoff = new Promise(resolve => setTimeout(resolve, config.retryDelay || 1000));
      await backoff;
      return bggApi(config);
    });

    let result;
    switch (function_call.name) {
      case 'search_game':
        result = await searchGame(bggApi, args.query, args.exact);
        break;
      case 'get_thing':
        result = await getThing(bggApi, args.id, args.stats);
        break;
      case 'get_hot_items':
        result = await getHotItems(bggApi, args.type);
        break;
      case 'get_user_collection':
        result = await getUserCollection(bggApi, args.username);
        break;
      default:
        return res.status(400).json({
          error: {
            message: 'Unknown function name',
            type: 'INVALID_FUNCTION',
            code: 'UNKNOWN_FUNCTION'
          }
        });
    }

    return res.json({ result });
  } catch (err) {
    next(err);
  }
});

// API 函數
async function searchGame(bggApi, query, exact = false) {
  const url = `${BASE_URL}/search?query=${encodeURIComponent(query)}&exact=${exact ? 1 : 0}`;
  const { data } = await bggApi.get(url);
  return data;
}

async function getThing(bggApi, id, stats = true) {
  const url = `${BASE_URL}/thing?id=${id}&stats=${stats ? 1 : 0}`;
  const { data } = await bggApi.get(url);
  return data;
}

async function getHotItems(bggApi, type = 'boardgame') {
  const url = `${BASE_URL}/hot?type=${type}`;
  const { data } = await bggApi.get(url);
  return data;
}

async function getUserCollection(bggApi, username) {
  const url = `${BASE_URL}/collection?username=${username}&stats=1`;
  const { data } = await bggApi.get(url);
  return data;
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

// 安裝 express-rate-limit
// npm install express-rate-limit

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分鐘
  max: 100 // 限制每個 IP 100 個請求
});

app.use('/functions', limiter);

// 安裝 prom-client
// npm install prom-client

const collectDefaultMetrics = prometheus.collectDefaultMetrics;
collectDefaultMetrics({ timeout: 5000 });

const httpRequestDurationMicroseconds = new prometheus.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.5, 1, 2, 5]
});

// 添加監控端點
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', prometheus.register.contentType);
  res.end(await prometheus.register.metrics());
});

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});
