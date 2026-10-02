<div align="center">
  <img src="assets/llamarig.ico" width="88" alt="Llama Rig logo" />

  <h1>Llama Rig</h1>

  <p>
    本地多引擎 LLM 推理控制台 — 一键切换 llama.cpp / KVMem / PrismML，显存守卫防爆显存。
    <br />
    启动服务、配置模型、查看日志、直接聊天和接入 OpenAI Compatible 客户端，都放在一个窗口里。
  </p>

  <p>
    <img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%2F%2011-506f51?style=flat-square" />
    <img alt="Electron" src="https://img.shields.io/badge/Electron-41-506f51?style=flat-square" />
    <img alt="llama.cpp" src="https://img.shields.io/badge/llama.cpp-local-506f51?style=flat-square" />
    <img alt="License" src="https://img.shields.io/badge/license-MIT-151713?style=flat-square" />
  </p>
</div>

![Llama Rig preview](docs/desktop-preview.svg)

## 亮点

| 功能 | 说明 |
| --- | --- |
| 稳定预设生成 | 拿到陌生模型不用猜参数：读它自己的 GGUF 头部（层数、训练上下文、KV 头数）加本机真实显存，算出一份「一定能起来」的预设，并把每条依据摊开给你看 |
| 本地直连 | 直接启动 llama.cpp 原版目录里的 `llama-server.exe`，不强依赖额外启动器 |
| OpenAI 兼容 | 默认提供 `http://127.0.0.1:8080/v1`，可接入 OpenClaw、Claude Code 等客户端 |
| 桌面聊天 | 内置网页端风格聊天页面，支持流式回复、历史对话、搜索和消息操作 |
| 附件入口 | 支持图片、文本、PDF 等附件入口，图片可在聊天里预览 |
| 模型信息 | 点击模型标签即可查看当前模型、上下文、GPU 层数和运行参数 |
| 终端日志 | 在客户端里查看 llama.cpp 输出，方便排查启动和推理问题 |
| 托盘后台 | 关闭窗口后隐藏到系统托盘，服务继续后台运行 |
| 参数配置 | 支持模型路径、上下文、采样、GPU 层数、线程和批处理参数 |

## 下载

发布包放在 GitHub Releases 页面：

[打开 Releases](https://github.com/Ye-wtw/Llama-Rig/releases)

下载 `Llama-Rig-<版本号>.exe`（如 `Llama-Rig-0.8.1.exe`）后双击运行即可。项目本身不包含模型文件和 llama.cpp 二进制文件，需要你本机已经有可用的 llama.cpp Windows 构建目录。

> 首次运行会看到 Windows SmartScreen 的蓝色提示（因为安装包没有购买代码签名证书），
> 点「更多信息」→「仍要运行」即可。

## 快速开始

1. 下载并打开 `Llama-Rig-<版本号>.exe`。
2. 在设置里选择 llama.cpp 原文件目录，或直接选择 `llama-server.exe`。
3. 选择你的 GGUF 模型文件。
4. 保存配置并启动服务。
5. 使用内置聊天，或把 `http://127.0.0.1:8080/v1` 接入 OpenAI 兼容客户端。

## 数据放在哪（便携版）

这个软件是**完全便携**的：所有数据都生成在 **exe 所在的文件夹**里，
不写 `%APPDATA%`，也不写注册表。

所以首次双击运行后，你会看到 exe 旁边自动多出文件夹：

```text
你放 exe 的文件夹\
├── Llama-Rig-0.8.1.exe     ← 程序本体
├── configs\                ← 【预设目录】首次运行会自动放入一个示例预设
│   └── 示例-通用参数.config.toml
├── config.toml             ← 主设置（llama.cpp 路径、模型路径等），保存设置后生成
├── desktop-state.json      ← 窗口位置、界面状态，运行后生成
└── userdata\               ← 界面缓存（浏览器内核的 profile，删掉会自动重建）
```

### 预设存放位置与用法

**预设就存在 exe 旁边的 `configs\` 文件夹里**，一个预设对应一个 `.config.toml` 文件。

| 你想做的事 | 怎么做 |
| --- | --- |
| 用自带示例 | 首次运行后列表里就有 `示例-通用参数`，可直接套用 |
| 自己存一个 | 在界面里调好参数后保存为预设，文件会出现在 `configs\` |
| 备份预设 | 复制整个 `configs\` 文件夹 |
| 换台机器 / 重装 | 把 `configs\` 拷到新位置 exe 旁边即可 |
| 收下别人的预设 | 让对方把 `.config.toml` 发给你，放进 `configs\` |

关于自带的那个示例预设，有一点值得说明：它**只含参数、不含路径**
（`model` 和 `llama_server_path` 都是空的）。空路径的含义是「沿用你当前的选择」，
不会把你已经选好的模型或 llama.cpp 路径清空 —— 所以它可以安全地当作调节参数的起点。

### 想换地方放 / 想清理

- **整个文件夹可以随意移动、复制到 U 盘**，因为数据跟着 exe 走，路径不写死。
- ⚠️ **删除 `configs\` 会连你的预设一起删掉**，删之前先备份。
- `userdata\` 可以随时删除，下次启动会自动重建（只是会丢失界面缓存）。

## 开发运行

```powershell
npm install
npm start
```

## 打包

```powershell
npm run dist
```

打包产物会生成在 `dist/`，该目录不会提交到 Git。

## 当前限制 / Roadmap

- 当前主要面向 Windows 10 / 11。Ubuntu、macOS 等跨平台版本需要继续适配路径、进程管理、托盘和打包配置。
- 项目不内置 llama.cpp、模型文件、显卡驱动或 CUDA / Vulkan 运行库，需要用户本机已有可用环境。
- 图片入口可以预览并发送图片，但真正理解图片需要视觉模型和对应的 `mmproj` 多模态投影文件。
- 普通文本模型不能因为上传了图片就自动具备看图能力；视频理解当前暂未支持。
- ngram、多 GPU、speculative decoding 等高级能力可以先通过“自定义附加参数”传给本机 `llama-server`，具体是否生效取决于本地 llama.cpp 版本。
- 如果桌面端速度和原生命令行差异明显，请先复制“最终启动命令”，对比 GPU layers、上下文、batch、ubatch、threads 等参数。
- Qwen 等 thinking 模型是否输出 `<think>` 内容取决于模型、模板和 `chat_template_kwargs`；桌面端会解析并折叠展示返回中的 `<think>...</think>`。

## 项目结构

```text
assets/            图标和托盘图标
desktop/           Electron 主进程、预加载脚本与纯逻辑模块
  configs/         随包示例预设（首次运行时播种到用户目录）
  lib/             预设策略、日志管线、运行期策略等纯逻辑
renderer/          桌面端界面
test/              测试（node --test）
tools/             界面文案扫描工具
spec/ docs/        设计规格与验收记录
prototype/         早期界面原型（静态 HTML，供对照）
scripts/           图标生成脚本
```

## 开源说明

本仓库只包含桌面端源码，不包含：

- llama.cpp 二进制文件
- GGUF / GGML 模型文件
- 打包生成的 exe
- 本地配置文件和运行日志

## License

MIT
