// 跨端 HTTP 请求封装：H5 / 微信小程序 / App 通用（替代浏览器 fetch）
// 微信小程序没有 fetch，必须用 uni.request；H5 端 uni.request 同样可用。
export function requestJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    uni.request({
      url,
      method: options.method || 'GET',
      data: options.data,
      header: options.header || { 'Content-Type': 'application/json' },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data)
        } else {
          const err = new Error((res.data && res.data.error) || ('HTTP ' + res.statusCode))
          err.statusCode = res.statusCode
          err.data = res.data
          reject(err)
        }
      },
      fail: (err) => {
        const e = new Error((err && err.errMsg) || '网络请求失败')
        reject(e)
      }
    })
  })
}
