---
description: 视觉代理总入口：/vision（状态） ｜ /vision on|off ｜ /vision config <键>[=值] ｜ /vision test [图片路径]。代理增删改用 /vision-proxy，链配置用 /vision-chain，首次安装用 /vision-setup。
argument-hint: <on|off|status|config|test> [键[=值] | 图片路径]
allowed-tools: Bash(python3:*), Bash(node:*), Bash(cat:*), Bash(ls:*), Bash(head:*), Bash(command -v:*)
---

zcode-vision 插件管理入口。配置文件是唯一事实来源：`~/.zcode/zcode-vision.json`（zcode-pro 设置面板编辑的也是它）。`$ARGUMENTS` 第一个词是动作，缺省 `status`。

## 动作

### status（缺省）

用 python3 读 `~/.zcode/zcode-vision.json` 与 `~/.zcode/zcode-vision-cache.json`，向用户汇总：

- enabled、chainMode、chain 顺序、compressThresholdKB（大图压缩阈值 KB，0 = 不压缩，可用 `/vision config compressThresholdKB=值` 修改）
- 每个代理：名称、baseUrl 或 useProvider（跟随谁）、model、apiKey 是否已配（只显示「已配/未配」，不显示值）、prompt 前 40 字
- 缓存条目数；`~/.zcode-vision.log` 最后 5 行（存在时）
- 提醒：钩子读不到会话模型，有图片附件就会识别注入；关闭用 `/vision off`

### config <键>[=值]

顶层运行参数的查看与设置（代理级字段走 `/vision-proxy edit`，不在此处）。可管理的键：

| 键 | 含义 | 默认 | 范围 |
|---|---|---|---|
| `compressThresholdKB` | 大图压缩阈值 KB：超过先压缩再识别（最长边 2000、JPEG85）；0 = 不压缩 | 1024 | 0–102400 |
| `pollMs` | 等内联图片落盘的最长时间（毫秒） | 3000 | 0–60000 |
| `apiTimeoutMs` | 单次视觉调用超时（毫秒） | 60000 | 1000–600000 |

- `/vision config`（不带键）：列出三个键的当前值
- `/vision config compressThresholdKB`：显示该键当前值与含义
- `/vision config compressThresholdKB=512`：python3 校验范围后写入 `~/.zcode/zcode-vision.json` 顶层并 cat 确认，告诉用户立即生效（下一条带图消息/追问即用新值；压缩阈值变化不影响已缓存条目，缓存键用压缩后字节）
- 非法值（越界/非数字）说明原因并拒绝写入

### on / off

python3 改 `enabled` 为 true/false 后 cat 确认，并告诉用户当前状态。off 后钩子完全静默放行。

### test [图片路径]

跑通整条识别链。先定位钩子脚本（按顺序找第一个存在的）：

```sh
ls -d ~/.zcode/cli/plugins/cache/duanluan-zcode-plugins/zcode-vision/*/hooks/vision-hook.mjs 2>/dev/null | head -1
```

都没有则用源码仓库 `/home/njcm/workspaces/my/projects/zcode-plugins/plugins/zcode-vision/hooks/vision-hook.mjs`。然后：

```sh
node <钩子脚本> --test [图片路径]
```

不给路径时自动取最近会话目录里最新的一张图。把「测试图片、链、所用代理、耗时、识别结果」原样转述给用户；失败则给出原因和下一步建议（检查 apiKey / baseUrl，或 /vision-setup 重配）。
