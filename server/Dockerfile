# 构建上下文必须是项目根目录（D:\uniapp\Look），否则 server/ 与 unpackage/ 的相对路径会错
# 用法：
#   1. 在本机执行 HBuilderX「发行 → 网站-H5手机版」，或 npm run build:h5
#   2. 在项目根目录执行：docker build -f server/Dockerfile -t look-app .
#   3. docker run -d -p 3000:3000 -v look-data:/app/server/data \
#        -e ADMIN_INIT_PASSWORD=你的强密码 look-app
FROM node:22-slim

# better-sqlite3 的预编译包需要 python/make 才能在无预编译时本地编译，这里先装最小构建工具链
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm install --omit=dev && npm cache clean --force

# 业务代码（.dockerignore 已排除 node_modules / data / uploads）
COPY server ./server

# H5 构建产物（不存在会直接构建失败，避免上线后首页 404）
COPY unpackage/dist/build/h5 ./unpackage/dist/build/h5

# SQLite 数据目录做成卷，容器重建不丢管理员与历史记录
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/server/data \
    UPLOAD_DIR=/app/uploads \
    AUTO_OPEN=0
RUN mkdir -p /app/server/data /app/uploads
VOLUME ["/app/server/data", "/app/uploads"]

EXPOSE 3000

CMD ["node", "server/index.js"]
