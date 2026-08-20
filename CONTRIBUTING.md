# 参与贡献

感谢你关注译镜 TransLens。欢迎提交问题、改进建议和 Pull Request。

## 开始之前

- 请先搜索已有的 Issue，避免重复提交。
- 交互或布局问题请附上复现网页类型、浏览器版本、操作系统和截图；不要上传包含隐私的网页内容。
- 安全漏洞请按照 [SECURITY.md](SECURITY.md) 私下报告，不要公开创建 Issue。

## 本地开发

项目使用原生 JavaScript 和 Chrome Manifest V3，不需要额外的前端框架。

```sh
npm run check
```

这个命令会运行测试并构建 `dist/`。本地验证时，在 `chrome://extensions` 中加载构建生成的 `dist` 目录。

当前版本要求 Chrome 138 或更高版本，并依赖 Chrome 提供的本地翻译能力。请在提交翻译相关改动时，同时考虑语言模型不可用、语言对不支持和模型尚未准备完成的情况。

## 提交 Pull Request

1. 从 `main` 创建一个主题分支。
2. 让每个提交聚焦一个问题，并使用清晰的提交信息。
3. 修改交互逻辑时补充或更新测试和演示页面。
4. 提交前运行 `npm run check`，确认没有格式、测试或构建错误。
5. 在 Pull Request 中说明改动内容、测试方式和已知限制。

请不要提交 `node_modules/`、构建产物 `dist/`、密钥、个人数据或未经授权的第三方资源。

## 许可

提交到本项目的代码默认以项目的 [MIT License](LICENSE) 发布。提交 Pull Request 即表示你有权提交这些内容，并同意按该许可授权项目使用。
