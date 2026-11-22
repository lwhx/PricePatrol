# 价巡 PricePatrol

面向内部运营的单实例 Web 应用：多店铺 Cookie 隔离、HTTP 采集、SKU 三价与折扣查询、独立监控任务、白名单、预警记录及 Server 酱通知。前端 Vue 3，服务端 Node.js 24＋Fastify，SQLite 持久化。金额使用整数分，商品和 SKU ID 使用字符串。

完整业务规格见 [功能方案](docs/功能方案.md)，API 及集成接口见 [接口契约](docs/接口契约.md)。应用不会修改商家商品价格。真实账号、平台权限及部署机器出口需要各自验收；自动化测试中的本地页面和 HTTP 夹具不代表淘宝/天猫真实登录或采集已通过。

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

访问 `http://localhost:5173`，Vite 将 `/api` 代理至本机 3000 端口。首次访问在初始化页面设置至少 10 字符的管理员密码，管理员 hash 随数据库保留。首次初始化请在本机或受控网络完成。

验证并以单进程提供前端和 API：

```powershell
npm run check
node --env-file=.env --run start
```

访问 `http://127.0.0.1:3000`。Node 不会因文件名为 `.env` 自动加载变量，上面的 `--env-file` 负责加载；直接 `npm start` 时需要自行把变量放入进程环境。

## 导入账号与网页登录

店铺页面可导入 Cookie；服务端核验实际卖家身份、平台与商品权限后才保存。更新原店铺 Cookie 也必须身份匹配，不允许用另一店账号覆盖。

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

只有明确点击“测试通知”才实际发送测试消息；未配置的用户不会收到自动测试推送。按运行汇总通知，避免逐 SKU 发送。渠道额度和频率以官方控制台为准，投递失败可单独重试，无需重新采集。

端点及成功码核对依据：[官方当前 Python 接入文档](https://sct.ftqq.com/docs/integrations/python/)、[官方示例源码](https://raw.githubusercontent.com/easychen/serverchan-demo/master/python/send.py)、[官方 SDK 成功码定义](https://github.com/easychen/serverchan-sdk)。SDK 总览曾残留旧酱 3 URL，路由以当前示例和接入文档为准。

## 测试及验收边界

```powershell
npm run check

# 含真实Chromium的集成测试；先安装对应浏览器
$env:RUN_BROWSER_TESTS = '1'
npm test -- server/test/integrations-serverchan.test.ts server/test/integrations-browser.test.ts
Remove-Item Env:RUN_BROWSER_TESTS
```

Server 酱测试将注入的 fetch 转发至本机 HTTP 服务，验证表单、端点路径、HTTP/业务失败、超时及错误脱敏，不向任何真实 SendKey 发消息。默认浏览器单元测试替换外部 Chromium 启动边界；`RUN_BROWSER_TESTS=1` 另启动真实 Chromium，在网络拦截的受控页面验证截图、点击、输入和 Cookie 隔离。后者需要安装浏览器，缺失时失败而非伪造成功。

真实商家扫码登录、验证、Cookie 长期有效性、Node HTTP 采集及 Linux 目标出口仍需要用户自己的账号与环境实测。测试通过不能替代这些验收。

## Docker Compose 部署

Linux 主机需安装 Docker Engine 和 Compose v2。在项目根目录准备 `.env`，填入持久 `ENCRYPTION_KEY`：

```bash
cp .env.example .env
# 编辑.env并填好密钥
chmod 600 .env
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

默认仅将 `127.0.0.1:3000` 映射至宿主机。可通过 SSH 隧道访问，或用 HTTPS 反向代理转发；HTTPS 访问时设置 `COOKIE_SECURE=true` 并重新创建容器。需要内网直连时设置 `BIND_ADDRESS` 为适当网卡地址。首次访问设置管理员密码，升级时保留原数据卷与密钥。

Dockerfile 先 `npm ci` 构建前端，运行阶段 `npm ci --omit=dev` 后调用**锁定的本地 Playwright CLI**安装 Chromium 及 Debian 系统依赖。采用 `node:24-bookworm-slim`，避开 Playwright npm 版本范围与预制浏览器镜像版本不一致的问题。生产入口为 `node --import tsx server/src/main.ts`，以 `node` 用户运行，镜像内含中文字体。Compose 提供 init、1 GiB 共享内存、健康检查和日志轮转。

容器内数据目录 `/app/data` 使用命名卷，默认名 `price-monitor-data`，可用 `.env` 的 `DATA_VOLUME` 更改。`docker compose down` 保留数据卷；`down -v` 会删除数据，请勿用于普通升级。更换挂载目录时需保证 UID/GID 1000 可写。

当前开发机没有 Docker，未在此机执行镜像构建或 Linux 容器运行验证。工作流中的原生镜像检查需用户推送 GitHub 后实际跑通，再确认目标部署。

## GitHub / GHCR 镜像

项目仓库：[lwhx/PricePatrol](https://github.com/lwhx/PricePatrol)。`.github/workflows/container.yml` 在 PR 执行检查，在 `main`/`master` 推送、`v*` 标签或手动触发时，检查通过后构建并推送 GHCR。无需把 Cookie、SendKey、管理员密码或生产加密密钥放入 Actions Secrets；工作流仅用 `GITHUB_TOKEN` 的 `packages: write` 权限发布。

镜像路径由 `GITHUB_REPOSITORY` 自动转为全小写：`ghcr.io/<owner>/<repo>`。组织仓库需允许 Actions 写 packages；首次生成的 GHCR 包可能为私有。私有镜像在部署机用具备 `read:packages` 的凭证通过 `docker login ghcr.io` 登录，或按需要调整包可见性。

工作流先测试、typecheck、前端构建；随后分别在 `ubuntu-24.04` 和 `ubuntu-24.04-arm` 原生构建 `linux/amd64`、`linux/arm64`。每种架构实际检查容器内 Chromium 截图、数据目录可写及生产入口初始化状态，再推送架构标签；两个作业均成功后合成多架构清单。ARM 使用 GitHub 提供的原生 runner，无 QEMU 仿真依赖。GitHub [已支持公有/私有仓库的标准 ARM runner](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/)，使用额度受账号方案和组织策略影响。

生成标签包括 `sha-<完整提交SHA>`、架构标签 `sha-<SHA>-amd64`/`-arm64`，默认分支额外更新 `latest`，版本推送保留 `v…` 标签。部署建议固定已通过检查的 SHA 标签。发布流程未由本机代用户触发。

Linux 服务器取得 `compose.yaml` 和 `.env.example` 后，在 `.env` 中设置：

```dotenv
IMAGE=ghcr.io/你的全小写用户名/你的全小写仓库名:sha-完整提交SHA
ENCRYPTION_KEY=首次生成后妥善保留的随机密钥
DATA_VOLUME=price-monitor-data
BIND_ADDRESS=127.0.0.1
APP_PORT=3000
COOKIE_SECURE=false
```

然后拉取并启动，不进行源码构建：

```bash
docker compose pull app
docker compose up -d --no-build
docker compose ps
```

后续升级修改 `IMAGE` 后重复上述命令，保留同一数据卷和 `ENCRYPTION_KEY`。网络和平台账号验收必须在目标 Linux 出口重新执行。

## 备份与恢复

优先使用设置页的一致性 SQLite 备份下载（`POST /api/maintenance/backup`，需登录）。运行中仅复制主 `.sqlite`/`.db` 文件会遗漏 WAL，不能作为可靠备份。加密密钥与数据库必须配套保管，数据库下载本身不包含 `.env`；备份含账号密文、管理员 hash 和业务数据，保存到仓库之外的受控位置。

也可以在 Linux **停止应用后**备份整个数据卷。例如默认卷名：

```bash
mkdir -p ../price-monitor-backups
docker compose stop app
docker run --rm -v price-monitor-data:/source:ro -v "$PWD/../price-monitor-backups:/backup" alpine:3.22 tar -C /source -czf /backup/data.tar.gz .
docker compose start app
```

另外单独安全保存对应 `.env` 中的 `ENCRYPTION_KEY`。不要将备份目录上传 GitHub。

恢复前先备份现状，并将备份恢复到**新的空卷**，避免把旧 WAL 或新数据库混在一起：

```bash
docker compose stop app
docker volume create price-monitor-data-restored
docker run --rm -v price-monitor-data-restored:/target -v "$PWD/../price-monitor-backups:/backup:ro" alpine:3.22 sh -c 'tar -C /target -xzf /backup/data.tar.gz && chown -R 1000:1000 /target'
```

在 `.env` 中改 `DATA_VOLUME=price-monitor-data-restored`，恢复该备份配套的原 `ENCRYPTION_KEY`，确认应用版本兼容，再执行 `docker compose up -d --no-build`。验证管理员登录、店铺与预警数据、账号会话后再处理旧卷；旧卷仍保留，可用于回退。已失效的商家会话需要用户重新登录。
