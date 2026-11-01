# 星梦小筑

一个可以在不同网络一起看视频、一起听歌、下五子棋和斗地主的小站。

- 视频同步：房主点播放会先等观众加载，再统一起播
- 音乐同步：服务端定统一开播点，手机缓冲好再出声
- 房间分享：二维码 / 公网隧道，异地手机流量可访问
- 小游戏：五子棋、斗地主
- 本地视频上传、B 站解析、歌单搜索/点歌

## 快速开始（Windows）

1. 解压或 clone 本项目
2. 双击 `一键启动.bat`
3. 第一次启动会自动检查 Node.js；缺失或低于 22.5 时自动下载便携版到 `runtime\node`
4. 启动后端并自动打开浏览器：`http://localhost:3000`

启动窗口会显示本机和公网地址。手机用流量打开公网地址即可。

> 默认公网隧道是 Cloudflare，Cloudflare 不通时降级 cpolar；不会出现 ngrok 的 `Visit Site` 提示页。
> 想强制使用 ngrok：在启动前执行 `set TUNNEL_PROVIDER=ngrok`。

## 开发

需要 Node.js 22.5+。

```bash
cd server
npm install
npm start
```

另开一个窗口启动隧道：

```bash
cd server
npm run tunnel
```

前端用 HBuilderX 打开项目目录运行；或者重新构建 H5：

```bash
node scripts/build-h5.mjs
```

构建产物会写到 `unpackage/dist/build/h5`，后端会自动托管。

## 目录

```text
pages/                 页面
components/            组件
utils/                 时钟同步、socket、脚本加载
server/                后端（Express + Socket.IO + SQLite）
scripts/build-h5.mjs   命令行构建 H5
scripts/ensure-node.ps1 一键启动的 Node 检查/自动安装
unpackage/dist/build/h5 已构建的 H5
uploads/               本地上传（空）
```

## 配置与安全

- 不要提交 `server/data/`、`.env`、`admin_login.json`、`uploads/` 里的用户数据
- 管理员密码通过 `server/.env` 或首次启动自动生成，数据库只存 bcrypt 哈希
- 公网隧道只适合小范围临时使用；正式部署建议用云服务器 + 固定域名

## GitHub

本仓库只放源码和构建后的 H5；`server/node_modules`、隧道二进制、数据库、测试上传都不会提交。

如果要把可双击运行的完整包发给别人，建议在 GitHub **Releases** 上传独立的 zip，而不是把 zip 提交进仓库。

## 说明

本项目仅供个人学习与朋友间私用。视频解析能力的使用后果由使用者自行承担。
