# 艾莎魔镜（Elsa Mirror）

给 Kiwi 的 AI 语音陪伴魔镜：iPad 常开网页，艾莎住在镜子里——轻拍雪花唤醒对话，到点主动提醒读书/刷牙，读完书语音打卡集雪花。

## 架构

- 纯静态网页（无构建、无后端），全部数据存 iPad 浏览器 localStorage
- 语音对话：浏览器 WebRTC 直连 OpenAI Realtime API（gpt-realtime）
- 无 API Key 时进入演示模式：系统语音念台词，跑通全部 UI，不联网不花钱

| 文件 | 作用 |
|---|---|
| `index.html` | 页面结构：魔镜、艾莎 SVG、家长面板 |
| `style.css` | 冰雪夜主题、待机/唤醒状态、动画 |
| `persona.js` | 艾莎人设与各场景提示词模板 |
| `realtime.js` | OpenAI Realtime WebRTC 封装 + 演示模式 |
| `app.js` | 状态机、定时提醒、读书打卡、家长面板、雪花背景 |

## 本地预览（Mac）

```bash
cd elsa-mirror && python3 -m http.server 8123
```

打开 http://localhost:8123 （localhost 是安全上下文，麦克风可用）。

## 部署到 iPad（需要 HTTPS）

iPad Safari 的麦克风权限要求 HTTPS，推荐 GitHub Pages（免费）：仓库设为 public（代码里无任何密钥，公开无风险），开启 Pages，iPad 访问 `https://<user>.github.io/elsa-mirror/`。

### iPad 设置清单

1. Safari 打开页面 → 分享 → 添加到主屏幕（全屏无地址栏）
2. 首次对话时允许麦克风权限
3. 设置 → 显示与亮度 → 自动锁定 → 永不
4. 设置 → 辅助功能 → 引导式访问 → 开启，三击电源键锁定在本应用
5. 插上电源，放在艾莎玩偶旁边

### 家长配置

左上角**长按 3 秒**进入家长面板：填 OpenAI API Key、选音色、改作息提醒、调读书目标/每日时长上限、看记录、改人设。

## 成本控制

- 会话闲置 90 秒自动休眠断连（Realtime 连接按时长计费）
- 每日对话时长上限（默认 60 分钟），到点艾莎道别，次日恢复
- 建议同时在 OpenAI 后台设 $30/月硬上限

## 待办 / 后续版本

- [ ] 首次真机联调时核对 Realtime GA 端点与 session 格式（代码已做 GA/beta 双格式自适应，未真机验证）
- [ ] 语音唤醒词"艾莎公主"（Picovoice Porcupine Web SDK，替代/补充轻拍雪花）
- [ ] 每周读书小报告（可用 Gemini 免费额度生成，发给家长）
