# dsh-github-push

给 DSH 加一个 **`github_push` 工具**：把某个工作区目录暂存、提交、推送到 GitHub。凭据复用本机已有的（Windows 凭据管理器 / ssh-agent），**不会**让 token 出现在对话里。

## 为什么

在这台机器上推送 GitHub 需要绕过三个坑，插件把这些封装成一次工具调用：

1. git 不在 PATH（`C:\Users\<你>\PortableGit\cmd\git.exe`）——插件按顺序找 `DSH_GIT_PATH` → `~/PortableGit/cmd/git.exe` → `C:\Program Files\Git\cmd\git.exe` → PATH 上的 `git`；
2. 本地代理会重签 HTTPS 证书（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）——第一次正常推送，命中 TLS 错误时自动用 `openssl` 后端 + 关闭对端校验重试一次，并在结果里注明；
3. 凭据存放在 Windows 凭据管理器（`credential.helper wincred`）——工具不接触 token。

## 工具参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `dir` | 是 | 仓库工作目录的绝对路径；没有 `.git` 时自动 `git init -b main` |
| `message` | 是 | 提交信息；工作树没有变化时不会造空提交 |
| `remote` | 否 | 远端名，默认 `origin` |
| `branch` | 否 | 分支，默认当前分支（新仓库为 `main`） |
| `repoUrl` | 否 | 要添加/替换的 HTTPS 远端地址，例如 `https://github.com/owner/name.git` |
| `tlsVerify` | 否 | 设为 `true` 表示不做 TLS 降级重试 |

返回：`ok`、`commit`（短 id）、`branch`、`url`（仓库网页地址）、`actions`（做了什么）、`note`（注意事项，如「工作树无变化」「走了 TLS 降级」）。

## 用法示例

对 DSH 说：

> 把 `plugins\dsh-session-delete` 推到 GitHub，提交信息写「修 1.4.0 的说明」

DSH 会调用：

```
github_push({
  dir: "C:\\...\\plugins\\dsh-session-delete",
  message: "修 1.4.0 的说明"
})
```

远端已在仓库里配好时不用传 `repoUrl`；新仓库第一次推送时传一次即可。

## 一次性准备（每台机器一次）

把 GitHub 的 token 交给 Windows 凭据管理器（之后所有推送都用它，包括这个工具）：

```
"protocol=https`nhost=github.com`nusername=<用户名>`npassword=<PAT>`n`n" | git credential approve
```

然后 `git config --global credential.helper wincred`（本仓库里已配好可跳过）。

## 测试

```
node test/flow.test.mjs
```

用本地 bare 仓库当远端，覆盖：init → commit → push、工作树无变化、第二次提交、URL 归一化、目录不存在时报错。不联网、不用凭据。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | 定义并注册 `github_push` 工具（参数与输出 schema、结果渲染） |
| `lib/git.js` | git 可执行文件探测、命令执行、提交、推送与 TLS 降级 |
| `cordis.patch.yml` | 插入 Host 行 |

## 许可

MIT
