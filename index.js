import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
const PORT = 3000;
const BASE_URL = 'https://boardgamegeek.com/xmlapi2';

app.use(cors());
app.use(express.json());

app.get('/manifest.json', (req, res) => {
  res.json({
    schema_version: "v1",
    name_for_human: "BGG API MCP",
    name_for_model: "bgg_api",
    description_for_human: "查詢 BGG 桌遊、熱門、收藏等資料",
    description_for_model: "使用 BGG XML API 查詢桌遊、收藏、熱門項目與詳細資訊",
    auth: { type: "none" },
    api: {
      type: "openai_function",
      url: `http://${req.headers.host}/functions`
    },
    functions: [
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
    ]
  });
});

app.post('/functions', async (req, res) => {
  const { function_call, arguments: argsString } = req.body;
  const args = JSON.parse(argsString || '{}');

  try {
    switch (function_call.name) {
      case 'search_game':
        return res.json({ result: await searchGame(args.query, args.exact) });
      case 'get_thing':
        return res.json({ result: await getThing(args.id, args.stats) });
      case 'get_hot_items':
        return res.json({ result: await getHotItems(args.type) });
      case 'get_user_collection':
        return res.json({ result: await getUserCollection(args.username) });
      default:
        return res.status(400).json({ error: 'Unknown function name' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

async function searchGame(query, exact = false) {
  const url = `${BASE_URL}/search?query=${encodeURIComponent(query)}&exact=${exact ? 1 : 0}`;
  const { data } = await axios.get(url);
  return data;
}

async function getThing(id, stats = true) {
  const url = `${BASE_URL}/thing?id=${id}&stats=${stats ? 1 : 0}`;
  const { data } = await axios.get(url);
  return data;
}

async function getHotItems(type = 'boardgame') {
  const url = `${BASE_URL}/hot?type=${type}`;
  const { data } = await axios.get(url);
  return data;
}

async function getUserCollection(username) {
  const url = `${BASE_URL}/collection?username=${username}&stats=1`;
  const { data } = await axios.get(url);
  return data;
}

app.listen(PORT);
