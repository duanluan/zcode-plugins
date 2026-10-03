---
description: 视觉代理初始化向导：生成/修复 ~/.zcode/zcode-vision.json，配置识别端点（供应商/模型/key），并用真实图片验证。
allowed-tools: Bash(python3:*), Bash(node:*), Bash(cat:*), Bash(ls:*), Bash(head:*), Bash(command -v:*)
---

zcode-vision 首次安装或配置混乱时运行本向导。目标产物是合法的 `~/.zcode/zcode-vision.json`（与 zcode-pro 设置面板共用同一文件）。

## 步骤

1. **看现状**：`cat ~/.zcode/zcode-vision.json`（不存在或 JSON 非法都按未初始化处理）。
   **配置已存在且合法时同样必须走完第 3 步提问**——不允许因为「已是推荐组合」就跳过：配置里的当前值作为各问题的默认答案标注出来，用户全部保持默认则零改动收尾。配置缺新版字段（如 compressThresholdKB）时正好借提问补齐。只有用户明确说「别问了直接保持现状」才可跳过。
2. **未初始化则生成模板**：python3 写入下面的默认结构（保持键顺序，2 空格缩进）：

```json
{
  "enabled": true,
  "chainMode": "fallback",
  "chain": ["glm-session", "glm-flash"],
  "proxies": [
    {
      "name": "glm-session",
      "useProvider": "session",
      "model": "glm-5.3-flash",
      "prompt": "请详细描述这张图片的全部内容。若是界面或图表截图，请先把所有错误、警告、异常状态逐字引用出来（含完整原文），再描述整体布局、文字与关键数据。"
    },
    {
      "name": "glm-flash",
      "baseUrl": "https://open.bigmodel.cn/api/anthropic",
      "model": "glm-5.3-flash",
      "apiKey": "",
      "format": "anthropic",
      "prompt": "请详细描述这张图片的全部内容。若是界面或图表截图，请先把所有错误、警告、异常状态逐字引用出来（含完整原文），再描述整体布局、文字与关键数据。"
    }
  ],
  "pollMs": 3000,
  "apiTimeoutMs": 60000,
  "compressThresholdKB": 1024
}
```

3. **问用户**（用 AskUserQuestion 一次问清，允许逐项跳过用默认）：
   - **跟随会话供应商（默认第一级）**：默认 `glm-session` 代理带 `"useProvider": "session"`——识别走**当前会话所用供应商**的 baseUrl、key、请求格式（`model` 仍用代理自己的），会话供应商失败时兜底到 `glm-flash` 直连。若会话供应商指向 headroom（BigModel-Max1/Max2 的 baseURL 就是 8787），跟随它即等于走 headroom，无需也无法再叠加 baseUrl。openai-responses 格式的供应商暂不支持（会报错并跳到下一级）。想固定跟随某个供应商改 `"useProvider": "<供应商名或ID>"`，想完全直连则删掉 useProvider 并自填 baseUrl/key。旧版未自定义的配置会在钩子首次加载时自动升级到本默认。
   - **识别模型**：默认 GLM `glm-5.3-flash`（两级代理同名同模型，`format` 由各自端点决定——glm-session 自动取供应商格式，glm-flash 为 `"anthropic"`）。换模型时两级一起改；都不合适时引导用户**选 Other 填写** baseUrl 与模型名。措辞一律用「选 Other 填写…」，**不要说「备注」**——选项界面没有备注入口，自由输入只能走 Other。
   - **API key**：默认留空自动获取（依次尝试环境变量 `GLM_API_KEY` → `~/.zcode/v2/config.json` 里 bigmodel 供应商的 key，默认即可用）。**不要引导用户在对话里粘贴 key**（会留在会话记录里）；确要显式配置，告知用户事后执行 `/vision-proxy edit <名称> apiKey=<key>` 或直接编辑 `~/.zcode/zcode-vision.json`。
   - **是否走本地 headroom**：只影响 `glm-flash` 直连兜底这一级——走则 baseUrl 改为 `http://127.0.0.1:8787`（format 按上游保持 anthropic；依赖 headroom 在运行——headroom 插件的 SessionStart 钩子会自动拉起）。会话供应商本身指向 headroom 时，`glm-session` 跟随它已等于走 headroom，这级无需再改。并说明：不走 headroom 时，识别文字注入后同样会随主模型请求被 headroom 压缩，这个选择只影响「识别调用本身」是否经代理。
   - **大图压缩阈值 compressThresholdKB**（可跳过用默认）：超过该大小（KB）的图先压缩再识别（最长边 2000、JPEG85）；上游限制原始图约 3.9MB/最长边 2000，大图不压会被拒或超时。默认 1024；0 = 不压缩（除非确认图片都很小，不推荐）。写入配置顶层，事后用 `/vision config compressThresholdKB=<值>` 调整。
   - baseUrl 只需给到 `/api/anthropic`、`/api/paas/v4` 这一层：`anthropic` 格式自动补 `/v1/messages`，`openai` 格式自动补 `/chat/completions`。
4. **写入**：python3 修改对应字段后 cat 确认。
5. **验证**：定位钩子脚本并运行测试（同 /vision test 的做法）：

```sh
node "$(ls -d ~/.zcode/cli/plugins/cache/duanluan-zcode-plugins/zcode-vision/*/hooks/vision-hook.mjs 2>/dev/null | head -1 || echo /home/njcm/workspaces/my/projects/zcode-plugins/plugins/zcode-vision/hooks/vision-hook.mjs)" --test
```

6. **收尾**：告诉用户后续管理命令（/vision-proxy 增删代理、/vision-chain 配链与模式、/vision status 看状态、/vision off 关闭），以及 zcode-pro 设置面板可图形化编辑同一配置。
