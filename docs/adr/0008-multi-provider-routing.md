# ADR-0008：多供应商压缩路由——统一端口按 key 哈希路由

- 状态：已采纳（2026-10-17）
- 影响范围：headroom 插件（hooks/hr-multi.mjs、ensure-proxy.mjs 分发、headroom-lib.mjs 配置读写、commands/hr-join.md）

## 背景

headroom 代理一个实例只支持一个上游。此前插件只管理"GLM anthropic"一条代理：要走压缩，供应商 baseUrl 必须指向 8787，且上游固定 GLM——用户的其他供应商（Xiaomi MiMo、各中转站）无法享受压缩。用户希望任意供应商都能接入，且不想在插件侧重复配置 key。

## 决策

1. **统一入口 + 按 key 路由**：所有接入的供应商 baseUrl 统一改为路由端口（默认 8787）。路由器（hooks/hr-multi.mjs 的 `--serve` 模式，零依赖 Node）从请求头取 API key（`Authorization: Bearer` 或 `x-api-key`），按 sha256 哈希匹配供应商映射，转发到对应 headroom 实例；匹配不到返回 502 引导文案。key 明文不落配置，只存哈希。
2. **实例按"格式+上游"分组共享**：同一 (format, upstream) 的多个供应商共用一个 headroom 实例（内部端口 28790 起；879x 段实测会被 IDE 的 Java 进程占用）。上游用 CLI 参数显式指定（`--openai-api-url` / `--anthropic-api-url`）。
3. **鉴权透传**：headroom 把客户端的供应商凭据原样转发上游（源码 server.py scrub_proxy_token_headers：非代理令牌的 Authorization 一律放行），插件与 headroom 均不存储、不替换 key。
4. **幂等与端口安全**：实例复用条件 = 状态文件登记 pid 存活且端口健康；端口分配前用试绑定（canBind）探测，被陌生进程占用即跳下一个，不再只看"端口有应答"（曾因此把流量转给过占用 8790 的 Java 进程）。
5. **接入与还原**：`/hr-join` 从 ZCode 供应商配置自动读上游 URL 与格式，记录 `origBaseURL` 后把 baseUrl 改为 8787；`/hr-join off` 还原。旧 GLM 单实例代理（providers 未配置）原样保留，首次接入时停旧实例、路由器接管 8787。
6. **兼容性边界**：anthropic 格式任意上游形态可用；openai 格式要求上游是 /v1 形态（headroom 固定拼 `<base>/v1/chat/completions`，base 末尾 /v1 会被剥掉重拼）。GLM 官方 openai 接口（/api/paas/v4）不兼容，GLM 供应商用 anthropic 地址接入。

## 踩过的坑（写给后来人）

- **不要传 `--backend openai`**：默认 passthrough 会按鉴权风格自动选 anthropic/openai 上游并尊重 URL 覆盖；传了 `--backend openai` 会覆写成 litellm 的 openai 提供者，无视自定义 URL 直连 api.openai.com（国内网络即 Connection error）。
- **端口探测 ≠ 实例身份**：只探"端口有 HTTP 应答"会把陌生进程当成自己的实例；必须 pid 登记 + 试绑定。
- **停旧代理会误伤真机**：ensure 自动恢复逻辑里的停旧单实例命令执行的是真机的停代理命令（按真机状态文件登记 pid 杀进程），自测时在别的端口上触发，会把真机 8787 正在服务的实例杀掉（2026-10-17 实测踩过，用户请求直接 ECONNREFUSED）。现在两道闸：自测模式（HR_HEADROOM_CONFIG）下停旧代理是空操作；只有路由器端口就是旧代理端口（8787）才允许停旧代理接管。
- **自测端口不能和真机同段**：实例端口起始值在自测模式下要错开（38790），否则测试实例会抢走真机实例的端口、测试 stop 会杀到真机进程。
- **提前 return 会把实例 pid 丢在内存里**：路由器接管失败的退出路径必须先把实例 pid 写进状态文件再退，否则 stop 按状态文件找不到刚拉起的实例，就成了杀不掉的孤儿进程。
- **整文件重写配置会丢键**：headroom.json 现在承载 providers/router/instances，任何"重写整文件"的配置写入都必须保留未知键；只写自己认识的三个键会把 hr-join 注册的供应商映射整个抹掉（接入后跑一次 backend/power 设置就全部供应商断流）。两侧实现都改了：sh 版 hr_config_set 原是 printf 三键整覆盖（改 python3 读旧合并），mjs 版 configSet 同步改。
- **路由表不能只在启动时建**：路由器启动时一次性构建 keyHash→端口映射的话，/hr-join 追加第二个供应商后它的 key 一律 502"未接入"；改为每个请求重读配置（文件只有几 KB）。
- **分发层要放行设置类动作**：providers 非空时把 backend/power 一并转给 hr-multi，会因动作名不认识被打"用法"错误退出——这两个动作在 ensure-proxy.mjs 分发层单独处理（backend：写配置 + hr-multi restart；power：仅写配置，多实例模式下监视器不自动重启实例）。
- **多实例模式下的电源监视器与 systemd**：两个 power-watch 都有"非插件管理即退出"的闸，多实例模式下没有旧状态文件会自己退出（不会误停路由器）；但迁移前必须禁用旧的 headroom-proxy systemd 单元，否则单元的自动重启会反复抢 8787。
- **pgrep/pkill 模式自匹配**：Bash 工具的包装 shell 命令行里含命令文本本身，`pgrep -f '<模式>'` 会匹配到包装进程（本日三次：杀掉自己的 shell、两次误报实例 pid 变化）。判活用 `[x]` 方括号写法，或直接按 pid 操作。
- **接入后地址失去协议线索**：baseUrl 改成 127.0.0.1:8787 后，一切"按地址推断协议"的代码都会失效——实测视觉代理把 mimo 的识别请求按 openai 打到错误端点（连续失败进入跳过期），zcode-pro 面板把推不出协议的供应商从下拉列表过滤掉、保存的旧值显示"（已删除）"。两个配套：接入时给 providerRules 补写 api.type；读侧再查 headroom.json 注册表兜底（vision 插件与 zcode-pro helper 都做了）。

## 后果

- 任意供应商可接入压缩（/v1 形态 openai 与全部 anthropic），key 零重复配置；压缩节省按实例分账（savings 事件的 pid/model 可区分来源）。
- 路由器是新增单点：它挂了所有接入供应商同时不可用；ensure 钩子每会话拉起自动恢复，502 文案给出修复指引。
- 与 zcode-pro 面板的集成（图形化接入/还原）留待后续。
