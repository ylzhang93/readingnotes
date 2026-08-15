# texnote-reader

在浏览器里阅读 PDF，选中一句话 → 提问 → 让 LLM 生成解释，自动以 `readingnote` 环境写回 `.tex` 并重新编译。

- 一个**文件夹 = 一个笔记本**，笔记持久化在 `文档/.texnote/notebook.json`（随文件夹走，重开仍有记忆）。
- 支持**多文件 LaTeX 项目**：`\usepackage{readingnote}` 只加到主文件，笔记写回 synctex 定位到的真实子文件，最后编译主文件。
- **缓存友好**：把「文档骨架 + 全部历史 Q&A」作为稳定前缀发给模型，DeepSeek 前缀缓存命中率高（实测 ~99%）。
- 可切换 **LLM provider**（网页右上角下拉框）。

## 前置要求

- [Node.js](https://nodejs.org)（18+，内置 `fetch`）
- TeX Live（`latexmk`、`synctex`、`kpsewhich` 需在 PATH 中）
- 一个 OpenAI 兼容的 LLM API key

## 安装

```powershell
# 1) 一次性初始化（可选：vendor 已提交，若缺失会 npm install 并拷贝；安装 readingnote.sty 到 texmf-local 并 texhash）
powershell -ExecutionPolicy Bypass -File setup.ps1

# 2) 写 API key：复制模板并填 key
copy config.example.json config.json
#   编辑 config.json，把 "PASTE_YOUR_API_KEY_HERE" 换成你的 key
```

> **API key 写在哪里？** 在 `config.json` 的 `providers.<name>.apiKey` 字段里。该文件已被 `.gitignore` 忽略，不会上传。
> 也可用环境变量 `DEEPSEEK_API_KEY`，或 deepseek 官方用 `credentialsFile` 指向一个 `DEEPSEEK_API_KEY: xxx` 的 yaml。

## 启动

```powershell
node server.js
```

浏览器打开 **http://127.0.0.1:8910**。

## 使用流程

1. 顶栏「Open folder」粘贴一个含 `.tex` 的文件夹路径 → 打开（自动识别主文件并编译）。
2. 在 PDF 中**选中一句话** → 弹出带 `→` 的文本框。
3. 输入问题（中文/英文皆可，标题与正文会以英文生成）→ 回车或点 `→`。
4. 自动：生成解释 → 写入 `readingnote` → `latexmk` 重编译 → PDF 刷新。

弹框内可开关：
- `🧠 thinking`：是否先推理（cstcloud 对长提示词会超时，建议关闭；deepseek 官方可用）。
- `✍️ write .tex`：关闭则只存笔记本、不写 tex、不编译。

## 配置说明（config.json）

```jsonc
{
  "port": 8910,
  "activeProvider": "deepseek",     // 当前使用的 provider
  "providers": {
    "deepseek": {                    // OpenAI 兼容接口示例（deepseek 官方）
      "baseURL": "https://api.deepseek.com",
      "model": "deepseek-v4-flash",
      "apiKey": "PASTE_YOUR_API_KEY_HERE",
      "maxOutputTokens": 8000
    }
    // 可再加一个 provider，例如你的自建/其它兼容服务：
    // "myapi": {
    //   "baseURL": "https://your.host/v1",
    //   "model": "some-model",
    //   "apiKey": "YOUR_KEY",
    //   "maxOutputTokens": 8000
    // }
  }
}
```

- `cstcloud` 这类 provider 按同样结构加进 `providers` 即可，网页右上角下拉框会自动出现。
- 切换 provider：网页下拉框，或改 `activeProvider` 后重启。

## 目录结构

```
server.js             # 零依赖后端（http + child_process + fetch）
config.json           # 你的配置（含 key，不入库）
config.example.json   # 配置模板
public/               # 前端（PDF.js + KaTeX 已 vendor 在 public/vendor）
readingnote/
  readingnote.sty     # readingnote LaTeX 宏包（安装到 texmf-local）
setup.ps1             # 一键初始化
```

## 工作原理

- **定位**：选中文字 → PDF 坐标 → `synctex edit` 反查回 tex 行号与所属文件。
- **写回**：在所在段落末尾插入
  `\begin{readingnote}[Q23]{标题} … \end{readingnote}`，标题与正文由 LLM 生成。
- **记忆**：`文档/.texnote/notebook.json` 保存全部 Q&A；解释时把文档骨架 + 历史作为稳定前缀（命中 KV 缓存）。
- **编译**：`latexmk -pdf -interaction=nonstopmode -synctex=1`。
