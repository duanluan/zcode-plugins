---
description: 视觉代理总入口：/vision（状态） ｜ /vision on|off ｜ /vision config <键>[=值] ｜ /vision test [图片路径]。代理增删改用 /vision-proxy，链配置用 /vision-chain，首次安装用 /vision-setup。
argument-hint: <on|off|status|config|test> [键[=值] | 图片路径]
allowed-tools: Bash(python3:*), Bash(node:*), Bash(cat:*), Bash(ls:*), Bash(head:*), Bash(command -v:*)
---

zcode-vision 插件管理入口。配置文件是唯一事实来源：`~/.zcode/zcode-vision.json`（zcode-pro 设置面板编辑的也是它）。`$ARGUMENTS` 第一个词是动作，缺省 `status`。

## 动作

### status（缺省）

用 python3 读 `~/.zcode/zcode-vision.json` 与 `~/.zcode/zcode-vision-cache.json`，向用户汇总：

- enabled、interceptMode（tool=识别结果卡片可见 / inject=后台静默注入）、chainMode、chain 顺序、forceIntercept（vision 类主模型能看图时的策略：缺省=自动，见下表）、compressThresholdKB（大图压缩阈值 KB，0 = 不压缩，可用 `/vision config compressThresholdKB=值` 修改）
- 主模型判定：运行 `node <钩子脚本> --decision "<当前会话模型，providerId/modelId 格式>"`（钩子脚本定位方法同 test 一节），把输出里的模型类别（kind）、宿主图片开关（inline）、forceIntercept、结果（skip）与原因（reason）转述给用户。skip=true 说明模型自看不指路；skip=false 说明会走识别代理（tool 模式指路 vision_ask、有卡片，inject 模式后台注入）
- 每个代理：名称、baseUrl 或 useProvider（跟随谁）、model、apiKey 是否已配（只显示「已配/未配」，不显示值）、prompt 前 40 字
- 缓存条目数；`~/.zcode-vision.log` 最后 5 行（存在时）
- 提醒：主模型是 flash 小模型（glm-5.3-flash / mimo-v2.6-flash 等）时自动跳过识别——识别就是它自己；vision 类主模型跟随宿主「模型设置」的图片开关：开 = 模型自看不重复识别，关 = 走识别（tool 模式经 vision_ask、有识别卡片，inject 模式后台注入）。想让能看图的模型也强制走识别代理（接受双重识别）设 `/vision config forceIntercept=true`。关闭插件用 `/vision off`

### config <键>[=值]

顶层运行参数的查看与设置（代理级字段走 `/vision-proxy edit`，不在此处）。可管理的键：

| 键 | 含义 | 默认 | 范围 |
|---|---|---|---|
| `interceptMode` | 拦截模式：tool = 钩子只注入指路文本，识别由模型调 vision_ask 完成，结果卡片对用户可见（默认）；inject = 后台预跑识别并把全文注入上下文（用户看不到识别文字，快、省一次模型往返） | tool | tool / inject |
| `forceIntercept` | vision 类主模型能看图时的策略：**缺省（不写该键）= 自动**——跟随宿主「模型设置」里该模型的图片开关（开 = 模型自看不指路，关 = 必走识别，tool 模式经 vision_ask）；`true` = 能看图也强制拦截（模型自看一遍 + 识别代理一遍的双重识别，换识别卡片）；`false` = 能看图就不拦截（图片开关关着的模型不受影响，仍必拦截——看不见图时指路只有好处） | 自动（未设置） | true / false；恢复自动需从配置文件删掉该键 |
| `compressThresholdKB` | 大图压缩阈值 KB：超过先压缩再识别（最长边 2000、JPEG85）；0 = 不压缩 | 1024 | 0–102400 |
| `cardUi` | 识图卡片总开关：false = 识别结果不挂卡片、按纯文本展示。默认关（纯插件安装稳妥优先）；装了 zcode-pro 会自动补 true 开卡（其沙箱回收与失败卡自动重试可应对 64 名额上限） | false | true / false |
| `cardSandboxBudget` | 识图卡片沙箱名额预算：活卡数达到预算时，新的识别结果退回纯文本（不挂卡片），名额空出（卡片关闭/页面退场）后自动恢复；0 = 不限。默认 63＝宿主上限 64 减一，常备一个空位 | 63 | 0–64 |
| `pollMs` | 等内联图片落盘的最长时间（毫秒） | 3000 | 0–60000 |
| `apiTimeoutMs` | 单次视觉调用超时（毫秒；视觉模型冷启动可能近 2 分钟，别设太短） | 120000 | 1000–600000 |

- `/vision config`（不带键）：列出各键的当前值
- `/vision config compressThresholdKB`：显示该键当前值与含义
- `/vision config compressThresholdKB=512`：python3 校验范围后写入 `~/.zcode/zcode-vision.json` 顶层并 cat 确认，告诉用户立即生效（下一条带图消息/追问即用新值；压缩阈值变化不影响已缓存条目，缓存键用压缩后字节）
- `/vision config forceIntercept=false`：布尔键只接受 true/false（true = 主模型能看图也照常拦截、交给视觉代理识别，会双重识别；false = 能看图就不拦截）。恢复自动（跟随模型设置图片开关）需用 python3 从 `~/.zcode/zcode-vision.json` 删掉 forceIntercept 键
- 非法值（越界/非数字）说明原因并拒绝写入

### on / off

python3 改 `enabled` 为 true/false 后 cat 确认，并告诉用户当前状态。off 后钩子完全静默放行。

### test [图片路径]

跑通整条识别链。先定位钩子脚本（按顺序找第一个存在的）：

```sh
ls -d ~/.zcode/cli/plugins/cache/duanluan-zcode-plugins/zcode-vision/*/hooks/vision-hook.mjs 2>/dev/null | head -1
```

都没有则用源码仓库 `/home/njcm/workspaces/my/projects/zcode/zcode-plugins/ui-plugins/zcode-vision/hooks/vision-hook.mjs`。然后：

```sh
node <钩子脚本> --test [图片路径]
```

不给路径时自动取最近会话目录里最新的一张图。把「测试图片、链、所用代理、耗时、识别结果」原样转述给用户；失败则给出原因和下一步建议（检查 apiKey / baseUrl，或 /vision-setup 重配）。
