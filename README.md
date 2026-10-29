# 学霸省题

微信小程序原生前端 + Node.js/Express 后端的个人错题学习应用。

## 本地运行

```bash
npm run install:all
cp server/.env.example server/.env
npm run dev
```

默认配置会启用本地数据存储和外部服务替身，可完整联调核心流程。微信开发者工具打开项目根目录后，执行“工具 → 构建 npm”。

正式环境需在 `server/.env` 中关闭 `MOCK_EXTERNAL_SERVICES`、将 `DATA_DRIVER` 设置为 `cloudbase`，并配置 CloudBase、微信、阿里云读光 OCR、DeepSeek、阿里云百炼 Embedding 和 DashVector Serverless 参数。向量服务配置与历史索引重建命令见 [开发运行说明](docs/开发运行说明.md)。

## 文档

- [产品需求文档](docs/产品需求文档.md)
- [技术架构文档](docs/技术架构文档.md)

## 演示视频
![演示视频](演示视频/演示视频.mp4)
