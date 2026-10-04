# ADR-0001：跟随供应商时用「首选视觉模型」映射表选识别模型

- 状态：已采纳（2026-10-04）
- 影响范围：plugins/zcode-vision（hooks/vision-lib.mjs 的 PREFERRED_VISION_MODELS / preferredModelOf）

## 背景

视觉代理的「跟随供应商」条目（`useProvider: "session"` 或指定供应商）会自动取该供应商的接口地址、API Key、请求格式，但识别模型原来固定用条目里的 `model` 字段。这带来两个问题：

1. 会话用 Xiaomi MiMo（主模型 mimo-v2.6-pro）时，代理条目里写的 `glm-5.3-flash` 会被原样发给小米接口，报「不支持的模型」直接失败。
2. ZCode Trust Build 赠送额度只覆盖 `GLM-5.3-Flash` 这一个模型，写死别的模型名同样失败。

用户期望：跟随某个供应商时，自动挑一个「便宜、够用、确实在该供应商模型列表里」的视觉小模型。

## 决策

在 vision-lib.mjs 里放一张静态映射表（按供应商 id/名称正则匹配），跟随供应商解析成功后优先代入映射的模型名：

| 供应商（匹配规则） | 映射的识别模型 |
| --- | --- |
| `xiaomi-mimo` / `Xiaomi MiMo` | `mimo-v2.6-flash` |
| `builtin:bigmodel-start-plan`（Trust Build 赠送额度） | `GLM-5.3-Flash` |
| `builtin:bigmodel*` / `builtin:zai*` / `BigModel*` / `Z.ai*` | `glm-5.3-flash` |

代入前把大小写归一到该供应商模型列表里的精确写法（列表来自 `~/.zcode/v2/config.json` 的 `models` 与 `provider_config.json` 规则表的模型名）。映射没命中、或该供应商列表里没有这个模型时，返回空、回退用代理条目自己的 `model` 字段（保持旧行为）。

## 后果

- Xiaomi MiMo 会话下识别自动走 mimo-v2.6-flash，Trust Build 级自动用 GLM-5.3-Flash，开箱即用。
- 映射表是静态的：新供应商想换识别模型，要么等插件更新加规则，要么把条目 `model` 字段改成想要的（映射未命中时生效），或用 `/vision-proxy edit` 显式改。
- 「该供应商列表里没有这个模型就不代入」这条保底规则，避免映射把一个不存在的模型名硬塞给小众供应商导致失败。
- 配套的失败降级不变：fallback（依次尝试）模式下映射模型调用失败会自动试链上的下一级。
