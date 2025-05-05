import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
const PORT = 3000;
const BASE_URL = 'https://boardgamegeek.com/xmlapi2';

app.use(cors());
app.use(express.json());

// 基本配置，不包含任何需要認證的資訊
const getBaseConfig = (host) => ({
  schema_version: "v1",
  name_for_human: "BGG API MCP",
  name_for_model: "bgg_api",
  description_for_human: "查詢 BGG 桌遊、熱門、收藏等資料",
  description_for_model: "使用 BGG XML API 查詢桌遊、收藏、熱門項目與詳細資訊",
  auth: { type: "none" },
  api: {
    type: "openai_function",
    url: `http://${host}/functions`
  }
});

// 工具列表定義，不包含任何需要認證的資訊
const getToolsList = () => [
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

// 修改 manifest 路由處理，實現延遲載入
app.get('/manifest.json', (req, res) => {
  const baseConfig = getBaseConfig(req.headers.host);
  res.json({
    ...baseConfig,
    functions: getToolsList()
  });
});

// 修改 functions 路由處理，實現延遲載入
app.post('/functions', async (req, res) => {
  const { function_call, arguments: argsString } = req.body;
  const args = JSON.parse(argsString || '{}');

  try {
    // 在實際執行函數時才建立 axios 實例
    const axiosInstance = axios.create({
      timeout: 30000, // 30 秒超時
      headers: {
        'Accept': 'application/xml'
      }
    });

    let result;
    switch (function_call.name) {
      case 'search_game':
        result = await searchGame(axiosInstance, args.query, args.exact);
        break;
      case 'get_thing':
        result = await getThing(axiosInstance, args.id, args.stats);
        break;
      case 'get_hot_items':
        result = await getHotItems(axiosInstance, args.type);
        break;
      case 'get_user_collection':
        result = await getUserCollection(axiosInstance, args.username);
        break;
      default:
        return res.status(400).json({ error: 'Unknown function name' });
    }

    return res.json({ result });
  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// 修改所有 API 函數以接受 axios 實例
async function searchGame(axiosInstance, query, exact = false) {
  const url = `${BASE_URL}/search?query=${encodeURIComponent(query)}&exact=${exact ? 1 : 0}`;
  const { data } = await axiosInstance.get(url);
  return data;
}

async function getThing(axiosInstance, id, stats = true) {
  const url = `${BASE_URL}/thing?id=${id}&stats=${stats ? 1 : 0}`;
  const { data } = await axiosInstance.get(url);
  return data;
}

async function getHotItems(axiosInstance, type = 'boardgame') {
  const url = `${BASE_URL}/hot?type=${type}`;
  const { data } = await axiosInstance.get(url);
  return data;
}

async function getUserCollection(axiosInstance, username) {
  const url = `${BASE_URL}/collection?username=${username}&stats=1`;
  const { data } = await axiosInstance.get(url);
  return data;
}

// 添加健康檢查端點
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
