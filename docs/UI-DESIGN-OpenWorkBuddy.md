# OpenWorkBuddy 界面设计规范

| 项 | 内容 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-10-23 |
| 参考 | WorkBuddy Desktop 5.8.3 渲染层静态资源(`D:\workbuddy\resources\app.asar.unpacked\renderer`) |
| 落地代码 | `apps/renderer/src/styles/tokens.css`、`apps/renderer/src/styles/app.css` |

本文档记录界面重构后的设计令牌与布局规则。所有数值都来自对 WorkBuddy 渲染层 CSS 的实测读取(tokens / contexts / src-CyXHA0IC 等文件),不是估算值。

---

## 1. 设计基调

| 维度 | 结论 |
|---|---|
| 主色 | 薄荷绿 `#00c29a`(品牌 8 号),hover `#40d1b3`,按下 `#009273` |
| 中性色 | 灰阶 `#fafafa → #e6e6e6`,暗色 `#141414 → #3a3a3a` |
| 圆角 | 卡片 8/12,弹层 16,输入框 24,按钮与胶囊 9999 |
| 字体 | 系统字体栈,正文 14px / 行高 22px,聊天正文 15px / 1.75 |
| 密度 | 会话列表项 34px 高、图标按钮 32px、模式胶囊 28–32px |
| 动效 | 160ms(交互)、260ms(布局),标准曲线 `cubic-bezier(.4,0,.2,1)` |

`WorkBuddy` 的界面语言是「低饱和中性底 + 一处品牌绿强调」:大面积留白、极细边框、几乎无阴影,只有输入框和弹层带阴影。这套语言是本次改造的核心。

---

## 2. 设计令牌

令牌文件:`apps/renderer/src/styles/tokens.css`

### 2.1 品牌与灰阶

```css
--owb-brand-8: #00c29a;   /* 主色:发送键、选中态、品牌块 */
--owb-brand-7: #40d1b3;   /* hover */
--owb-brand-9: #009273;   /* 链接文字、active */

--owb-gray-1: #fafafa;
--owb-gray-2: #f7f7f7;    /* 侧边栏底色 */
--owb-gray-3: #f2f2f2;    /* 分段控件轨道、用户气泡 */
--owb-gray-4: #ebebeb;
--owb-gray-5: #e6e6e6;
```

### 2.2 圆角

```css
--owb-radius-sm: 4px;    --owb-radius-lg: 8px;
--owb-radius-xl: 12px;   --owb-radius-2xl: 16px;
--owb-radius-4xl: 24px;  --owb-radius-full: 9999px;
```

### 2.3 阴影

```css
--owb-shadow-card: 0 1px 2px #0000000a;
--owb-shadow-segment: 0 1px 4px #0000000d;
--owb-shadow-popup: 0 12px 32px #0000001a;
--owb-shadow-composer: 0 16px 32px -8px #00000008, 0 2px 4px -4px #0000000f;
```

### 2.4 亮/暗两套语义色

通过 `:root[data-theme='dark']` 切换,主题持久化在 `localStorage['owb.theme']`。

| 语义 | 亮色 | 暗色 |
|---|---|---|
| 应用底 | `#ffffff` | `#141414` |
| 侧边栏 | `#f7f7f7` | `#1f1f1f` |
| 卡片 | `#ffffff` | `#242424` |
| 三级底 | `#ebebeb` | `#2d2d2d` |
| 一级文字 | `#000000` | `#ffffff` |
| 二级文字 | `#5d5d5d` | `#ffffffb3` |
| 三级文字 | `#8a9099` | `#ffffff80` |
| 细分隔线 | `#f2f2f2` | `#ffffff0f` |
| 输入框 | `linear-gradient(180deg,#f0f0f0,#f5f5f5)` | `linear-gradient(180deg,#292929,#242424)` |

---

## 3. 布局骨架

```
┌──────────────┬──────────────────────────────────────────┐
│ 侧边栏 264px │  主区域                                   │
│ ├ topbar 56  │  ├ 欢迎页(无消息)                        │
│ ├ 品牌块      │  │   ├ Hero 标题                          │
│ ├ 搜索胶囊    │  │   ├ 模式分段控件                      │
│ ├ 新会话/记忆 │  │   ├ 快捷操作胶囊行                    │
│ ├ 最近会话    │  │   └ 输入框(composer)                  │
│ └ 主题切换    │  └ 会话视图(有消息)                      │
│              │      ├ 消息流(自动滚底)                  │
│              │      ├ 状态条(工具/记忆/技能/计费)       │
│              │      ├ 输入框(左下角带模式切换)          │
│              │      └ 记忆面板(按需展开)                │
└──────────────┴──────────────────────────────────────────┘
```

| 区域 | 关键参数 |
|---|---|
| 侧边栏 | 宽 264px,折叠 60px,右边框 1px |
| 标题栏 | 高 56px(紧凑 40px) |
| 内容区 | 最大宽 848px,超宽屏 1008px,水平内边距 24px |
| 消息 | 头像 32px,气泡圆角 `16px 16px 0 16px`,间距 24px |
| 输入框 | 圆角 24px,内边距 `2px 2px 4px`,编辑器最小高 64px |

---

## 4. 关键组件规范

### 4.1 模式分段控件(欢迎页)

- 轨道:`--owb-bg-tertiary`,圆角 9999,内边距 2px,`inset 0 0 0 .5px` 描边
- 选中项:白底 + `--owb-shadow-segment`,字重 600
- 未选中:hover 仅变底色,不改字重
- 图标 16px,与文字间距 6px

### 4.2 紧凑模式胶囊(会话输入框内)

- 高度 28px,字号 13px,未选中文字为三级色
- 与 WorkBuddy 的 `cr-mode-selector__trigger` 一致:文字优先、图标弱化

### 4.3 输入框(composer)

- 外层渐变底 + 24px 圆角 + composer 阴影
- 编辑器:15px / 1.75 行高,`textarea` 自适应高度(上限 200px)
- 工具行:左侧模式胶囊,右侧发送键
- 发送键:品牌绿胶囊,32px 高,禁用时 50% 透明
- 运行中:发送键替换为「执行中」,不可重复提交

### 4.4 消息

- 用户消息:右对齐,浅灰气泡,`16px 16px 0 16px` 圆角
- 助手消息:左对齐,无气泡,正文直接铺排(与 WorkBuddy 一致)
- 助手上方显示角色名「OpenWorkBuddy」,用户显示「我 · 模式名」
- 流式输出时末尾显示「正在思考…」

### 4.5 工具调用

- 单行紧凑条:状态图标 + 工具名 + 摘要(单行省略)
- 运行中旋转,成功绿勾,失败红叉

### 4.6 Markdown

自实现轻量渲染器(`src/lib/markdown.tsx`),全程 React 文本节点,不使用 `innerHTML`:

- 支持:标题、有序/无序列表、引用、分隔线、代码块(带语言标签)、行内代码、粗体、斜体、链接、表格
- 不支持:HTML 内嵌、脚注、数学公式(后续按需扩展)

---

## 5. 可访问性与交互细节

| 项 | 做法 |
|---|---|
| 键盘 | `Enter` 发送,`Shift+Enter` 换行,输入法组合态不误发 |
| 焦点 | 搜索胶囊与输入框 focus 时显示 1px 品牌描边 |
| 语义 | 模式控件用 `role="tablist"` / `role="tab"` / `aria-selected` |
| 可读性 | 图标按钮均带 `title` 与 `aria-label` |
| 滚动 | 消息区自动滚底,用户手动上滚后不再强制吸底 |
| 侧边栏 | 折叠后仅留图标,带过渡动画 |

---

## 6. 与 WorkBuddy 的差异(有意为之)

| 项 | WorkBuddy | OpenWorkBuddy | 理由 |
|---|---|---|---|
| 品牌 | 自有 Logo 与字体 | 文本 Logo + 渐变色块 | 不复制品牌资产 |
| 会话列表 | 多分组 + 云任务 + 标签页 | 单列最近会话 + 搜索 | 当前数据模型只有会话 |
| 交付面板 | 右侧产物面板 | 暂未实现(P5 后) | 尚无产物模型 |
| 扩展槽 | 微前端 federation | 无 | 当前无插件 UI |

---

## 7. 验收

```powershell
cd OpenWorkBuddy
pnpm -r typecheck
pnpm --filter @openwb/desktop build
node tests/e2e/verify-modes-ui.mjs
```

期望:`verify-modes-ui` 22 项全部 PASS(含模式切换、工具收窄、记忆面板、重启后历史恢复)。

视觉自检清单:

- [ ] 亮/暗主题切换后无残留硬编码颜色
- [ ] 侧边栏折叠/展开过渡平滑
- [ ] 欢迎页在 1280×900 下垂直居中
- [ ] 长消息滚动时输入框固定在底部
- [ ] 工具调用与状态条不挤压消息正文
- [ ] 代码块横向滚动不撑破容器