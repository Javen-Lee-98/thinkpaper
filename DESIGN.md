---
version: alpha
name: ThinkPaper（草稿纸）
description: 平板上的一张手写纸。黑笔是自己的推导，红笔是交给 Claude 的事，蓝字是 Claude 回在纸上的。界面要让位给纸。
colors:
  ink: "#1b1b1b"            # 黑笔
  red-pen: "#d23c2e"        # 红笔；界面上只用在红笔按钮上
  ai: "#2f5fae"             # Claude 的蓝字、「AI」按钮、从 Claude 那边来的记号
  ai-adopted: "#1f3d7a"     # 采纳了的蓝字；「AI」按钮一轮在走时的字
  ai-busy-bg: "#dce6f5"     # 「AI」按钮一轮在走时的底
  erased: "#c3c3c3"         # 擦掉的笔迹（只在回放和交给 Claude 的图里）
  paper: "#ffffff"          # 纸
  paper-margin: "#faf8f3"   # 书页右边 Claude 写批注时开出的那一栏
  desk: "#e8e5df"           # 书页、推送页纸外面的灰底
  panel: "#fffdf8"          # 顶栏、工具栏、抽屉、小面板的底
  line: "#d9d3c6"           # 细边框、分隔线
  text: "#222222"           # 界面上的字
  text-secondary: "#4a463f" # 次一级的字和图标
  muted: "#7a746a"          # 说明文字、页码
  locked-bg: "#ebe8e1"      # 「只在本地」时按钮的灰底
  hot-bg: "#fff3d6"         # 纸边「＋ 加长」这类按钮亮起来时的底
  hot-border: "#e0a52a"
  error-text: "#8a2b20"
typography:
  ui:
    fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 15px
    lineHeight: 1.4
  ui-small:
    fontFamily: "{typography.ui.fontFamily}"
    fontSize: 13px
    lineHeight: 1.3
  ai-note:                  # Claude 写在纸上的短批注：手写体，不加框、不加底色
    fontFamily: '"Xiaolai", "Kaiti SC", STKaiti, KaiTi, "PingFang SC", sans-serif'
    fontSize: 21px          # 纸上的单位，跟着纸缩放
    lineHeight: 29px
  badge:                    # 长回答的圈号（蓝底白字，和蓝字同一种手写体）
    fontFamily: "{typography.ai-note.fontFamily}"
    fontSize: 17px
rounded:
  control: 8px              # 普通按钮、输入框
  panel: 12px               # 小面板、小菜单
  pill: 20px                # 右下角那一条和左上角那一排上的圆按钮
  bar: 24px                 # 右下角那一条自己
spacing:
  bar-height: 52px          # 退出全屏后的顶栏
  rail-width: 60px          # 退出全屏后的左侧工具栏
  gap: 6px
  panel-padding: 6px
  screen-inset: 12px        # 浮在纸上的控件离屏幕边
  top-safe: 44px            # 全屏时屏幕顶端这一条不放东西（碰了 Safari 会退出全屏）
  touch-target: 44px        # 能点到的范围至少这么大（样子可以小，范围不能小）
components:
  button:
    height: 36px
    minWidth: 40px
    backgroundColor: "{colors.paper}"
    borderColor: "{colors.line}"
    rounded: "{rounded.control}"
  button-selected:          # 选中：白底加粗边框，不整块涂色
    backgroundColor: "{colors.paper}"
    borderColor: "{colors.text}"
    borderWidth: 1.5px
  button-primary:           # 「AI」
    backgroundColor: "{colors.ai}"
    textColor: "#ffffff"
  rail-button:
    height: 46px
  tools-button:             # 右下角那一条上的
    height: 40px
    minWidth: 40px
    rounded: "{rounded.pill}"
  chip-button:              # 全屏时左上角那一排上的
    height: 36px
    minWidth: 36px
    rounded: 18px
  pen-stroke:
    width: 2.1px            # 纸上的单位
  badge:
    radius: 13px
---

# ThinkPaper（草稿纸）的设计规矩

这份文件把界面上现有的数值和已经定下的规矩收在一处，改界面之前先读它。它不规定功能：功能和取舍以私有仓库里的《产品定义与决定》为准，
两者不一致时以那一份为准，并回来改这里。格式照 Google Labs 开源的 DESIGN.md 规范草案（alpha）：上面是数值，下面是为什么。

## Overview

这是一张纸，不是一个应用界面。打开时只有纸：左上角一小排（本子名、页码、翻页），右下角一条（笔、橡皮、撤销、AI）。
顶栏和左侧工具栏要点「退出全屏」才出来。

三种颜色各有固定的意思，界面上不拿它们做别的用：

- 黑：用户自己的推导和草稿。
- 红：用户交给 Claude 的事。界面上不用红色表示警告或「有新东西」。
- 蓝：Claude 的。蓝字、「AI」按钮、「别的页有新回答」的记号、☰ 上的小圆点都是蓝的。

纸面是用户的思考空间。Claude 的东西自己找空白放，挡了路就收起来，不预留地方，也不改用户笔迹的样子。

## Colors

- 界面的底是暖白（`panel`），不是纯白；纸是纯白，纸外面是暖灰（`desk`）。两者要分得开：一眼看出哪里是纸。
- 边框一律用细线（`line`，1 像素）。分层靠细线和很淡的阴影，不靠深色块。
- 选中的状态用白底加粗边框（`button-selected`），不把按钮整块涂色。红笔选中时边框是红的。
- 「AI」按钮是界面上唯一的实心色块。一轮在走时变成浅蓝底、深蓝字；这本只在本地时是灰底，字前一把锁。
- 提示条里要强调的东西用字，不加红色、黄色的底。纸边「＋ 加长」这类按钮只在笔写到边上附近时亮起（`hot-bg`），几秒后自己暗下去。

## Typography

- 界面的字用系统字体，15 像素；说明、缩略图上的页码用 13 像素以下的小字。
- 新加的输入框，字至少 16 像素（输入页码的那个用 18）：iPad 上比这小的输入框一点就会把页面放大。
- Claude 写在纸上的字用手写体（`ai-note`），不加框、不加底色，看上去是写在纸上的，不是贴上去的标签。
- 数字（页码、「3/12」）用等宽数字，翻页时不左右跳。
- 按钮名写清做什么、去哪：「退出全屏」「更新这本」「提交回答」，不写「确定」「好的」。菜单里会再问一句的项后面带「…」。

## Layout

- 全屏时浮在纸上的只有两处：左上角一排、右下角一条。新加的控件先想能不能进这两处或抽屉，不在纸上再开第三处。
- 全屏时屏幕顶端 44 像素（`top-safe`）这一条，碰了 Safari 会退出全屏：能拖动的那一条、新手引导的标签不放进去。左上角那一排是固定在那里的，不再往这一条里加别的。
- 会弹出来、要用户点的东西（长回答的卡片、问话卡片、输入页码的小框、小单子）放在屏幕上半边：写字的手掌和手环在下半边，键盘也从下面出来。
- 右下角那一条能按住把手拖走，位置记在设备上：左手写字、手会挡住时自己挪。
- 常用的开关不放在会被长列表挤到屏幕外的地方。抽屉里本子很多时，开关要在不用滑就看得见的位置。
- 能点到的范围至少 44×44（`touch-target`）。按钮看上去可以小一点，但四周要留出点得到的范围；紧挨着的两个按钮各让一半。

## Elevation & Depth

三层：纸；浮在纸上的控件（半透明暖白底、细边框、很淡的阴影）；小面板和卡片（暖白底、细边框、稍重一点的阴影）。
不用遮罩把纸变暗：新手引导、小面板打开时，纸和字照原样看得见。

## Shapes

- 普通按钮和输入框圆角 8，小面板 12。
- 浮在纸上的按钮是圆的（高 36 或 40，圆角是高的一半），那一条自己的圆角 24。
- 图标是细线条画的，不填色；线条用深色，在暖白底上看得清。

## Components

- **「AI」按钮**：把这一页交给 Claude。最小宽度按最长的那几个字算好，换字（已交、排队中、Claude 在看、在改文件）时不变宽变窄。
- **圈号**：长回答不上纸，只在所答的那句旁边标一个蓝色圈号，点开是一张浮在纸上的卡片。
- **短批注**：蓝色手写体，用细线连到所指的笔迹；被后来写的字压到就收成一个小蓝点。
- **小面板、小菜单**：出现在点的那个东西旁边；点外面或再点一次入口就收起。菜单入口要长得像菜单（☰、⋯、▾）。
- **提示条**：屏幕上方居中，几秒后自己收起，不挡点按（盖在别的按钮上时照样点得到下面的）；只有带「撤销」「去看看」的那个按钮接点按。
- **拖动**：按住约半秒才抓起（本子、缩略图），之前挪动了就算滚动；放下后屏幕上方说一句，带「撤销」。把本子放进文件夹不拖也能办（「⋯」里的「放进文件夹…」）。

## Do's and Don'ts

该做的：

- 改界面前先把这份文件和《产品定义与决定》第 2 节对一遍。
- 新加或挪动一个控件前问三件事：本子很多、屏幕竖着时它还看得见吗；戴着手环的手搭在屏幕上会不会碰到它；它是不是看一眼就知道能点、点了会怎样。
- 单指的手势都要想到可能是手掌或手环碰的。换东西用按钮，不用滑动。
- 界面上新加的每句中文，在 `inkthink/static/i18n.js` 里配上英文。
- 改界面的方案先出两三个样子（截图）给作者挑，再动正式的。

不该做的：

- 不改用户笔迹的样子：不变淡、不变色、不自动挪走。防遮挡靠收起，不靠变淡。（套索挪动是用户自己动的手，不算。）
- 写字的时候不在笔附近弹东西；提示放在屏幕上方，不放在正写着的地方。
- 不把切换类的开关（单页 / 连续、全屏 / 退出全屏）为了「精简」拿掉或藏进更深的菜单。
- 不用红色表示界面状态：红色是用户的红笔。
- 不为 Claude 的东西预留一块地方；它自己找空白，没有就收成圈号或小蓝点。
- 不用两指轻点、双击这类容易误触的手势去改内容。
