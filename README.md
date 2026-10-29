# dsh-beme · 给 DSH 加一个长期记忆库

> 一句话：**装上就能用。不用配模型、不用建库、不用写代码。**
> 装上之后你的 AI 多两个工具：`memory_remember`（记一条）、`memory_recall`（翻一条）。

---

## 一、它是什么

一个 DSH 插件，把「块记忆」塞进你的 AI：

```
你说「记住：我不吃香菜」
        ↓ memory_remember
   切成一条一件事的块，落进本地的库（默认 ~/.beme）
        ↓ 下次你提到吃饭
   memory_recall 把相关那几条捞出来，递到模型眼前
```

跟"让模型自己总结聊天记录"不一样：**它记的是你亲口让它记的事**，不会自己瞎编，也不会把整段对话倒进去。

---

## 二、三句话验证它活了

装完重启 DSH，然后：

```
① 说：记住：我最喜欢的颜色是墨绿，不吃香菜
② 新开一句：我最喜欢什么颜色？
③ 答出「墨绿」= 通了
```

看不到工具名？→ 见第六节「装不上怎么办」。

---

## 三、怎么装

### 方式 A · 插件市场（推荐）

DSH Desktop → 左侧「插件」→ 搜索 `dsh-beme` → 安装 → 重启。

### 方式 B · 命令行

```bash
dsh plugin --profile web add dsh-beme
```

### 方式 C · 本地 tgz（没发布时自己测）

```bash
dsh plugin --profile web add "file:/你的路径/dsh-beme-0.1.2.tgz"
# 或者手动：把它加进 profile 的 dependencies 和 dsh.profile.bundles，再 pnpm install
```

⚠ **手动 `pnpm install` 只算"装了一半"**：DSH 用 `dsh.profile.bundles` 和自己的安装记录判断装没装，光有 `node_modules` 不够。详见第八节坑 #4。

---

## 四、装上就会做什么（不用配置）

| 事 | 什么时候发生 | 要配吗 |
|---|---|---|
| 记一条 | 模型判断"这事值得长期记住"，调 `memory_remember` | 不用 |
| 翻一条 | 模型想不起以前的事，调 `memory_recall` | 不用 |
| 自动浮现 | 每轮它收到你的话，插件先把相关的块捞出来、附在请求后面 | 不用（可关） |
| 切块 | `memory_remember` 时如果有宿主模型就让它切，没有就按句子切 | 不用 |

**不需要给它 API key**：切块用的模型是**宿主自己的**（`ctx.llm.ask`），宿主不给就自动降级，不报错。

---

## 五、配置（可选，默认值就能用）

在 profile 的 `cordis.patch.yml` 里给这条插件加参数：

```yaml
- id: beme
  config:
    dir: ''          # 数据目录，默认 ~/.beme
    topN: 8          # 一次最多捞几条
    budget: 1800     # 一次最多塞多少 token 级预算
    hint: true       # 要不要在系统提示里告诉她"你有记忆库"
    autoRecall: true # 每轮自动捞（关掉就只剩手动工具）
```

---

## 六、装不上怎么办（六个坑，照顺序查）

| 症状 | 原因 | 修 |
|---|---|---|
| 插件市场看不到它 | 没装进 profile 的 dependencies | `dsh plugin --profile web add dsh-beme` |
| 市场能看到、但启动不加载 | `dsh.profile.bundles` 里没有它 | 手动加进 bundles，再 `pnpm install` |
| 日志里 `which is not installed` | `cordis.patch.yml` 里 insert 的 `name` 写成子路径了 | **必须写包名 `dsh-beme`**，不能写 `dsh-beme/xxx` |
| 启动报 `failed to import` → 进安全模式 | 包根 `main` 没指向插件入口 | `main` 和 `exports["."]` 指向 `./plugin/index.mjs` |
| 报 `Cannot read properties of undefined (reading 'render')` | 工具定义缺 `output` | 每个工具都要 `output: { schema, render }` |
| 插件一挂整台 DSH 就进安全模式 | insert 没写 `required: false` | 加上它，插件挂了不影响 DSH 启动 |

---

## 七、它不会做的事（诚实说）

- **不会自己总结你们的聊天**——只有你让它记，它才记
- **不会导入你已有的记忆**（要自己灌；库是 JSON，`lib/cli.mjs` 有 `remember` 命令）
- **没有面板**、**没有定时整理**、**没有多设备同步**
- **每轮自动浮现的内容，模型不一定采信**——实测它会去核实。真正可靠的是那两个工具
- 中文优先（词表、提示词都是按中文场景写的）

---

## 八、数据在哪、怎么备份

```
~/.beme/
├── blocks/blocks.json   块库（一件事一块）
├── blocks/events.jsonl  事件日志（只追加，永不改）
├── blocks/slots.json    坑位台账
├── blocks/idx/          索引（删了会自动重建）
└── blocks/meta.json     词表 + 幂等水位
```

- **备份**：整个 `~/.beme` 拷走即可
- **搬家**：拷到新机器同位置，或用 `dir` 指过去
- **重建索引**：删掉 `blocks/idx/`，下次自动重建
- **不加密**：能读那个目录的进程都能读走全部内容

---

## 九、卸载

```bash
dsh plugin --profile web remove dsh-beme
# 再删数据：rm -rf ~/.beme
```

Windows 上如果手动装的，也可以直接跑 `uninstall-beme-from-dsh.py`（在发行包的 `scripts/` 里）。

---

## 十、它从哪来的

从一套真实在跑的私人记忆架构（块库 + 特征检索 + 四态出口）里抽出来的通用版。
原理和取舍写在 `beme` 主库里（`github.com/shua-781/beme`），这个仓库只负责**把它变成"装上就能用"的插件**。

MIT。随便用，出 bug 提 issue。
