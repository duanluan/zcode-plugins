---
description: 配置视觉代理链：/vision-chain show ｜ set <代理1,代理2,…> [mode=fallback|pipeline]。fallback=依次尝试到成功为止；pipeline=逐级加工（描述→校对→提炼，后一步可引用 {prev}）。
argument-hint: <show|set> [代理名逗号列表] [mode=fallback|pipeline]
allowed-tools: Bash(python3:*), Bash(cat:*)
---

配置 `~/.zcode/zcode-vision.json` 的 `chain`（执行顺序）与 `chainMode`（与 zcode-pro 设置面板编辑同一文件）。`$ARGUMENTS`：动作，set 时再给逗号分隔的代理名列表和可选 `mode=`。用 python3 修改，改完 cat 确认。

## 动作

### show（缺省）

打印 chainMode、chain 顺序及每个位置的代理是否存在（不存在的名称标红提示用 /vision-proxy add 补上或从链中移除），并列出所有可用代理名。

### set <a,b,c> [mode=fallback|pipeline]

- 名称必须都已定义（否则报错并列出现有名）；顺序即执行顺序。
- `mode=fallback`：前一个失败（网络/HTTP 错/空结果）才试下一个，任一成功即止——常用「主力 + 备用」。
- `mode=pipeline`：每一步都执行，后一步拿到前一步结果：prompt 含 `{prev}` 则替换为其内容，否则前一步结果拼接在 prompt 之后；图片只发给第一步——常用「描述 → 校对/提炼」。
- 不给 mode 时保持原值；给 chain 只有一个代理时两种 mode 行为等价。

## 提醒

链（顺序/模式/代理的 baseUrl、model、prompt）任何变化都会改变缓存指纹，同图会重新识别——这是预期行为，不是 bug。改完建议 `/vision test` 验证。
