# Glata 工单自动化

通过 Node.js 和 Playwright 操作 Glata 网页，支持串行关单、并发关单、按工单号关单和导出工单标题。脚本根据页面字段执行规则，Resolve 表单的 AI 填充由 Glata 触发。

## 部署教程

在每位使用者自己的电脑上部署。网页控制台和自动化浏览器在同一台电脑运行，首次使用时会打开浏览器完成 Glata 登录。以下命令均从克隆后的项目目录执行。

### 1. 准备环境和访问权限

- 安装 Git、Node.js 20 或更高版本及 npm。可分别执行 `git --version`、`node --version` 和 `npm --version` 检查。
- 此仓库为私有仓库。仓库管理员在 GitHub 的 Settings → Collaborators 中为同事授权，同事接受邀请后即可克隆。
- 使用者的网络和账号需要能够访问 `glata.bytedance.net`，并具有查看目标视图、读取工单和执行 Resolve 的权限。需要公司网络或 VPN 时，先连接后再登录。
- 电脑需要有桌面环境，以便在弹出的浏览器中完成飞书登录和检查预演表单。

### 2. 克隆仓库

在你希望存放项目的目录打开终端。如果已为自己的 GitHub 账号配置 SSH 公钥，执行以下命令。

```bash
git clone git@github.com:chargyzuo/glata-automation.git
cd glata-automation
```

也可以用 HTTPS 克隆，并按 GitHub 提示完成认证。

```bash
git clone https://github.com/chargyzuo/glata-automation.git
cd glata-automation
```

### 3. 安装项目依赖和浏览器

```bash
npm ci
npx playwright install chromium
npm run check-rules
```

`npm ci` 根据仓库中的锁文件安装依赖，`playwright install` 安装脚本使用的 Chromium。Linux 桌面环境如果提示缺少浏览器系统依赖，可改用 `npx playwright install --with-deps chromium`，根据提示完成系统依赖安装。

### 4. 启动网页控制台并首次登录

```bash
npm run ui
```

在同一台电脑的浏览器打开 [Glata 工单控制台](http://127.0.0.1:4317)，保留运行上述命令的终端窗口。

1. 点击 **打开登录窗口**，在弹出的 Glata 浏览器中使用自己的账号完成飞书登录。
2. 看到工单列表后，回到控制台点击 **已登录，保存会话**。
3. 确认自己的账号可以访问 All Views 下的 `Alarm_unrecovered` 和 `Alarm_recovered`。检查视图中的负责人、状态等筛选项是否符合自己的处理范围。项目使用的视图名称和 ID 在 [views.mjs](./views.mjs) 中配置。
4. 选择处理方式，先用默认的 **预演** 检查目标工单和填写结果。检查后点击 **结束预演**，后续需要提交时选择 **正式提交**。

登录会话保存在当前项目目录的 `.browser-profile/`。每位同事在自己的电脑登录，后续启动复用该会话。会话过期时再次点击 **打开登录窗口**。网页和终端命令共用本地会话，同一份项目配置逐次运行任务。

也可以在终端完成首次登录，然后按下文的命令运行。

```bash
npm run login
```

在 Glata 窗口完成登录并看到工单列表后，回到终端按 Enter 保存。

### 5. 后续启动和更新

后续打开终端，进入自己克隆的 `glata-automation` 文件夹后执行 `npm run ui`。网页地址为 `http://127.0.0.1:4317`，任务结束后在终端按 Ctrl+C 可退出控制台。

需要更新版本时，结束当前任务和控制台，在项目目录执行以下命令。若本地修改过规则，更新前先保留自己的改动。

```bash
git pull --ff-only
npm ci
npx playwright install chromium
npm run check-rules
npm run ui
```

代码根据项目文件所在位置定位配置、登录会话、日志和导出文件。项目可以克隆到自己选择的目录。

### 部署常见问题

| 提示或现象 | 处理方式 |
| --- | --- |
| `Repository not found` 或 `Permission denied (publickey)` | 确认已接受私有仓库邀请，SSH 公钥属于获授权的 GitHub 账号。也可使用 HTTPS 克隆并完成认证。 |
| `ENOENT ... package.json` | 在克隆的 `glata-automation` 文件夹中打开终端后再运行 npm 命令。 |
| 找不到 Chromium 或浏览器可执行文件 | 在项目目录运行 `npx playwright install chromium`。 |
| 无法打开 Glata，或一直停在登录页面 | 检查公司网络或 VPN，使用自己的账号重新完成飞书登录。 |
| 无法找到目标视图或执行 Resolve | 核对 Glata 账号权限、视图共享权限及 `views.mjs` 中的视图配置。 |
| 端口 4317 已占用 | 先打开已有的控制台查看任务，任务结束后关闭旧进程，再启动。 |
| 浏览器提示配置目录正在使用 | 结束使用同一份 `.browser-profile/` 的任务后，再开始下一次运行。 |

## 常用命令

### 本地网页

进入项目目录后运行：

```bash
npm run ui
```

在浏览器打开 [Glata 工单控制台](http://127.0.0.1:4317)，并保留启动它的终端窗口。

1. 首次使用或登录过期时，点击 **打开登录窗口**。在弹出的 Glata 浏览器中完成飞书登录，看到工单列表后，回网页点击 **已登录，保存会话**。此会话与终端命令共用。
2. 在 **关单设置** 选择串行批量、并发批量或按工单号。执行模式默认预演，需要提交时选择 **正式提交**，然后点击 **开始正式关单**。
3. 在 **运行记录** 查看进度。预演表单填好后可在 Glata 窗口检查，再回网页点击 **结束预演**。点击 **导出工单标题** 可运行标题导出，日志会显示文件位置。

控制台只监听本机，运行中的任务结束后可在终端按 Ctrl+C 退出。

### 终端

| 用途 | 命令 |
| --- | --- |
| 串行预演 | `npm start` |
| 串行正式关单 | `npm start -- --submit` |
| 并发预演，设定 3 个页面 | `npm run concurrent -- --workers 3` |
| 并发正式关单，设定 3 个页面 | `npm run concurrent -- --workers 3 --submit` |
| 单号预演 | `npm run close -- IT-50773309 --dry-run` |
| 单号正式关单 | `npm run close -- IT-50773309` |
| 导出 recovered 视图的全部工单标题 | `npm run subjects` |

**`close` 默认正式提交**。批量命令默认预演，显式加 `--submit` 才会提交。预演时，每个处理页面会在填好第一个符合条件的表单后停在 Confirm 前。检查后在终端按 Enter 关闭浏览器。正式关单完成或流程报错时，脚本自动关闭浏览器。

正式批量默认处理本轮队列中的所有符合条件工单。可选参数如下。

- `--max 5` 将成功关单总数限制为 5，涵盖所有页面。上限小于并发数时，部分页面会等待名额。
- `--max-scan 100` 从倒序队列中取前 100 单。未恢复排除名单仍完整读取。
- `--headless` 用于已登录后的正式关单或标题导出，在后台运行浏览器。
- `npm start -- --ticket IT-50773309` 在本轮 recovered 队列中预演指定编号。需要直接按工单号打开时，使用 `npm run close -- IT-50773309 --dry-run`。

## 队列与并发

批量运行先完整读取 All Views 下的 **Alarm_unrecovered**（49788），再完整读取 **Alarm_recovered**（49787）。将 recovered 列表倒序后生成本轮队列，从列表最后一页的最后一条往前处理。后续按快照中的编号打开详情，本轮新增工单在下次运行时进入队列。读取或保存快照失败时停止本轮关单。

`--workers` 默认是 2。调度使用应用 `--max-scan` 后的队列长度。

- 队列为空时直接结束。
- 工单数小于 `workers` 时，用一个页面按倒序串行处理，日志记录 `serial_fallback`。
- 工单数大于或等于 `workers` 时，按倒序队列分配连续片段。每页先分到整除后的数量，余数全部交给随机选中的一个页面。比如 20 单分给 3 个页面，每页分别处理 8、6、6 单，多出的 2 单落在哪个页面由随机结果决定。

各页在同一个浏览器内独立处理，页内按分配顺序执行，跨页完成顺序取决于响应速度。某页报错时停止启动新工单，等待已发出的提交完成结果核验后关闭浏览器。

## 关单条件

默认匹配规则和 Resolve 表单选项来自 [closure-rules.yaml](./closure-rules.yaml)。编辑文件后运行 `npm run check-rules` 检查格式。每次开始关单任务时读取一次配置，正在运行的任务继续使用它启动时的版本。

| 配置项 | 用途 |
| --- | --- |
| `ordinary.subject` | 普通关单的 Subject 条件 |
| `planned.detect` | 计划变更检测条件，匹配计划事件分析正文 |
| `planned.branches[].when` | 计划变更分类条件，匹配同一段分析正文 |
| `resolve.tech_catalog`、`resolve.reason_of_alert` | 按菜单层级依次选择的选项 |

每条匹配条件使用 `regex`（JavaScript 正则，填写表达式本身）或 `contains_any`（包含任一关键词），可设置 `ignore_case: true`。正则中的反斜杠可用 YAML 单引号原样保留。新增变更分类时，在 `planned.branches` 添加唯一的 `id`、`when` 和 `resolve`。任务模式决定是否提交 Confirm。

1. 编号命中本轮 `Alarm_unrecovered` 快照时跳过。单号入口也读取这份快照，并额外检查详情中的 `Alert Status = Recovered`。
2. 工单状态必须为 `In progress`。
3. 若分析确认存在相关计划内事件，进入下文的变更关单分支。普通关单使用当前详情页的完整 **Subject** 匹配下列任一表达式，忽略大小写。
   - SPOKE 或 VSPOKE 使用 `/\d+G-V?SPOKE/i`。
   - ADSL 或 INTERNET 使用 `/ADSL-ISP Down|INTERNET-[ABCD](?![A-Z0-9])/i`。例如 `INTERNET-A_` 命中，`INTERNET-ADSL` 和 `INTERNET-A1` 跳过。
4. 普通关单要求 `Monisight AI Planned Event Analysis` 缺失或为空。空白、零宽字符和纯横线也视为空。
5. 打开 Resolve 后等待本次 `AI form filling completed` 提示，最长 120 秒。普通关单将 Tech Catalog 设为 `Network > WAN&Internet > internet`，将 Reason of Alert 设为 `Network Alert > Network Issues`。
6. 正式提交前复查当前标题、计划事件、工单状态、未恢复快照和表单选项。单号入口同时复查 Alert Status。Confirm 只尝试一次，以 `Resolved` 或 `Closed` 状态加有效的 `Resolved Date` 核验成功。

标题条件只读取 Subject，因此正文中提到的关联告警不会触发匹配。比如 Subject 为 `DNSS Packet Loss` 的工单会因标题不匹配被跳过，即使它已恢复。

### 变更关单

当 `Monisight AI Planned Event Analysis` 包含肯定表述“存在一个相关的计划内事件”时，按分析正文选择分类。此分支使用工单状态及恢复检查，按计划事件分析分流。

| 分析正文命中 | Tech Catalog |
| --- | --- |
| 线路、联通、移动、电信、外线 | `Network > WAN&Internet > internet` |
| 电源、power（忽略大小写）、电力 | `Infrastructure > Server room equipment > UPS` |

两种分类都选择 `Network Alert > Planned Events/Changes were not suppressed` 作为 Reason of Alert。脚本等待本次 AI 填充完成再写表单，提交前复核分析正文及表单选项。

两组关键词均未命中或同时命中时跳过，分别记录 `skip_planned_unclassified` 和 `skip_planned_ambiguous`。串行、并发和单号任务在结束时通过 `planned_change_skips` 将编号和原因写入日志并打印到终端。

## 日志和导出

每次运行在 `logs/` 生成 JSONL 日志，在 `artifacts/` 的对应运行目录保存截图和快照。`unrecovered-snapshot.json` 保存本轮排除名单，`queue-snapshot.json` 保存 recovered 快照及倒序队列。并发入口还保存 `worker-assignments.json`，其中有设定与实际页面数、运行模式及分配结果。

| 日志值 | 含义 |
| --- | --- |
| `skip_subject` | 当前标题不匹配关单条件 |
| `skip_unrecovered_snapshot` | 工单在本轮未恢复快照中 |
| `skip_planned_event` | 计划事件字段有有效内容 |
| `prepared_not_submitted` | 预演表单已填好，等待查看 |
| `submitted: 0` | 本轮成功关单数为 0，例如队列为空、工单全被跳过或执行了预演 |
| `outcomeUnknown: true` | 已进入提交阶段，结果未核实，先查看工单状态再决定是否重跑 |

CLI 退出码 0 表示流程正常结束，1 表示异常，单号命令返回 2 表示该工单被跳过。

`npm run subjects` 按页面原顺序导出全部标题到 `exports/<运行时间>/alarm-subjects.txt` 和 `alarm-subjects.json`。TXT 每行一个标题，JSON 同时包含工单编号、视图和总数。

## 复用与测试

两个函数都接收已登录的 Playwright 页面，由调用方负责关闭浏览器。

```js
import { closeTicket } from './close-ticket.mjs';
import { extractAlarmSubjects } from './alarm-subjects.mjs';

const preview = await closeTicket(page, 'IT-50773309'); // 默认预演
const names = await extractAlarmSubjects(page); // string[]
const tickets = await extractAlarmSubjects(page, { includeIds: true });
const allAlarmNames = await extractAlarmSubjects(page, { viewName: 'Alarm' });
```

`closeTicket` 接收 `{ submit: true }` 时正式提交。返回对象的 `outcome` 可能为 `prepared`、`resolved`、`already_finished` 或 `skipped`。关单阶段的异常可通过 `TicketClosureError` 的 `ticketId`、`phase` 和 `outcomeUnknown` 排查。`extractAlarmSubjects` 支持在已打开目标视图时传入 `navigate: false`。

运行 `npm test` 执行回归测试，或用 `node --test concurrent.test.mjs` 单独检查调度规则。浏览器测试需要先完成部署教程中的依赖和 Chromium 安装。
