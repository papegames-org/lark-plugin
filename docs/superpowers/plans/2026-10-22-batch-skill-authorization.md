# Skill 集中预授权执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. 本文是可行性分析和待执行计划，不表示功能已实现或方案已获最终确认。

**Goal:** 安装流程中发现当前配置范围内全部 Skill 的飞书权限，按应用集中开通，再为当前安装者集中发起个人 OAuth；完成后使用已覆盖的 Skill 不再逐个授权。

**Architecture:** Skill 权限清单负责发现和聚合；批量授权协调器负责分组、差集和去重；既有飞书接口、卡片和失败队列负责授权交互及恢复。运行时仍按当前 Skill 的实际权限校验放行。

**Tech Stack:** Node.js ESM、node:test、现有 OpenClaw hook、飞书 HTTP 授权接口、现有个人 OAuth 运行时；不新增第三方运行时依赖。

## 1. 可行性结论与范围

技术上可行，但应将“一次性”定义为：同一应用、同一批 Skill 声明一次集中申请应用开通权限；每位用户针对该应用一次集中申请个人 OAuth。飞书侧审批、应用权限开通与个人 OAuth 仍可能有不同步骤，不能保证一个按钮完成全部动作，也不能替其他用户授权。

用户已选择（2026-10-22）：应用和当前安装者的个人权限都在安装流程中发起。安装 helper 完成包安装后扫描，先引导集中开通应用权限，复查成功后在同一安装向导中发起安装者的集中个人 OAuth；两阶段成功后报告可用范围。Gateway 启动后加载清单并核验真实授权，其他用户首次触发缺权限的 Skill 时各自集中授权。已有权限不再请求，新增权限只增量申请。

方案比较（按用户选择排序）：

| 方案 | 优点 | 代价 |
| --- | --- | --- |
| 安装时汇总应用及当前安装者的个人权限（已选择） | 安装向导中完成两阶段，安装者后续少被授权打断 | 需要安装期个人 OAuth 和可信身份验证；其他用户仍需各自授权 |
| 安装时应用权限汇总，首次使用时个人权限汇总 | 安装不依赖用户身份 | 安装者首次使用仍需个人 OAuth |
| 仅安装时汇总应用权限 | 改动较小 | 个人权限仍可能分多次申请，目标只完成一部分 |

本计划按用户已选择的安装双阶段方案编写；选择范围不代表已授权实现或发布。集中授权是明确配置模式，建议新增 `authorizationMode: "batch" | "perSkill"`，schema 默认保留 `perSkill`。helper 首次 install-openclaw 默认进入集中授权向导，并为目标插件写入 batch 配置（在安装向导说明）；已有安装升级保留原模式，不自动进入全量向导，可显式运行 auth-all 切换。提供 --skip-authorization 跳过首次安装向导。auth-all 是显式进入集中模式的入口，同样最小更新目标插件为 batch，无论之前通过哪种方式安装。配置更新仅修改目标插件字段，不覆盖账号/其他插件，更新失败则报告明确续办入口。`blockRead` 默认 true 不变。

“全部 Skill”限于 OpenClaw 当前配置的技能根、agent workspace、以及可获取的运行时 resolvedSkills。不能宣称任意安装来源均已覆盖；未发现或后安装的 Skill 在运行时触发补扫描和增量授权。权限仅来自有效 larkAuth，不推测脚本调用的其他系统权限。

## 2. 当前代码证据（2026-10-22）

| 文件/入口 | 已有能力 | 本次所需改变 |
| --- | --- | --- |
| `bin/openclaw-skill-runtime.js:installOpenClaw` | npm pack 后执行 openclaw plugins install 并退出 | 增加安装后的配置读取、清单生成和集中授权入口 |
| `index.js:register/getSkillMapEntry` | 注册时健康检查；按 roots 在首次需要索引时扫描；缓存到 register 生命周期结束 | 启动扫描及清单失效，不在 register 无收件人时直接发卡 |
| `utils.js:getDefaultSkillRoots/findSkillMds` | 默认个人 skills、当前 workspace skills、OpenClaw 默认 workspace skills；递归深度最多 4，跳过隐藏目录和 node_modules | 明确多 agent、额外根和 resolvedSkills 的覆盖范围；记录扫描异常 |
| `parse-meta.js:normalize/readLarkAuth` | 支持 scopes/appScopes/userScopes；输出 identity/scopes/scopeInstallGrant | 不能直接用跨 Skill 的单值 scopeInstallGrant 合并两种身份需求 |
| `utils.js:checkScopes/beginScopeGrantFlow` | 检查应用开通的 scope；授权链接支持 tenant/user 两类 scope 数组 | 批量差集必须保留身份桶；这里的 user 桶不等于个人 OAuth 已完成 |
| `utils.js:getSkillAuthCacheKey` | accountId + Skill 绝对路径 | 批量任务改按应用/阶段/用户去重，Skill 仅作为来源及等待者 |
| `utils.js:startUserGrantLogin/checkUserGrant` | 个人授权发起仍调用 lark-cli；校验优先可信 runtime checker，必要时回退 CLI | 复用真实授权能力；CLI/身份缺失须给出恢复方式，不能伪报成功 |
| `utils.js:startWaitForAuth` | 现有应用轮询可能在 registrationReady 时忽略应用 API missing；轮询 checkScopes 未传 scopeInstallGrant | batch 必须使用严格桶校验，不能直接继承这一完成判定；单 Skill 行为是否一起调整需独立评估兼容性 |
| `pending-auth.js:createPendingAuthNotice` | notice 强制 skillName/skillPath/accountId，按失败退避持久化 | 增加显式 batch 类型，恢复时重新生成权限清单 |

当前 `npm run release:check` 已通过：版本一致（2.0.3）、72 个测试通过、公开信息检查通过、打包预检通过。工作区已有 package.json、package-lock.json、openclaw.plugin.json 的用户改动；执行时保留，不混入无关提交。

文档漂移需顺手修正：README 的“启动即扫描”、仅 user identity 生效、完全不依赖 CLI 等描述与当前实现有差异。

## 3. 设计约束

### 3.1 清单与权限聚合

新增 `skill-auth-manifest.js`，只做发现、解析、来源记录和聚合，不发卡、不调用 OAuth。输出包含 schemaVersion、完整性状态、扫描错误、各应用的 Skill 来源、应用安装 tenant/user 权限集合及个人 OAuth 需求集合。

应用安装权限按 `(scope, installIdentity)` 去重，个人 OAuth 按 scope 去重。同一个 scope 被不同 Skill 分别声明 appScopes/userScopes 时保留两项；不能覆盖成一个 grant 值。先保留每个 Skill 的规范化声明，再利用现有身份匹配逻辑计算桶和差集；旧 scopes 未指定桶时保留未解析项，结合应用 API 元数据解析，无法解析时沿用原有保守检查，不直接全部归为 tenant。

Skill identity 决定是否需要个人 OAuth；appScopes/userScopes 描述应用开通身份桶，不能只凭 userScopes 就认定 app identity 的 Skill 需要个人 OAuth。单个声明内部同 scope 两个桶的表达能力在 P0 中确认；需要增强解析器时保持原有接口兼容并增加显式集合。

`manifestHash` 由规范化身份需求及有效配置范围生成。根列表相同不代表文件内容相同：支持启动重建、手动 rescan，以及运行时读取新路径或元数据变更时失效。第一版采用有界 TTL 复扫，不引入文件 watcher。读取错误/无效声明与无权限需求区分；清单不完整时可处理确定的权限，但不能展示“全部完成”。

### 3.2 应用/agent/用户边界

先沿用现有 accountId 路由及 bindings 解析每个 agent 的有效技能范围，再按 `(brand, appId)` 合并绑定到同一应用的需求；不同应用绝不合并。共享全局目录会进入明确使用这些目录的应用分组。多应用下路由不明的 Skill 进入 unresolved，要求显式映射，不把其权限复制给所有应用。

建议 batch 配置增加 `batchAuth.applications[]`：每项含 accountId 和可选 agentIds/skillRoots。缺省优先使用能确定的 OpenClaw agent/account 绑定；单应用可直接使用默认技能根。多个 account 指向同一 appId 时校验 brand 与凭据配置一致，选明确发送账号，不随机选取。

个人授权锁、notice 和结果跟踪必须包含可信 openId、brand、appId。运行时身份来自现有可信 hook；安装期身份来自 OAuth 后端核验结果或经验证的已有个人登录态，不能从 OS 用户名、应用授权管理员或命令行自报 openId 推断。

安装期没有已知 openId 时允许启动 OAuth 登录握手以建立身份，但该握手是独立的 bootstrap 任务，不是已归属用户的授权完成记录：由已解析的应用、安装运行实例和安全 OAuth correlation 标识跟踪，并按可能共享的 CLI profile 串行化。只有完成真实登录并核验 appId/openId/scope 后，才能迁移到用户级任务及报告个人权限完成。如果现有 CLI 无法把安装握手可靠绑定到实际使用者，P0 判定当前方案缺少前提，先适配身份接口再实现，不能退化为替管理员授权。

### 3.3 触发时机及交互

建议增加 helper 子命令（以下接口均为待实现）：

```bash
node bin/openclaw-skill-runtime.js auth-plan --account default --json
node bin/openclaw-skill-runtime.js auth-all --account default
node bin/openclaw-skill-runtime.js auth-all --account default --rescan
node bin/openclaw-skill-runtime.js auth-all --account default --stage user
node bin/openclaw-skill-runtime.js install-openclaw --account default
node bin/openclaw-skill-runtime.js install-openclaw --skip-authorization
```

`auth-plan` 只读输出 Skill 数量、scope 来源、身份分类、缺失项和扫描错误；凭据/令牌不进入输出。`auth-all` 默认顺序发起应用开通与当前安装者个人 OAuth，--stage app/user 可续办指定阶段，user 阶段仍先核验应用前提。应用安装 user 桶也是应用开通，不能把它误认为个人 OAuth。没有收卡对象时在终端展示两个阶段各自的授权链接/设备码，不猜管理员。直接使用 `openclaw plugins install` 的用户随后执行 auth-all 得到相同安装后向导；插件 register 没有终端和用户身份，无法独自完成安装者 OAuth，不宣称直接安装命令会自动启动双阶段。

安装向导步骤：扫描并展示来源/权限 → 集中开通应用权限 → 等待应用 API 按桶确认 → 读取既有安装者可信身份或启动 OAuth 身份握手 → 集中申请个人 scope → 复查真实个人授权 → 展示可用 Skill 范围。已有阶段齐全则跳过；没有个人 scope 则不发起个人 OAuth。管理员与安装者不同，可由管理员完成第一阶段、安装者独立完成第二阶段。

安装与授权状态分别报告：包安装成功后，配置缺失、取消或超时不得误报安装失败/权限完成；记录 completedStage 与待续办阶段，输出下一步命令。默认交互安装等待两阶段，但每个等待有界，退出后可续办。非交互安装要求明确 --skip-authorization 或 --no-wait；no-wait 可发起应用阶段并报告后续步骤，因应用前提尚未验证，不宣称个人阶段已发起或双阶段已完成。npm 安装生命周期不自动执行网络授权。

register 只安排后台扫描，不阻塞 Gateway，不因重复注册反复发卡。首次触发缺权限的 Skill，且具有可信飞书上下文时才发送集中卡片；当前 Skill 已授权则直接执行，不因其他 Skill 缺权限主动发卡。也允许显式集中授权入口。优先当前应用未完成的应用开通任务，随后为该用户申请聚合个人 OAuth。

应用任务记录请求者集合及原始卡片接收者。原始接收者的个人阶段可更新同一卡片；其他用户各自建立个人卡片，不能把同一张群卡变成所有人的 OAuth 凭据。管理员完成应用开通不代表管理员或原请求者已完成个人 OAuth；完成时按各自可信 openId 校验并通知。

### 3.4 去重、增量与运行时放行

新增 `batch-auth.js` 协调器。任务互斥键为应用 + authReason；个人 OAuth 再加 openId。活动任务中的权限是不可变快照，新发现权限进入下一次差集，不能用不同 manifestHash 并发创建同主体多个授权流程。

helper 和 Gateway 共用数据目录的持久化任务租约：使用原子创建、ownerId、到期时间及心跳；只有持有者可发起授权，其他进程读取活动任务或等待。状态文件原子替换，完成/清理按 owner 校验，过期接管后重新校验实际权限；不共享数据目录的多主机协调不在第一版范围。必须测试 CLI 与 Gateway 同时发起、进程崩溃、旧持有者迟到完成及损坏状态文件。

已授予集合来自实际应用 API / 可信个人授权检查，不来自卡片记录或 manifestHash。申请个人权限时先确认既有 OAuth 是否要求带上此前全部目标 scope 以保留授权；不能未经验证只传缺失项导致旧权限丢失。

运行时只要求当前 Skill 的权限齐全。无关 Skill 缺权限不阻断当前已具备权限的 Skill；当前 Skill 缺权限时加入批量任务并阻断本次执行。授权卡片成功、device poll 成功均不能单独触发放行，必须复查应用桶及个人 scope。拒绝部分权限时保持部分完成，其他已满足需求的 Skill 可执行。

新增权限请求只包含新缺失需求。删 Skill 不自动撤销飞书权限；更换应用、配置范围、撤销权限或 OAuth 失效后重新计算。恢复时重新读取配置和清单，过滤过期任务，不能恢复旧 appId/旧用户任务到新身份。

### 3.5 持久化与失败处理

扩展 `pending-auth.js` 为兼容 v1 的 v2 notice：增加 targetType、appId/brand、manifestHash、来源 Skill 列表及身份需求快照。legacy Skill notice 保持可读；batch 不伪造 skillPath。继续沿用退避、exhausted 显式重试和现有数据目录。

在发送记录、轮询恢复及执行 gate 三处同步支持 batch。已授予状态不永久持久化为真；device code、卡片记录沿用现有私有存储边界，不存 appSecret/access_token 到新增清单。所有任务结束、失败、禁用或超时释放等待者及锁；恢复时权限已齐全则直接收敛，不再发卡。

## 4. 执行任务与提交顺序

所有任务先加入能暴露真实行为问题的测试，再做最小实现，运行对应测试通过后提交。下列代码路径均相对仓库根，新增文件需加入 package.json 的 files 白名单。

### P0：运行时与飞书接口验证（发布门槛）

**Files:** 只读 index.js、utils.js、feishu-runtime.js、parse-meta.js、bin/openclaw-skill-runtime.js；记录结果到本计划。

- [ ] 确认部署的 OpenClaw CLI/配置读取接口、配置环境变量及 agent/resolvedSkills API；禁止猜配置路径或输出完整含密钥配置。记录支持版本；无法统一读取时提供显式安全配置路径参数并验证。
- [ ] 使用测试应用验证混合 tenant/user 桶集中开通：至少两个 Skill、有重复权限；授权后应用 API 按身份返回正确集合。
- [ ] 验证现有应用 registration 链接支持目标应用类型、管理员身份与企业审批条件；拒绝、部分开通和超时均可重试。
- [ ] 验证独立安装 CLI（没有 pluginApiRef、hook senderId、Gateway tools）能初始化飞书配置、发起 OAuth 并取得后端核验的 appId/openId；bootstrap correlation 可追踪且不会把应用管理员认作安装者。若不能，先实现必要适配，不把 user 阶段推迟到首次使用来代替用户选择。
- [ ] 验证个人 OAuth 多 scope、增量时旧授权保留、两用户隔离、lark-cli profile 是否允许同应用并发个人登录。并发不支持时可排队，但多用户持久凭据隔离是硬门槛：验证甲登录→乙登录→重启→分别按 openId 查询。若单 profile 只保存当前用户，须实现每用户独立 profile（验证部署兼容性）或可信运行时凭据接口后才可宣称支持多用户；否则明确仅支持单用户，不能用排队冒充隔离。
- [ ] 测量真实 scope 数和授权链接长度；确认飞书限制。超限时给出明确分批策略，不能承诺严格一次。
- [ ] 运行 `npm run release:check`，预期全绿；测试基线失效或接口无法支持时先处理问题再进入 P1。无测试应用时只完成本地开发，不报告端到端验证完成。

### P1：建立权限清单

**Files:** Create skill-auth-manifest.js、test/skill-auth-manifest.test.js；Modify utils.js、parse-meta.js（仅必要兼容扩展）、package.json。

- [ ] 测试 JSON/YAML、app/user/legacy、多来源重复权限、同 scope 两桶、坏 frontmatter、不可读目录、重复名 Skill、额外根/多 agent/未绑定应用。
- [ ] 实现纯聚合接口 `collectSkillAuthManifest({ config, skillRoots, resolvedSkills })`，返回 apps、unresolved、errors、complete、hash；文件访问与配置注入，便于离线测试。
- [ ] 实现 roots 与内容变更失效；缓存期间运行时发现新 Skill 能扩展清单；数据与绝对路径只存本地，不写入公共演示。
- [ ] 运行 `node --test test/skill-auth-manifest.test.js test/parse-meta.test.js test/feishu-routing.test.js`，预期全部通过。
- [ ] 提交 `feat: collect skill authorization manifests by application`。

### P2：批量差集、任务与恢复

**Files:** Create batch-auth.js、test/batch-auth.test.js；Modify pending-auth.js、utils.js、test/pending-auth.test.js、test/scope-install-grant.test.js、package.json。

- [ ] 测试身份桶差集、已经齐全零发卡、同主体并发只创建一次、不同用户不共享任务、活动任务期间新增权限进入后续差集。
- [ ] 定义 `ensureBatchAuthorization({ manifest, ctx, authReason })` 注入现有 checkScopes/checkUserGrant/startLogin/sendAuthCard，返回 authorized/pending/partial/unavailable；错误不变成授权成功。
- [ ] 扩展 v2 notice、旧版读取和 app/user 键；从扫描清单恢复，验证更换应用/撤销权限/用户变更/失败耗尽显式重试。
- [ ] 实现跨进程租约与原子写入；测试 CLI/Gateway 同时申请只创建一项任务，崩溃后可接管且旧 owner 不覆盖新结果。
- [ ] 加入未绑定用户的安装 bootstrap 状态、已验证用户任务迁移和安装阶段续办；身份不匹配、过期握手或错误用户不能记为原安装者完成，OAuth/CLI profile 持有者发生冲突时排队或明确失败。
- [ ] 更新恢复轮询及清理：授权事实复查、scope 快照、锁与等待者生命周期、app scope 到 user OAuth 阶段衔接。
- [ ] batch 轮询显式传递全部身份桶；registrationReady 只能表示授权动作已完成，应用 API 未确认时保持 pending，并有界重试处理权限传播延迟。新增 registration 成功但桶仍缺失的回归测试；不直接复用现有忽略 missing 的完成分支。
- [ ] 运行 `node --test test/batch-auth.test.js test/pending-auth.test.js test/scope-install-grant.test.js test/utils.test.js`，预期全部通过。
- [ ] 提交 `feat: coordinate and restore batch authorization flows`。

### P3：安装时应用与安装者个人 OAuth 向导

**Files:** Modify bin/openclaw-skill-runtime.js、test/bin.test.js；Create auth-bootstrap.js、test/auth-bootstrap.test.js；Modify package.json。

- [ ] 测试 auth-plan 无授权副作用、单应用默认选择、多应用必须指定/确定分组、安装成功与授权失败分开、无交互终端、配置缺失、取消、链接超限、输出不含凭据。
- [ ] 实现 auth-plan/auth-all/rescan/stage 与 install-openclaw 首次安装默认双阶段向导；已有安装升级保留原模式。首次向导和显式 auth-all 都最小更新目标插件 batch 配置，skip-authorization/no-wait 行为明确，不修改 npm lifecycle；测试升级不隐式全量授权与直接安装后 auth-all 真正启用 batch。
- [ ] 用现有 Feishu HTTP 入口批量请求 tenant/user 安装桶，按实际 API 确认后，在同一向导中通过独立 CLI OAuth adapter 发起安装者集中个人授权、核验 appId/openId/scope。adapter 不伪造 senderId、不过度依赖 register 的全局初始化；抽出必要可注入配置/profile 的入口。
- [ ] 覆盖无既有身份时的登录 bootstrap、管理员与安装者不同、用户取消第二阶段、仅续办个人阶段、无个人需求、个人权限已齐全、身份不匹配和超时。终端展示明确阶段与待办，不能将应用成功展示为个人已完成。
- [ ] 运行 `node --test test/bin.test.js test/auth-bootstrap.test.js test/feishu-runtime.test.js`，预期全部通过。
- [ ] 提交 `feat: add installation-time skill authorization setup`。

### P4：接入 hook 与集中个人 OAuth

**Files:** Modify index.js、openclaw.plugin.json、test/index.test.js、test/feishu-routing.test.js；Create test/batch-auth-integration.test.js。

- [ ] 测试安装者双阶段已授权后，Gateway 第一次读取 A、随后读取 B 都不再申请；重复 register/重启不刷卡，其他可信用户首次使用独立集中申请，应用不同不混合，部分授权仅阻断受影响 Skill。
- [ ] 测试已授权 A 不因缺权限 B 主动发卡；甲乙共等应用开通、第三方管理员完成应用授权后，两人的个人 OAuth 各自校验与发卡。
- [ ] 加入 authorizationMode/batchAuth schema；batch 接入后台清单和协调器，perSkill 保持行为兼容。
- [ ] guardToolCall 先检查当前 Skill，再仅在缺权限时加入集中任务；before_prompt_build 复用相同逻辑；不会为一次普通飞书消息强制启动全量 OAuth。
- [ ] 测试没有 openId、runtime checker 不可信、CLI 缺失、异常、卡片失败与后续工具 gate：均不能未授权执行。
- [ ] 运行 `node --test test/batch-auth-integration.test.js test/index.test.js test/feishu-routing.test.js test/utils.test.js`，预期全部通过。
- [ ] 提交 `feat: use batch authorization in skill runtime hooks`。

### P5：文档、真实验收及发布检查

**Files:** Modify README.md、AGENTS.md、PATCH_NOTES.md、package.json、package-lock.json、openclaw.plugin.json；必要时扩展 test/docs-portability.test.js/test/package-manifest.test.js。

- [ ] 写出默认 helper 双阶段安装、直接 openclaw plugins install 后 auth-all、多应用配置、个人阶段续办、无交互跳过、rescan、仅增量补授权和回退 perSkill 的操作方法，修正文档漂移。
- [ ] 使用测试应用覆盖“安装插件 → 扫描 3 个 Skill 重叠权限 → 同一安装向导集中开通 → 安装者甲集中 OAuth → 重启 Gateway → 连续执行 3 个 Skill 零新授权”。验证管理员不同于甲、直接安装后显式 auth-all、第二阶段取消后续办的路径。
- [ ] 加入用户乙、重启、增加新 scope、撤销权限、部分拒绝、发卡失败及重试场景；记录卡片数、申请数、实际 scope 和执行结果。
- [ ] 版本升级前确认 registry/分支状态，统一三个 manifest 版本，不覆盖用户已有版本改动。新增文件进入 npm files，旧无效打包文档条目一并核实。
- [ ] 运行 `npm run release:check`，预期版本/全部测试/公开信息/打包均通过。当前测试命令强制退出，另检查批量任务关闭后无残留 timer/子进程，避免用强制退出掩盖生命周期错误。
- [ ] 提交 `docs: document batch skill authorization and release validation`。仅在另行授权发布后进行 npm 发布。

## 5. 验收与回滚

| 场景 | 预期 |
| --- | --- |
| 同应用 10 个 Skill、权限重叠 | 按身份去重后集中申请，数量不随 Skill 数增长 |
| 所有应用及个人权限已授予 | 零新授权卡片，当前 Skill 正常执行 |
| helper 默认交互安装 | 包安装、扫描、应用开通、安装者个人 OAuth 顺序完成，安装期不依赖 hook senderId |
| 安装应用阶段完成，个人阶段取消/超时 | 报告安装成功、个人权限未完成；续办只处理必要阶段 |
| 应用管理员与安装者不同 | 管理员开通应用，安装者独立 OAuth，个人凭据归属以真实验证为准 |
| 没有个人 scope / 安装者已全量授权 | 跳过不必要个人流程，不重复授权 |
| 应用和个人权限均缺失 | 应用开通及个人 OAuth 阶段清晰；单张卡片按阶段更新，成功后以真实权限复查为准 |
| 用户甲已授权，用户乙未授权 | 乙独立 OAuth，甲状态不可用于乙 |
| 同 scope 两个身份桶 | 两项需求均得到正确校验和申请 |
| 多应用 / 无确定路由 | 按应用隔离；不确定项可诊断，不猜目标 |
| 新 Skill 无新增 scope | 重建清单，不产生新授权 |
| 新 Skill 增加 scope | 只申请缺失项，已有 OAuth 不丢失 |
| 部分权限拒绝 | 显示部分完成；只阻断确实缺权限的 Skill |
| 扫描错误 / 权限 API 异常 | 不显示全部成功，缺权限的 Skill 保守阻断 |
| 重启 / 卡片失败 / exhausted | 恢复或显式重试，无重复任务，无错误放行 |

回滚：切换 authorizationMode 为 perSkill，停止 batch 新任务并清理本进程等待者；v1 notice 兼容，v2 batch notice 保留但在 perSkill 模式不自动恢复；已有真实飞书授权继续有效，不自动撤销权限。实现中必须覆盖禁用/切换模式后的清理测试。

预计 4–6 个工作日：P0 约半天到一天；P1–P2 约 1–2 天；P3–P4 约 2 天；P5 约半天到一天。安装期身份/OAuth 适配是新增工作，企业审批等待及未确认的接口限制不包含在估算内。

下一入口是 P0 的真实接口验证，然后 P1 清单实现。本轮只新增计划文档，没有实现 batch 功能，没有提交或发布代码。
