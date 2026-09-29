---
description: 视觉代理总入口：/vision（状态） ｜ /vision on|off ｜ /vision test [图片路径]。代理增删改用 /vision-proxy，链配置用 /vision-chain，首次安装用 /vision-setup。
argument-hint: <on|off|status|test> [图片路径]
allowed-tools: Bash(python3:*), Bash(node:*), Bash(cat:*), Bash(ls:*), Bash(head:*), Bash(command -v:*)
---

zcode-vision 插件管理入口。配置文件是唯一事实来源：`~/.zcode/zcode-vision.json`（zcode-pro 设置面板编辑的也是它）。`$ARGUMENTS` 第一个词是动作，缺省 `status`。

## 动作

### status（缺省）

用 python3 读 `~/.zcode/zcode-vision.json` 与 `~/.zcode/zcode-vision-cache.json`，向用户汇总：

- enabled、chainMode、chain 顺序
- 每个代理：名称、baseUrl、model、apiKey 是否已配（只显示「已配/未配」，不显示值）、prompt 前 40 字
- 缓存条目数；`~/.zcode-vision.log` 最后 5 行（存在时）
- 提醒：钩子读不到会话模型，有图片附件就会识别注入；关闭用 `/vision off`

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
