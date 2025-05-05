FROM node:18-alpine

WORKDIR /app

# 安裝基本工具
RUN apk add --no-cache curl

# 複製 package.json 和 package-lock.json
COPY package*.json ./

# 安裝依賴
RUN npm install --production

# 複製應用程式碼
COPY . .

# 設置環境變數
ENV NODE_ENV=production
ENV PORT=3000

# 健康檢查
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# 啟動應用
CMD ["node", "index.js"]