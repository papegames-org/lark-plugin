# 面向开发者：版本管理与 npm 发布

这个仓库会发布到 npm，因此版本一致性、发布前检查和公开仓库安全都需要作为默认要求来维护。

## 版本管理规则

以下文件的版本号必须保持一致：

- `package.json`
- `package-lock.json`
- `openclaw.plugin.json`

先运行：

```bash
npm run check:version
```

每次发布前，先升级版本号，例如：

```bash
npm version patch
```

升级后再同步确认以上文件版本一致。

## 发布前检查

```bash
npm run release:check
```

它会串行执行：

- `check:version`：检查关键 manifest 版本是否一致
- `test`：跑全部测试
- `check:public`：扫描敏感信息与高风险文件
- `pack:dry`：执行一次 `npm pack --dry-run`

## 发布到 npm

```bash
export NPM_TOKEN="你的 npm token"
npm run release:publish
```

发布脚本会：

- 强制使用 `https://registry.npmjs.org/`
- 用临时 `.npmrc` 读取 `NPM_TOKEN`
- 先执行 `release:check`
- 发布结束后删除临时认证文件

## 公开仓库敏感信息扫描

`npm run check:public` 当前会重点拦这些风险：

- 私钥块、OpenAI key、GitHub PAT、Slack token、AWS key、npm token
- 明显像真实密钥的 `appSecret` / `client_secret` / `access_token` 内联赋值
- `.npmrc`、`.env`、`id_rsa`、`.pem`、`.key` 这类高风险文件
- 机器绝对路径、真实邮箱这类容易泄漏个人信息的内容

这层扫描不是万能的，但至少能在发布前先拦住一批最常见的公共仓库事故。

## 维护时顺手检查

如果后续改了发布脚本、打包清单或新增演示目录，记得一起确认：

- `release:check` 的执行链路是否仍然完整
- `check:public` 的规则是否覆盖新增风险面
- README 与 `AGENTS.md` 的说明是否仍然一致
