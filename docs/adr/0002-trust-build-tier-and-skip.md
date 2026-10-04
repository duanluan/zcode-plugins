# ADR-0002：赠送额度级（trust-build）显式入链 + 连续失败自动跳过

- 状态：已采纳（2026-10-04）；同日更新：默认链暂撤 trust-build 级（见文末「更新」）
- 影响范围：plugins/zcode-vision（DEFAULT_CONFIG、runChain/askImage 的跳过逻辑、skipThresholdsOf 等）

## 背景

ZCode 每天赠送「ZCode Trust Build」额度（对应供应商 `builtin:bigmodel-start-plan`，只覆盖模型 `GLM-5.3-Flash`，当日有效）。用户希望视觉识别最优先消耗这笔免费额度，用完或失败再走别的识别端点。

两个现实约束：

1. 赠送额度级不一定能调通。实测（2026-10-04）：从插件直接请求 `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` 会被网关风控拦截（HTTP 405，`code 3012 "request has been blocked due to unusual activity"`）。原因是官方客户端每次发送都先跑阿里云验证（无感/滑动），把验证令牌放进请求头 `x-aliyun-captcha-verify-param` 才放行；插件是无人值守的后台进程，拿不到也**不应该**伪造验证令牌。这个拦截是服务端的反滥用策略，日后策略变化或官方开放可编程凭据时，这一级会自然生效。
2. 赠送额度当日会用尽，用尽后再调也是失败。如果每次都等它超时，识别会明显变慢。

## 决策

1. **赠送额度级显式进默认链的第一级**：默认模板改为三级 `["trust-build", "glm-session", "glm-flash"]`：
   - `trust-build`：`useProvider: "builtin:bigmodel-start-plan"`，模型 `GLM-5.3-Flash`（见 ADR-0001 映射表），单独 `timeoutMs: 10000`（10 秒短超时，失败快速降级，不拖累后面两级）。
   - `glm-session`：跟随当前会话供应商（识别模型走映射表）。
   - `glm-flash`：GLM 订阅（coding plan）Anthropic 兼容端点直连兜底。
2. **连续失败自动跳过**（全局可配）：某代理连续失败满 `skipAfterFailures` 次（默认 4）后，暂时跳过它 `skipMinutes` 分钟（默认 30），期间 fallback 直接走下一个；任一次成功即清零计数。显式配 `skipAfterFailures: 0` = 不跳过。跳过状态存在缓存文件 `~/.zcode/zcode-vision-cache.json` 里，钩子每次是新进程也能跨消息生效。
3. **旧配置自动升级**：v1（单 glm-flash）、v2（glm-session→glm-flash 两级）从未自定义过的默认配置，钩子首次加载时自动升级到三级默认；自定义过的配置一律不动。

## 后果

- 赠送额度可用时免费优先；不可用（风控拦截、额度用尽）时最多白等 4 次（每次约 1 秒的报错或 10 秒超时）就被跳过 30 分钟，日常识别几乎无感。
- zcode-pro 设置面板提供这两个参数的输入框（0 = 不跳过），以及「恢复默认链」按钮（只重置链模式与代理列表，带确认框）。
- 等待中的事实：网关风控是否会对无人值守请求长期关闭无法预知；若日后官方给出服务端可编程凭据（不需要验证令牌的调用方式），只需把 `trust-build` 条目的 `useProvider` 指向新凭据供应商即可，不用改结构。

## 更新（2026-10-04）

复测时网关仍然不放行（先是 405/3012 风控，后是 401），确认无人值守调用短期无望。应用户决定，**默认链暂撤 trust-build 级**：DEFAULT_CONFIG 与各文档/面板默认值改为两级 `["glm-session", "glm-flash"]`，向导问答里 trust-build 降为「可选、默认不启用」。连续失败跳过、单代理 `timeoutMs` 这些机制与映射表条目全部保留——日后网关开放时按上文「等待中的事实」加回一条代理即可。旧配置升级规则随之调整：v2 两级默认与现行默认一致、不再触发升级，仅 v1（单 glm-flash）自动补 glm-session 级。
