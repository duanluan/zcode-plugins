# zcode-plugins

ZCode 插件市场，市场名 `duanluan-zcode-plugins`。围绕 token 效率与代码质量：ZCode Vision 让纯文本模型也能读懂图片，Headroom 在请求层压缩对话历史，rtk 在源头压缩命令输出，OpenCodeReview 提供 Git 变更的行级代码评审。

## ✨ 插件一览

| 插件 | 版本 | 作用 | 命令（**加粗 = 装后必做**） |
|---|---|---|---|
| [ZCode Vision](plugins/zcode-vision/README.md) | 1.7.2 | 纯文本模型也能读图（默认跟随会话供应商与其当前模型；识别结果以卡片展示，默认收起） | **/vision-setup**、/vision-proxy、/vision-chain、/vision |
| [Headroom](plugins/headroom/README.md) | 1.3.0 | 请求层压缩，省对话 token；任意供应商可接入（/hr-join），CPU/省电自动切换压缩设备 | **/hr-setup**、/hr-join、/hr-status、/hr-proxy、/hr |
| [rtk](plugins/rtk/README.md) | 1.4.0 | 命令输出源头压缩 60-90%，压缩记录面板可查被省略的输出 | **/rtk-setup**、/rtk-status、/rtk |
| [OpenCodeReview](plugins/open-code-review/README.md) | 1.2.0 | Git 变更行级 AI 评审，结果面板可勾选处理 | **/ocr-setup**、/ocr-delegate-review、/ocr-review、/ocr-scan、/ocr |

点击插件名进入该插件的完整文档。四插件均带 ZCode ≥ 3.15.1 桌面端的交互页面（识图卡片、压缩记录、输出查看、评审面板），旧版客户端自动退回纯文本行为。所有命令的菜单简介里都带用法示例；大部分参数原样传给底层命令行工具。

## 🗂️ 仓库结构（对齐上游 zcode-plugins）

- `ui-plugins/<名>/`：插件源码（钩子、命令、技能、MCP 服务、页面源码），开发只改这里
- `plugins/<名>/`：构建产物，安装与市场分发的就是它；`pnpm build` 从源码组装生成，不手改
- 版本号三处保持一致：根 `marketplace.json`、`ui-plugins/<名>/.zcode-plugin/plugin.json`、`ui-plugins/<名>/package.json`

本地开发循环：改 `ui-plugins/` → `pnpm build` → `scripts/install-plugin-local.sh <名>` → 开新会话验证（详见 [AGENTS.md](AGENTS.md)）。

## 📦 安装

前置：Git ≥ 2.41。命令行工具按需安装（ocr、headroom、rtk 由各自的 setup 命令安装）。

1. ZCode → 插件市场 → 右上角「添加」→ 添加插件市场，填写 `duanluan/zcode-plugins`
2. 找到 **duanluan-zcode-plugins** 市场，安装需要的插件并启用
3. 先跑上表加粗的装后必做命令（headroom 的供应商接入由 /hr-setup 自动完成，界面手建只是回退，[见其文档](plugins/headroom/README.md)）

更新插件：市场源面板（搜索框上方齿轮）刷新 → 重装对应插件 → 新会话生效。

## ⚙️ 图形化设置

插件的图形化设置页面在 [zcode-pro](https://github.com/duanluan/zcode-pro) 中：用「ZCode Pro」启动 ZCode 后，右键点击 ZCode 侧边栏底部的设置按钮（齿轮）即可打开设置窗口，可视化管理视觉代理（zcode-vision）、rtk 压缩、Headroom 等插件项，以及一键检查并更新本市场插件。不装 zcode-pro 也能用各插件的命令和配置文件完成同样的设置。

ZCode Pro 还是 ZCode 桌面版的界面增强工具，另有项目自定义别名、切换文件夹、会话拖动排序与快捷切换、文件菜单增强、复制图片、界面样式微调、全局提示词等功能；不修改客户端文件，通过 ZCode Pro 快捷方式启动即可。

## 💬 交流与反馈

- QQ 群：**428403354**（[点击加入](https://qm.qq.com/q/WXuISJK3ug)）
- 微信群：添加微信 **ai4only** 邀请进群

<p>
  <img src="assets/qq-group.png" width="200" alt="QQ 群二维码" />
  &nbsp;&nbsp;
  <img src="assets/wechat-ai4only.png" width="200" alt="微信二维码（ai4only）" />
</p>
