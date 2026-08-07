# Approx

简体中文 | [English](README.md)

Approx 是一个由 [Pi](https://github.com/earendil-works/pi) 驱动、优先适配
Windows 的编程智能体 TUI。它把持久化对话、模型控制、结构化提问和内置
Plan Mode 放进一个专注的终端工作区。

当前版本是早期公开测试版，正式验证环境为 Windows Terminal 与 PowerShell 7。

## 环境要求

- Windows 10 或 Windows 11
- Windows Terminal，或支持 24 位颜色和鼠标事件的终端
- PowerShell 7 或更高版本
- Node.js 22.19 或更高版本
- Pi 支持的模型服务账号或 API Key

检查当前版本：

```powershell
$ErrorActionPreference = 'Stop'
node --version
npm --version
```

## 安装

从 npm 安装公开测试版：

```powershell
$ErrorActionPreference = 'Stop'
npm install --global @bgtbeigulol-png/approx@beta
approx
```

也可以从源码安装：

```powershell
$ErrorActionPreference = 'Stop'
git clone https://github.com/bgtbeigulol-png/Approx.git
Set-Location -LiteralPath .\Approx
npm ci
npm start
```

## 首次运行

运行 `approx` 会直接启动真实的 Pi 智能体。如果 Pi 当前没有可用模型，Approx
会打开首次配置引导，帮助完成模型服务配置。已有的 Pi 登录信息和自定义服务会
被直接复用。

凭据始终由 Pi 管理并保存在 Pi 的用户配置目录中。Approx 不会把 API Key
复制到自身偏好、对话或项目文件。

从源码运行时，也可以打开 Pi 自带的服务商登录工具：

```powershell
$ErrorActionPreference = 'Stop'
npm run auth
```

在工具中输入 `/login`，选择服务商并完成认证，然后退出并重新运行 `npm start`。

## 使用

```powershell
$ErrorActionPreference = 'Stop'
approx                 # 启动实时 Pi 会话
approx --continue      # 继续当前目录最近一次会话
approx --no-splash     # 跳过启动动画
approx --scripted      # 运行离线界面演示
approx --help          # 显示命令行选项
```

Approx 会把启动命令所在目录作为智能体工作目录。

### 常用按键

| 按键 | 操作 |
| --- | --- |
| `Enter` | 发送 |
| `Shift+Enter` 或 `Ctrl+J` | 换行 |
| `Shift+Tab` | 切换 Go / Plan |
| `Ctrl+P` | 打开命令面板 |
| `Ctrl+O` | 打开设置 |
| `Ctrl+G` | 打开快速跳转 |
| `Ctrl+S` | 打开已保存对话 |
| `Ctrl+L` | 创建干净上下文 |
| `Esc` | 中止当前回复或关闭浮层 |
| `Ctrl+C` | 退出 |

在 Approx 内输入 `/help` 可查看完整命令与按键说明。

## Plan Mode

Go Mode 让智能体立即执行工作。Plan Mode 会先调查任务、收集结构化回答并展示
可见方案，在得到批准前不修改项目。按 `Y` 或 `Enter` 批准，按 `N` 要求修改。

Plan 面板与对话一起保存；方案获批后，它会继续显示执行 Todo 的真实状态。

## 常见问题

**系统找不到 `approx`**

全局安装完成后重启终端，并确认 npm 的全局可执行目录已经加入 `PATH`：

```powershell
$ErrorActionPreference = 'Stop'
npm prefix --global
Get-Command approx
```

**没有可用模型**

完成首次配置引导，或在源码目录运行 Pi 登录工具。已有 Pi 安装的用户应先确认
Pi 自身可以列出模型，再启动 Approx。

**提示 stdout 不是 TTY**

请在 Windows Terminal 中直接运行 Approx，不要把输出重定向到文件或管道。

**界面显示错位**

使用支持 UTF-8、Unicode 方框字符、24 位颜色和鼠标事件的较新终端。当前支持
基线是 Windows Terminal。

## 隐私

模型请求、认证、会话、工具和服务商配置均由 Pi 处理。请同时阅读所选模型服务
的使用条款与数据政策。不要把 `.pi`、`.claude`、`.env`、日志或凭据文件提交
到项目仓库。

## 许可证

[MIT](LICENSE)
