// 部署配置：发行 H5 / 小程序前只需要改这个文件
//
// H5 端：
//   ''                         → 同源（推荐：前端由后端或 Nginx 托管，接口走 /api、/uploads、/socket.io）
//   'https://api.example.com'  → 前后端分离部署（必须是 HTTPS，否则浏览器会拦截）
export const H5_SERVER_BASE = ''

// 小程序端后端地址：
//   开发者工具模拟器会自动使用 http://localhost:3000
//   真机调试填电脑局域网 IP；体验版/正式版必须换成已备案的 HTTPS 域名，
//   并在微信公众平台配置 request / socket 合法域名。
export const MP_SERVER_BASE = 'http://192.168.1.6:3000'
