# zcode-plugins

ZCode 插件市场，市场名 `duanluan-zcode-plugins`。围绕 token 效率与代码质量：ZCode Vision 让纯文本模型也能读懂图片，Headroom 在请求层压缩对话历史，rtk 在源头压缩命令输出，OpenCodeReview 提供 Git 变更的行级代码评审。

## 插件一览

| 插件 | 版本 | 作用 | 命令（**加粗 = 装后必做**） |
|---|---|---|---|
| [ZCode Vision](plugins/zcode-vision/README.md) | 1.3.0 | 纯文本模型也能读图（默认跟随会话供应商） | **/vision-setup**、/vision-proxy、/vision-chain、/vision |
| [Headroom](plugins/headroom/README.md) | 1.1.0 | 请求层压缩，省对话 token；CPU/省电自动切换压缩设备 | **/hr-setup**、/hr-status、/hr-proxy、/hr |
| [rtk](plugins/rtk/README.md) | 1.2.0 | 命令输出源头压缩 60-90% | **/rtk-setup**、/rtk-status、/rtk |
| [OpenCodeReview](plugins/open-code-review/README.md) | 1.0.1 | Git 变更行级 AI 评审 | /ocr-delegate-review、/ocr-review、/ocr-scan、/ocr |

点击插件名进入该插件的完整文档（OpenCodeReview 无装后必做命令）。所有命令的菜单简介里都带用法示例；大部分参数原样透传给底层 CLI。

## 安装

前置：Git ≥ 2.41。命令行工具按需自动安装（ocr 缺失时自动 `npm i -g`；headroom、rtk 由各自的 setup 命令安装）。

1. ZCode → 插件市场 → 右上角「添加」→ 添加插件市场，填写 `duanluan/zcode-plugins`
2. 找到 **duanluan-zcode-plugins** 市场，安装需要的插件并启用
3. 先跑上表加粗的装后必做命令（headroom 还需在界面新建供应商，[见其文档](plugins/headroom/README.md)）

更新插件：市场源面板（搜索框上方齿轮）刷新 → 重装对应插件 → 新会话生效。

## 相关项目

- [zcode-pro](https://github.com/duanluan/zcode-pro)：ZCode 桌面版界面增强工具——项目自定义别名、切换文件夹、会话排序、文件菜单增强、界面样式微调与全局提示词等；不修改官方应用文件，退出后自动恢复。

## 交流与反馈

- QQ 群：**428403354**（[点击加入](https://qm.qq.com/q/WXuISJK3ug)）
- 微信群：添加微信 **ai4only** 邀请进群

<p>
  <img src="assets/qq-group.png" width="200" alt="QQ 群二维码" />
  &nbsp;&nbsp;
  <img src="assets/wechat-ai4only.png" width="200" alt="微信二维码（ai4only）" />
</p>
