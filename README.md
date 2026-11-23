# 价巡 PricePatrol

面向内部运营的单实例 Web 应用：多店铺 Cookie 隔离、HTTP 采集、SKU 三价与折扣查询、独立采集任务与预警任务、白名单、预警记录及 Server 酱通知。前端 Vue 3，服务端 Node.js 24＋Fastify，SQLite 持久化。金额使用整数分，商品和 SKU ID 使用字符串。

完整业务规格见 [功能方案](docs/功能方案.md)，API 及集成接口见 [接口契约](docs/接口契约.md)。应用不会修改商家商品价格。真实账号、平台权限及部署机器出口需要各自验收；自动化测试中的本地页面和 HTTP 夹具不代表淘宝/天猫真实登录或采集已通过。

## 采集与预警任务

先创建**采集任务**，设置店铺、全店或指定商品范围，以及每日/每周计划。再创建**预警任务**，绑定一个采集任务，设置检查范围、规则、白名单和通知开关。一个采集任务可绑定多个预警任务，各自保存规则版本、预警执行与通知结果，共用同一批价格证据。

**手动操作只采集价格。** 即使任务已经配置每日计划，点击“立即采集”仍是手动来源；只有调度器真正创建的定时采集，在成功或部分完成后才执行关联预警。

| 操作或采集结果 | 采集来源 | 关联预警 | 自动汇总通知 |
| --- | --- | --- | --- |
| 任务“立即采集”、店铺采集、批量重采 | `manual` | 不执行 | 不发送 |
| 失败商品重试，包括原本来自定时任务的失败商品 | `manual` | 不执行 | 不发送 |
| 计划到期且采集成功 | `scheduled` | 执行入队时捕获的预警配置 | 有命中、快照开启通知且渠道可用时发送 |
| 计划到期且采集部分完成 | `scheduled` | 仅检查本批数据，标明覆盖不完整 | 满足通知条件时发送，并说明覆盖情况 |
| 采集失败、停止、需登录或等待恢复 | 保留原来源 | 不执行；恢复同一批次并最终完成后再按来源判断 | 不发送 |
| 升级前的历史采集 | `legacy` | 不补跑 | 不补发 |

采集任务保存取价范围和计划；预警任务保存检查范围、规则、白名单和通知。价格查询中的“预警任务”使用预警配置筛选，批量加入白名单也写入预警任务；批量加入采集范围仍写入采集任务。预警范围不能替代采集范围，也不会额外采集缺少的商品。

规则、范围、白名单、通知开关和规则版本在**定时采集入队时冻结**。之后修改、暂停或删除预警任务，影响未来批次；已捕获的执行继续使用原快照。停用或删除采集任务会清除其尚未开始的定时采集。手动与定时作业分别去重，不会把手动批次改成定时批次，也不会共用手动采集结果触发预警。

批量重采按店铺展示提交结果，重试只提交失败的组。相同请求凭据在 24 小时内返回原采集批次，避免服务器已接受、网页未收到响应时重复排队。向现有采集任务添加商品使用原子追加；编辑整份任务配置时检查版本，冲突会提示重新读取。

采集记录、预警执行和预警事件分别查看：采集记录说明价格来自哪个批次；预警执行说明检查、排除、命中和无法判断的 SKU 数量；预警事件保留对应价格证据。通知失败只影响该次预警的通知状态，可单独重试，不会重采商品或重新计算预警。旧价、缺价和无法判断的结果不能用于认定价格正常；显式的采集状态异常规则仍可判断 `partial`、`backend_only`、`stale`、`error` 等状态。

### 持续异常与通知频率

“预警记录”分为异常处理和检查证据。相同预警规则下，同一店铺、商品、SKU 的持续异常共用一个处理事项；每次定时检查仍保存自己的价格证据。人工确认、备注和已处理状态属于异常事项，不会改写旧检查记录，也不等同于价格已恢复。

| 变化 | 何时发生 | 通知策略 |
| --- | --- | --- |
| 首次出现 | 有效检查第一次命中，或恢复后再次命中 | 开启通知时提醒 |
| 持续异常 | 继续命中且未确认恶化 | 默认每 24 小时可提醒一次 |
| 异常恶化 | 同一组数值方向条件变差，例如“低于”规则的价格更低 | 可以立即提醒；使用精确金额和折扣比较 |
| 已恢复 | 当前有效、完整覆盖该商品的价格明确不再命中 | 默认不发恢复通知，可在预警任务中开启 |

冷却间隔可设为 0–8760 整数小时，0 表示每次命中均可提醒。缺失、陈旧、采集失败或白名单排除不会被认定为恢复；文本、等值和范围规则不推测“恶化”。改名称、通知或版本不会重开异常；改变规则语义或删除任务会归档原规则的异常，不会显示为价格恢复。新旧顺序按每条价格的实际采集时间判断；旧批次恢复后新采到的价格会正常更新异常，批次里已有的旧行不会覆盖较新观测。历史清理不会改变已保存的新旧顺序。

通知候选在检查完成的事务内固定，同时预留提醒时间，避免队列中的多个检查在上一条通知发出前重复提醒。全局通知关闭或缺少密钥且确定没有发送时，会释放该次预留，不消耗提醒冷却。投递重试只发送本次冻结候选；失败或中断结果未知的投递仍需明确重试，并保留冷却保护。已入队批次保持原规则和通知策略，旧历史不会因为升级补发消息。

### 查询、复制与大文件导出

价格查询合并了重复的筛选统计，保持金额排序、未知值、白名单、分页和历史快照语义。完整 SKU 集合仅在平台身份、覆盖与全部 SKU 都核验通过后用于更新当前 SKU 列表；部分结果不会删除历史 SKU。

小结果继续在“复制与导出”中预览并复制。超过 2000 个源行或 5 MiB 的结果自动转为后台文件任务；大任务只返回状态、有限预览和行数，文件由浏览器直接下载。CSV、TSV、文本、Markdown、JSON 等格式共用同一套快照和编码逻辑。商品汇总字段与 SKU 明细字段分别保留，不会被展开时覆盖。

后台任务使用独立只读数据库连接，在工作线程的一致性读事务内分批写文件。同一进程一次运行一个导出任务，最多接受 20 个排队/运行任务。可以取消未完成任务，也可重新打开窗口查看上次后台导出。完成文件保留 24 小时；小复制快照保留 15 分钟，最多 32 份。中断任务不会被误认为完成，重新生成即可。导出文件属于临时结果，数据库备份不包含它们；恢复后缺失的文件会明确提示重新生成。

采集默认仍逐店执行。需要提高多店吞吐时，在 `.env` 设置 `COLLECTION_CONCURRENCY=2`（允许 1–4），然后重新创建容器。同一店铺始终串行，不改变平台请求间隔、重试上限、采集来源或预警触发规则。

### 从旧组合任务升级

升级前先做一致性数据库备份，并保留原 `ENCRYPTION_KEY`。首次打开旧数据库时，应用在事务内将每个旧组合任务拆成原 ID 的采集任务和同 ID 的默认预警任务，保留店铺、名称、范围、计划、规则、白名单、启用状态及通知选择。不同旧任务分别迁移，不合并；重复打开不会重复创建。

历史采集、价格与预警继续保留。旧采集缺少可信触发来源，统一标记 `legacy`，不会因升级补跑预警或补发通知。历史事件可以继续按采集批次查看。新通知重试入口是 `POST /api/alert-runs/:id/notify`；旧 `POST /api/runs/:id/notify` 返回 400 并提示新入口。迁移失败会回滚，恢复时数据库与加密密钥必须配套。

## Windows 本地运行

安装 **Node.js 24 LTS**（需要内置 `node:sqlite`），在项目根目录使用 PowerShell：

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

把生成的随机值填到 `.env` 的 `ENCRYPTION_KEY`。至少 32 字符，建议使用上面生成的 64 位十六进制值。密钥首次生成后必须保留，Cookie 和 SendKey 密文恢复需要同一个密钥。不要把 `.env`、Cookie、数据库或通知密钥提交 Git。

仓库包含 `package-lock.json` 时使用 `npm ci`，它按锁文件重建依赖；只有尚无锁文件，或有意更新依赖时才使用 `npm install` 并审查锁文件变化。Playwright 包升级后需重新安装其对应浏览器。

网页登录辅助是可选功能，导入已有 Cookie 和日常 HTTP 采集不要求安装 Chromium。需要网页登录时执行：

```powershell
npx playwright install chromium
```

启动开发环境：

```powershell
node --env-file=.env --run dev
```

访问 `http://localhost:5173`，Vite 将 `/api` 代理至本机 3000 端口。首次访问设置至少 10 字符的管理员密码，管理员 hash 随数据库保留。生产环境首次初始化需要部署者持有的令牌，见下面的“首次管理员初始化”；已有管理员的数据库继续使用原密码。

验证并以单进程提供前端和 API：

```powershell
npm run check
node --env-file=.env --run start
```

访问 `http://127.0.0.1:3000`。Node 不会因文件名为 `.env` 自动加载变量，上面的 `--env-file` 负责加载；直接 `npm start` 时需要自行把变量放入进程环境。

## 导入账号与网页登录

店铺页面可导入 Cookie；服务端核验实际卖家身份、平台与商品权限后才保存。更新原店铺 Cookie 也必须身份匹配，不允许用另一店账号覆盖。

每个账号可选配置 HTTP、HTTPS 或 SOCKS5 出口代理（`socks://` 为 SOCKS5 别名）；留空使用直连。代理地址随账号凭据加密保存，列表只显示是否已配置，编辑时不回显地址。认证信息中的特殊字符需按 URL 编码，例如 `@` 写为 `%40`。SOCKS5 默认端口为 1080，用户名和密码需同时提供，各不超过 255 个 UTF-8 字节。配置代理后，连接失败不会自动回退直连。

编辑账号时可选择保留现有设置、替换代理或恢复直连；只有明确选择“恢复直连”才清除代理。API 更新中省略 `proxy` 表示保留，传 `null` 或空字符串表示清除；变更后会重新核验店铺身份和读取权限。代理仅用于本次及后续 HTTP 采集，网页登录窗口的网络设置独立。

“网页登录”会在服务端启动 Playwright Chromium，展示 **1280×800 的真实 PNG 画面**。用户手动扫码、点击、输入验证码及按 Enter/Tab 完成平台验证，然后点击完成，由 HTTP 核验接口验证并绑定账号。服务不会自动输入账号密码，不提供验证码绕过。截图缩放后的点击由前端换算至原图坐标。

每个登录会话有独立、临时的 BrowserContext，最多同时 5 个。没有截图、操作或 Cookie 获取请求达到 10 分钟时回收，关闭弹窗应同时关闭会话。Cookie 由主应用加密保存，浏览器登录目录不作为账号持久化来源；容器重启后未完成的登录需重新创建。无 Chromium 时接口会返回中文安装指引。支持的操作为坐标点击、最多 2000 字符的手动输入，以及 Enter、Tab、Shift+Tab、Backspace、Delete、Escape、Space、方向键、Home/End、PageUp/PageDown、Control+A、Meta+A。

服务没有公开 Playwright/CDP 调试端口。远程使用时只开放经过管理员认证的 Web 入口。

## Server 酱通知

在登录后的“设置”页面填入完整 SendKey、开启通知并保存。密钥加密存入数据库，读取设置只返回是否已配置。空 SendKey 表示明确清除。获取 SendKey：

- Turbo：<https://sct.ftqq.com/sendkey>，`SCT…` 格式。
- Server 酱 3：<https://sc3.ft07.com/>，`sctp{UID}t…` 格式，需安装并登录其客户端。

模块按格式选择官方端点：

| 类型 | POST 地址 |
| --- | --- |
| SCT | `https://sctapi.ftqq.com/{SendKey}.send` |
| 酱 3 | `https://{UID}.push.ft07.com/send/{SendKey}.send` |

请求使用表单字段 `title`、`desp`，有摘要时带 `short`。以 HTTP 成功且响应 JSON **数字 `code === 0`** 判定服务受理；受理不等同于微信/App 最终送达。5 秒超时，拒绝重定向。标题去换行并限 32 个 Unicode 字符，摘要限 64 字符，正文限 UTF-8 30000 字节；超限内容截取摘要，完整预警留在应用数据库中。错误不会回显 SendKey、包含密钥的 URL、远端响应正文或异常 cause。

只有明确点击“测试通知”才实际发送测试消息；未配置的用户不会收到自动测试推送。业务通知按**预警执行**汇总，每套预警规则分别发送，正文包含来源采集批次、规则版本和覆盖情况。手动采集及旧版历史采集无法通过通知重试入口绕过来源限制。

已受理（`accepted`）或正在提交（`sending`）的通知不可重复发送，清空 SendKey 或关闭全局通知也不会覆盖这些状态。投递失败记录为 `failed`，不自动重发；可在预警执行中明确重试。若进程在提交时中断，发送结果可能需要人工核对，重启不会直接重发。渠道额度和频率以官方控制台为准。

端点及成功码核对依据：[官方当前 Python 接入文档](https://sct.ftqq.com/docs/integrations/python/)、[官方示例源码](https://raw.githubusercontent.com/easychen/serverchan-demo/master/python/send.py)、[官方 SDK 成功码定义](https://github.com/easychen/serverchan-sdk)。SDK 总览曾残留旧酱 3 URL，路由以当前示例和接入文档为准。

## 测试及验收边界

```powershell
npm run check

# 含真实Chromium的集成测试；先安装对应浏览器
$env:RUN_BROWSER_TESTS = '1'
npm test -- server/test/integrations-serverchan.test.ts server/test/integrations-browser.test.ts
Remove-Item Env:RUN_BROWSER_TESTS
```

Server 酱集成测试将注入的 fetch 转发至本机 HTTP 服务，验证表单、端点路径、HTTP/业务失败、超时及错误脱敏；预警通知测试直接替换 fetch，验证来源限制、冻结开关、独立汇总和重试幂等性。两类测试均不向任何真实 SendKey 发消息。默认浏览器单元测试替换外部 Chromium 启动边界；`RUN_BROWSER_TESTS=1` 另启动真实 Chromium，在网络拦截的受控页面验证截图、点击、输入和 Cookie 隔离。后者需要安装浏览器，缺失时失败而非伪造成功。

真实商家扫码登录、验证、Cookie 长期有效性、Node HTTP 采集及 Linux 目标出口仍需要用户自己的账号与环境实测。测试通过不能替代这些验收。

## Docker Compose 部署

Linux 主机需安装 Docker Engine 和 Compose v2。在项目根目录准备 `.env`，填入持久 `ENCRYPTION_KEY`：

```bash
cp .env.example .env
# 编辑.env并填好密钥
chmod 600 .env
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps
```

根目录 `docker-compose.yaml` 与 `deploy/compose.yaml` 默认都拉取 `ghcr.io/lwhx/pricepatrol:latest`，不会在服务器上隐式源码构建。设置了 `pull_policy: always`，执行 `docker compose up -d` 会主动检查镜像更新；需要固定已验收版本时请在 `.env` 指定 `IMAGE=ghcr.io/lwhx/pricepatrol:sha-完整提交SHA`。

如需从仓库源码构建本地镜像，而不是使用 GHCR 发布版：

```bash
docker build -t pricepatrol:local .
IMAGE=pricepatrol:local docker compose up -d --pull never
```

两份 Compose 都将容器内的 `3000` 端口发布为宿主机 `6300` 端口，默认绑定所有网络接口，即 `6300:3000`。部署完成后可使用 `http://服务器IP:6300` 访问；请确保服务器防火墙/安全组允许所需来源访问。对公网开放时建议配置 HTTPS 反向代理，设置 `COOKIE_SECURE=true`，并在受控环境完成首次管理员密码初始化。端口映射固定，不再使用旧的 `BIND_ADDRESS` / `APP_PORT` 环境变量；若需改端口，直接编辑 Compose 的 `ports`。升级时保留原数据卷与密钥。

Dockerfile 先 `npm ci` 构建前端，运行阶段 `npm ci --omit=dev` 后调用**锁定的本地 Playwright CLI**安装 Chromium 及 Debian 系统依赖。采用 `node:24-bookworm-slim`，避开 Playwright npm 版本范围与预制浏览器镜像版本不一致的问题。生产入口为 `node --import tsx server/src/main.ts`，以 `node` 用户运行，镜像内含中文字体 `fonts-noto-cjk`。Compose 提供 init、1 GiB 共享内存、健康检查和日志轮转；镜像带 OCI 标签，指向本仓库。

容器内数据目录 `/app/data` 使用命名卷，默认名 `pricepatrol-data`，可用 `.env` 的 `DATA_VOLUME` 更改。从更早版本升级、数据仍在 `price-monitor-data` 卷时，把 `DATA_VOLUME` 写成旧卷名即可继续读取，无需迁移数据。`docker compose down` 保留数据卷；`down -v` 会删除数据，请勿用于普通升级。更换挂载目录时需保证 UID/GID 1000 可写。

自动备份写入独立的 `/app/backups` 卷，默认卷名 `pricepatrol-backups`，可由 `BACKUP_VOLUME` 更改。两份 Compose 的对外端口保持 `6300:3000`。

### 首次管理员初始化

生产数据库还没有管理员时，可以任选一种方式完成初始化：

- 在 `.env` 设置 10–200 个字符的 `ADMIN_PASSWORD`，首次启动时直接创建管理员。
- 设置 32–256 个字符的 `SETUP_TOKEN`，打开网页后同时提交令牌和新密码。
- 两项都留空时，应用在数据目录生成权限为 `0600` 的 `.setup-token`。从服务器读取后在初始化页提交：

```bash
docker compose exec app cat /app/data/.setup-token
```

使用 `deploy/compose.yaml` 时在命令中加上相应的 `-f` 和 `--env-file`。令牌不会通过公共状态接口或日志返回。管理员建立后，初始化入口不再接受令牌；重新启动或更改上述变量不会重置已有管理员密码。

### 运行健康

工作总览显示每家店最近一次完整成功采集、距完整成功的时间、连续失败次数，以及采集、预警和通知队列。部分成功会打断“连续失败”，但不会被计为完整成功；停止或等待恢复不算新增失败。定时计划的执行、合并、账号失效、停用和错过计划等原因单独保存，最多保留近 30 天的 1,000 条记录。

设置页显示镜像的构建提交、时间和数据库版本。生产日志使用结构化事件和请求/采集/预警执行标识；不会记录请求体、Cookie、SendKey 或远端响应正文。未知服务端异常返回 500，用户可纠正的输入和业务冲突返回对应的 4xx 状态。

本机开发环境没有 Docker。以上配置与工作流中的镜像检查已在 GitHub Actions 的 `ubuntu-24.04`（amd64）和 `ubuntu-24.04-arm`（arm64）实际跑通：容器内 Chromium 截图、数据目录可写、生产入口初始化状态均通过。目标 Linux 主机的网络出口与平台账号仍需自行验收。

## GitHub / GHCR 镜像

项目仓库：[lwhx/PricePatrol](https://github.com/lwhx/PricePatrol)。`.github/workflows/container.yml` 在 PR 执行检查，在 `main`/`master` 推送、`v*` 标签或手动触发时，检查通过后构建并推送 GHCR。无需把 Cookie、SendKey、管理员密码或生产加密密钥放入 Actions Secrets；工作流仅用 `GITHUB_TOKEN` 的 `packages: write` 权限发布。

镜像路径由 `GITHUB_REPOSITORY` 自动转为全小写：`ghcr.io/<owner>/<repo>`。组织仓库需允许 Actions 写 packages；首次生成的 GHCR 包可能为私有。私有镜像在部署机用具备 `read:packages` 的凭证通过 `docker login ghcr.io` 登录，或按需要调整包可见性。

工作流先测试、typecheck、前端构建；随后分别在 `ubuntu-24.04` 和 `ubuntu-24.04-arm` 原生构建 `linux/amd64`、`linux/arm64`。每种架构实际检查容器内 Chromium 截图、数据目录可写及生产入口初始化状态，再推送架构标签；两个作业均成功后合成多架构清单。ARM 使用 GitHub 提供的原生 runner，无 QEMU 仿真依赖。GitHub [已支持公有/私有仓库的标准 ARM runner](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/)，使用额度受账号方案和组织策略影响。

生成标签包括 `sha-<完整提交SHA>`、架构标签 `sha-<SHA>-amd64`/`-arm64`，默认分支额外更新 `latest`，版本推送保留 `v…` 标签。部署建议固定已通过检查的 SHA 标签。发布流程未由本机代用户触发。

### 只拉镜像部署（推荐）

服务器不必克隆仓库，只需要 `deploy/` 下的三个文件：

```bash
# 在服务器上建一个部署目录，只取这两个文件（也可直接用 scp 拷贝）
mkdir -p ~/pricepatrol && cd ~/pricepatrol
curl -fsSLO https://raw.githubusercontent.com/lwhx/PricePatrol/main/deploy/compose.yaml
curl -fsSL https://raw.githubusercontent.com/lwhx/PricePatrol/main/deploy/.env.example -o .env.example

cp .env.example .env
# 编辑 .env：至少填 ENCRYPTION_KEY；需要时改 IMAGE
chmod 600 .env

docker compose --env-file .env pull
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

文件都在当前目录，`--env-file .env` 可省略（Compose 默认读取同目录 `.env`）。默认镜像为 `ghcr.io/lwhx/pricepatrol:latest`；建议改成已通过检查的 `sha-<完整提交SHA>` 固定版本，升级时改 `IMAGE` 再执行一次 `pull` 和 `up -d`。

若镜像包为私有，先在本机登录：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u 你的GitHub用户名 --password-stdin
```

`GHCR_TOKEN` 需要 `read:packages` 权限。公开仓库的镜像默认可匿名拉取。数据卷与 `ENCRYPTION_KEY` 在升级时必须保留；网络和平台账号验收必须在目标 Linux 出口重新执行。

仓库根目录的 `docker-compose.yaml` 现在默认同样拉取 GHCR 发布版；如需源码构建，请使用上方的 `docker build` 命令并明确覆盖 `IMAGE`。两种方式使用同一数据卷约定，可互相切换。

## 备份与恢复

优先使用设置页的一致性 SQLite 备份下载（`POST /api/maintenance/backup`，需登录）。运行中仅复制主 `.sqlite`/`.db` 文件会遗漏 WAL，不能作为可靠备份。加密密钥与数据库必须配套保管，数据库下载本身不包含 `.env`；备份含账号密文、管理员 hash 和业务数据，保存到仓库之外的受控位置。

设置页还提供后台备份、保留期限和清理预览：

| 设置 | 默认值 | 行为 |
| --- | --- | --- |
| 普通采集历史 | 180 天 | 到期后可以清理普通采集及零命中检查 |
| 已处理预警证据 | 365 天 | 从人工处理或证据产生的较晚时间起保留，不能短于普通历史 |
| 自动清理 | 关闭 | 升级不会自行删除旧数据；启用后每天检查 |
| 定期备份 | 开启，每 24 小时 | 应用启动时检查是否到期，失败后至少间隔 1 小时重试 |
| 备份保留 | 14 份 | 只轮转本数据库创建的完整备份，不删除其他文件 |

每次清理都先完成本地备份；配置了额外备份目录时，也必须复制成功才清理。备份在工作线程生成，验证数据库完整性后原子发布，文件权限为 `0600`。失败和中断在设置页显示，不把未完成文件计为成功备份。

预览和实际清理使用同一套保护条件。未处理预警、持续异常的首末证据、未完成采集/检查、待投递或失败通知、当前最新价格来源、有效的请求去重凭据，以及未完成重试依赖的父批次不会被提前删除。实际执行会重新检查保护条件，因此并发采集时最终数量可能和预览不同。删除依赖记录在同一个事务中完成。

本地备份卷仍在同一台服务器上，无法防止整机或磁盘丢失。备份目录（包括异机挂载）需要支持可靠的 SQLite 文件锁；应用保留一个空的实例锁文件，保护正在写入的备份，并在下次写入前回收中断留下的自有中间文件。该锁文件不计入备份份数，保持原样即可。需要异机备份时，先由管理员把远端存储挂载到宿主机，例如 `/mnt/pricepatrol-remote`，确认文件锁支持并保证 UID/GID 1000 可写；再创建 `compose.backup.yaml`：

```yaml
services:
  app:
    environment:
      BACKUP_COPY_DIR: /app/backup-copy
    volumes:
      - type: bind
        source: /mnt/pricepatrol-remote
        target: /app/backup-copy
        bind:
          create_host_path: false
```

```bash
docker compose -f docker-compose.yaml -f compose.backup.yaml up -d
```

只复制 `deploy/` 文件部署时，把第一个 `-f` 改成实际的 `compose.yaml`。应用要求配置的额外目录已经存在；路径只能来自部署环境，网页不能指定服务器文件路径。挂载状态和远端持久性仍由宿主机管理。数据库备份与原 `ENCRYPTION_KEY` 分别保存。

也可以在 Linux **停止应用后**备份整个数据卷。例如默认卷名：

```bash
mkdir -p ../pricepatrol-backups
docker compose stop app
docker run --rm -v pricepatrol-data:/source:ro -v "$PWD/../pricepatrol-backups:/backup" alpine:3.22 tar -C /source -czf /backup/data.tar.gz .
docker compose start app
```

另外单独安全保存对应 `.env` 中的 `ENCRYPTION_KEY`。不要将备份目录上传 GitHub。

恢复前先备份现状，并将备份恢复到**新的空卷**，避免把旧 WAL 或新数据库混在一起：

```bash
docker compose stop app
docker volume create pricepatrol-data-restored
docker run --rm -v pricepatrol-data-restored:/target -v "$PWD/../pricepatrol-backups:/backup:ro" alpine:3.22 sh -c 'tar -C /target -xzf /backup/data.tar.gz && chown -R 1000:1000 /target'
```

在 `.env` 中改 `DATA_VOLUME=pricepatrol-data-restored`，恢复该备份配套的原 `ENCRYPTION_KEY`，确认应用版本兼容，再执行 `docker compose up -d --no-build`。验证管理员登录、店铺与预警数据、账号会话后再处理旧卷；旧卷仍保留，可用于回退。已失效的商家会话需要用户重新登录。

如果恢复的是设置页下载的单文件一致性备份，将其放入新的空卷，命名为 `monitor.sqlite` 并设置 UID/GID 1000；不要带入旧卷的 `monitor.sqlite-wal` 或 `monitor.sqlite-shm`。先使用生成备份时的镜像版本启动验证，再升级到新版本。数据库迁移后的回退应恢复迁移前备份，不直接让旧镜像读取新结构。
