// 语言切换（中文 / English）。
// 页面上的中文是原文，代码别处不用改：选了英文时，这里在文字显示出来之前按对照表把它换掉
//（页面一开始的文字、之后脚本写进去的文字、提示条、确认对话框都经过这里）。表里没有的照原样显示。
// 选语言：抽屉最下面的「中文 / English」；或地址带 ?lang=en、?lang=zh（会记住）；没选过就跟浏览器的语言。
// 你写的字、本子名、Claude 的回答不翻译。
(function () {
  'use strict';
  const KEY = 'ink.lang';
  const asked = new URLSearchParams(location.search).get('lang');
  let lang = asked === 'en' || asked === 'zh' ? asked : null; // 地址里写了就以它为准
  try {
    if (lang) localStorage.setItem(KEY, lang);
    else lang = localStorage.getItem(KEY);
  } catch (e) { /* 存不了、读不了就只看地址和浏览器 */ }
  if (lang !== 'en' && lang !== 'zh') lang = /^zh\b/i.test(navigator.language || 'zh') ? 'zh' : 'en';

  // 整句对照：键是页面上出现的中文（去掉首尾空白）
  const EXACT = {
    // 右下角一条、左上角、出问题时的一句话（「AI」按钮平时的字没有中文，两种界面都是 AI）
    '退出全屏：显示顶栏和左侧工具栏': 'Exit full screen: show the top bar and the left toolbar',
    '按住拖动工具条': 'Hold and drag to move the toolbar',
    '连续': 'Continuous',
    '单页': 'Single page',
    '适配宽度': 'Fit width',
    '整页': 'Whole page',
    // 黑笔、红笔、橡皮的长按说明：左侧工具栏和右下角那一条上一字不差（index.html）
    '黑笔：你自己的推导和草稿': 'Black pen: your own working and drafts',
    '红笔：明确要 Claude 处理的事': 'Red pen: what you want Claude to handle',
    '橡皮：也能擦 Claude 的蓝字': "Eraser: also erases Claude's blue ink",
    '套索：圈住你的几笔，按住框里拖到别处': 'Lasso: circle some of your strokes, then press inside the box and drag them elsewhere',
    '撤销': 'Undo',
    '恢复': 'Redo', // 撤销旁边那个（2026-11-16 夜以前叫「重做」）；「显示已删的页」里把页放回来的按钮叫「还原」（Restore）
    '本子和页面': 'Notebooks and pages',
    '这一页还没写字': 'Nothing written on this page yet',
    '连不上电脑': 'Cannot reach the computer',
    '连不上电脑：新写的字还没存上，先别刷新这一页': 'Cannot reach the computer. Your new ink is not saved yet: do not refresh this page',
    '新写的字还没存上，正在重试；先别刷新这一页': 'Your new ink is not saved yet, retrying. Do not refresh this page',
    '没有可以撤销的': 'Nothing to undo',
    '没有可以恢复的': 'Nothing to redo',
    '＋ 加长': '＋ Longer',
    '＋ 向上加长': '＋ Up',
    '这个方向已经扩得够多了': 'The paper cannot grow any further this way',
    '这一页加长了': 'Page made longer',
    '这一页加宽了（页边往右挪了）': 'Page made wider (the margin moved further right)',
    '上面加了一块纸': 'Paper added above',
    '左边加了一块纸': 'Paper added on the left',
    // 用笔回应蓝字
    '采纳': 'Adopted',
    '不采纳': 'Declined',
    '已采纳': 'Adopted',
    '取消采纳': 'No longer adopted',
    '采纳：深蓝实线（撤销可以收回）': 'Adopted: shown in solid dark blue (Undo takes it back)',
    '取消了，还没定': 'Cleared: not decided yet',
    '采纳（下次点「AI」时带给 Claude，撤销可以收回）': 'Adopted (goes to Claude the next time you tap AI; Undo takes it back)',
    '不采纳（下次点「AI」时带给 Claude，撤销可以收回）': 'Declined (goes to Claude the next time you tap AI; Undo takes it back)',
    '蓝字用笔回应：旁边画个星号采纳；不要的用橡皮擦': 'Answer blue ink with the pen: draw a star beside it to adopt it, erase it if you do not want it',
    // 空白本子里被字压到的短批注收成小蓝点（阶段 D1）
    '被字压到的批注收成了小蓝点，点一下能看': 'A note under your writing folded into a small blue dot. Tap it to read',
    // 长回答的卡片（点圈号浮出）；卡片顶上换到这一页上一条、下一条回答的两个按钮
    '之前的版本': 'Earlier versions',
    '‹ 上一条': '‹ Previous',
    '下一条 ›': 'Next ›',
    '已改': 'Done',
    '没改成': 'Not changed',
    '改着呢…': 'Working on it…',
    // 这一轮到哪一步：「AI」按钮上的字（AI → 已交 → Claude 在看 → 在改文件；排队中；这本只在本地）。进度只写在按钮上
    '已交': 'Sent',
    '排队中': 'Queued',
    '只在本地': 'Local only', // 也写在抽屉里只在本地的本子名字后面
    'Claude 在看': 'Reading', // 写在「AI」按钮上：英文写全了按钮要宽出一截
    '在改文件': 'Editing files',
    'Claude 看了一眼这一页': 'Claude looked at this page',
    '去看看': 'Go there',
    '打开': 'Open',
    // 抽屉
    '本子': 'Notebooks',
    '草稿本': 'Scratchpad',
    'Claude 推送': 'Pushed by Claude',
    '＋ 新建本子…': '＋ New notebook…',
    '＋ 新建文件夹…': '＋ New folder…',
    '导入文档…': 'Import a document…',
    '这本发往哪个对话：点一下换': 'Which session this notebook is sent to: tap to change',
    '这本发往：': 'Sends to:',
    '页面': 'Pages',
    // 缩略图上页码后面的小字：书里插进去的空白页、PPT 的隐藏页
    '空白': 'blank',
    '隐藏页': 'hidden slide',
    '这一页连同写的字左转 90°': 'Rotate this page and its ink 90° left',
    '这一页连同写的字右转 90°': 'Rotate this page and its ink 90° right',
    '在这一页后面加一张竖版空白页': 'Add a blank portrait page after this one',
    '在这一页后面加一张横版空白页': 'Add a blank landscape page after this one',
    '删除这一页（可以在「显示已删的页」里还原）': 'Delete this page (restore it under “Show deleted pages”)',
    '显示已删的页': 'Show deleted pages',
    '这本没有删掉的页。': 'This notebook has no deleted pages.',
    '（写过字）': '(has ink)',
    '还原': 'Restore', // 「显示已删的页」里把页放回来（2026-11-16 夜以前叫「恢复」）
    '最后一页不能删': 'The last page cannot be deleted',
    '已删除这一页（可以还原）': 'Page deleted (it can be restored)',
    // 拖缩略图换页序（2026-11-16）：还有字没存上时不挪；服务说页序在别处改过了；点「撤销」时已经换了本子
    '有字还没存上，等存好了再挪页': 'Some ink is not saved yet. Move the page once it is saved',
    '页的先后在别处改过了：重新打开这本再挪': 'The page order was changed elsewhere: reopen this notebook and try again',
    '已经换了本子': 'You have switched to another notebook',
    '改名': 'Rename',
    '改成什么名字？': 'New name?',
    '删除这本（文件还留在电脑上）': 'Delete this notebook (the files stay on the computer)',
    '存回 PDF：把这本上的手写和 Claude 的批注写进原 PDF 文件（先留底，存完能撤回）': "Save back to PDF: write this notebook's ink and Claude's annotations into the original PDF (the original is kept first, so you can revert)",
    // 一本右边的「⋯」点开的小菜单（2026-11-16 起代替原来那排图标）
    '更多操作': 'More actions',
    '放进文件夹…': 'Move to a folder…',
    '改名…': 'Rename…',
    '存回 PDF': 'Save back to PDF',
    '删除这本…': 'Delete this notebook…',
    '昨天': 'Yesterday',
    '刚刚': 'just now',
    // 抽屉里的文件夹
    '文件夹：放进哪个文件夹、移出文件夹、新建文件夹': 'Folder: put this notebook into a folder, take it out, or make a new folder',
    '改这个文件夹的名字': 'Rename this folder',
    '删除这个文件夹（里面的本子回到外面，本子本身不动）': 'Delete this folder (its notebooks move back out; the notebooks themselves are untouched)',
    '放进哪个文件夹': 'Move to folder',
    '还没有文件夹': 'No folders yet',
    '移出文件夹': 'Take it out of the folder',
    '新建文件夹…': 'New folder…',
    '新建文件夹': 'New folder',
    '文件夹改名': 'Rename the folder',
    '文件夹的名字': 'Folder name',
    '好': 'OK',
    '已移出文件夹': 'Taken out of the folder',
    '已放回文件夹外面': 'Moved back out of the folder', // 拖进文件夹后点「撤销」
    // 这本发往哪个对话（按项目文件夹分组；每个对话写最近打的一句话、什么时候开的、多久前活跃）；最下面一项是只在本地
    '这本发往哪个对话（以后都发到这里）': 'Which session this notebook is sent to (from now on)',
    '还没打过字': 'Nothing typed there yet',
    '执行过 /ink': 'ran /ink',
    '不发给 Claude（只在本地）': 'Do not send to Claude (local only)',
    '只在本地（不发给 Claude）': 'Local only (not sent to Claude)',
    '还没有连着的对话': 'no session connected yet',
    '还没有连上的对话：在电脑上打开一个装了 inkpad 插件的 Claude Code 对话': 'No session connected yet: open a Claude Code session with the inkpad plugin on the computer',
    '没有连着的 Claude Code 对话。在电脑上的对话里执行一次 /ink，或者从平板上传。': 'No Claude Code session connected. Run /ink once in a session on the computer, or upload from this tablet.',
    '取消': 'Cancel',
    // 新建本子
    '新建本子': 'New notebook',
    '新本子': 'New notebook',
    '名字，比如：随笔、想法、读书笔记': 'Name, e.g. Notes, Ideas, Reading notes',
    '纸张方向': 'Paper orientation',
    '竖版纸': 'Portrait',
    '横版纸': 'Landscape',
    '黑笔写你自己的；想让 Claude 做什么，用红笔写。': 'Write your own work in black. To have Claude do something, write it in red.',
    '建立': 'Create',
    // 访问码
    '需要访问码': 'Access code needed',
    '在电脑上打开二维码页扫码，或输入服务启动时打印的访问码（链接里': 'Scan the QR code shown on the computer, or type the access code printed when the server started (the part after',
    '后面那段）。': 'in the link).',
    '进入': 'Enter',
    '访问码不对': 'Wrong access code',
    // 确认字迹
    'Claude 想确认字迹': 'Claude wants to check your handwriting',
    '稍后': 'Later',
    '回答': 'Answer',
    '看不清，跳过': 'Cannot tell, skip',
    '翻到那页': 'Go to that page',
    '都不对就在这里写（可以用笔直接写）': 'None of these? Write it here (the pen works)',
    '在这里写（可以用笔直接写）': 'Write it here (the pen works)',
    '已告诉 Claude': 'Claude has been told',
    // 顶上的卡片（问话卡片、字迹确认卡片）和缩成的那一小条
    '收成顶上一小条，点它再打开': 'Fold it into the strip at the top; tap the strip to open it again',
    '点一下展开卡片': 'Tap to open the card',
    '知道了': 'Got it',
    '重写': 'Clear',
    '提交回答': 'Send answer',
    '或者用笔写在下面': 'Or write your answer below with the pen',
    '用笔写在下面': 'Write your answer below with the pen',
    '这张卡片已经回答过或过期了': 'This card was already answered or has expired',
    '回答是空的：点一个选项，或用笔写了再交': 'The answer is empty: tap an option, or write with the pen before sending',
    '卡片上没有这个选项': 'That option is not on the card',
    '这张卡片不收手写回答': 'This card does not take a handwritten answer',
    '手写回答的图不是 PNG': 'The handwritten answer is not a PNG image',
    '手写回答的图太大': 'The handwritten answer image is too large',
    // 卡片上的「忽略」（不答了，这张消失、不算回答）；服务自己问的「覆盖还是另存」的两个选项
    '忽略': 'Ignore',
    '覆盖': 'Overwrite',
    '另存': 'Save as a copy',
    // 撤回 Claude 对原文件的修改、存回 PDF（右上角提示条、抽屉、顶上问的一句、之后的提示；纸上建议的状态）
    '撤回这次修改': 'Revert this edit',
    '再往回撤一次': 'Revert one more step',
    '撤回上次修改': 'Revert the last edit',
    '撤回修改': 'Revert an edit',
    '撤回': 'Revert',
    '已撤回': 'Reverted',
    '正在撤回…': 'Reverting…',
    '没有可撤回的修改了': 'There is no edit left to revert',
    '这个文件在那次修改之后又改过，撤回会连后来的改动一起回退；现在这份会另留一份，要用可以让 Claude 找回。':
      'This file was changed again after that edit. Reverting also rolls back the later changes; the current version is kept as a separate copy, and Claude can find it for you if you need it.',
    '那一版的留底用不了（可能被手动删了），这条记录已去掉；文件没动，再点撤回会接着撤更早的一次':
      'The kept copy of that version cannot be used (it may have been deleted by hand), so the record was dropped. The file was not touched; tap Revert again to go one step further back',
    '没撤回：文件可能正被 Word、PowerPoint 等程序开着，或者没有权限写；关掉后再撤。电脑上的文件没动':
      'Not reverted: the file may be open in Word, PowerPoint or another program, or it cannot be written. Close it and try again. The file on the computer was not touched',
    '只有从电脑上的文件导入的本子能撤回修改': 'Only notebooks imported from a file on the computer can have edits reverted',
    '这本不是从电脑上的文件导入的，没有可撤回的修改': 'This notebook was not imported from a file on the computer, so there is no edit to revert',
    '要撤回的那一次已经变了（可能在别的设备上撤回过）：没撤回。再点一次撤回看看。': 'The edit to revert has changed (it may have been reverted on another device), so nothing was reverted. Tap Revert again.',
    '这个文件在你确认之后又改过了：没撤回。再点一次撤回，确认时会说明。': 'The file changed again after you confirmed, so nothing was reverted. Tap Revert again; the confirmation will explain.',
    // 导入
    '导入文档': 'Import a document',
    '电脑文件夹': 'Computer folder',
    '电脑上的文件夹': 'Folder on the computer',
    '哪个对话的文件夹': "Which session's folder",
    '搜标题、作者、年份': 'Search title, author, year',
    '从平板上传…': 'Upload from this tablet…',
    '最近改过的': 'Recently changed',
    '文件夹里': 'In this folder',
    // 能导入哪几种：三处说法一样（server.py 的 IMPORT_KINDS）
    '这里没有能导入的文件（PDF、PPT、Word、EPUB、图片、Markdown 和纯文本）。': 'Nothing to import here (PDF, PowerPoint, Word, EPUB, images, Markdown and plain text).',
    '原文件改过 · 点一下更新': 'Source file changed · tap to update',
    '已导入 ›': 'Imported ›',
    '替换旧版': 'Replace the old version',
    '另加一本': 'Add as a new notebook',
    '正在读 Zotero…': 'Reading Zotero…',
    '没有找到': 'Nothing found',
    '最近添加': 'Recently added',
    '这个分类里没有文献': 'No items in this collection',
    '分类': 'Collections',
    '这篇在 Zotero 里没有 PDF': 'This item has no PDF in Zotero',
    // Zotero 的出错提示（电脑上的服务 zotero.py 回的话，2026-11-15 补）和列表里每篇下面那行小字里的文献类型
    'Zotero 条目编号不对': 'That is not a valid Zotero item key',
    'Zotero 没开本机接口：设置 → 高级 → 勾选「允许此计算机上的其他应用程序与 Zotero 通信」':
      'Zotero’s local API is off: in Zotero, go to Settings → Advanced and tick “Allow other applications on this computer to communicate with Zotero”',
    'Zotero 里没有这一项': 'That item is not in Zotero',
    '连不上 Zotero：先在电脑上打开 Zotero': 'Cannot reach Zotero: open Zotero on the computer first',
    'Zotero 里这篇的 PDF 文件找不到了': 'The PDF file of this item cannot be found in Zotero',
    '没有 PDF': 'no PDF',
    '期刊文章': 'Journal article', '会议论文': 'Conference paper', '学位论文': 'Thesis', '图书': 'Book', '图书章节': 'Book section',
    '专利': 'Patent', '报告': 'Report', '预印本': 'Preprint', '手稿': 'Manuscript', '文档': 'Document', '标准': 'Standard',
    '网页': 'Web page', '演示文稿': 'Presentation', '杂志文章': 'Magazine article', '报纸文章': 'Newspaper article', '附件': 'Attachment',
    // 导入的文档更新了（右上角那一条和提示）：改了哪几页，用「；」连着的几段（RULES 里一段段换）
    '内容没有变化': 'No changes in the content',
    '已打开': 'Opened',
    '空白草稿纸': 'blank paper',
    // 保存和连接
    '（已换成那边的版本）': '(switched to the other version)',
    '问：': 'Q: ',
    '红字：': 'Your red note: ', // 长回答卡片上 Claude 接着回的一段前面：它回应的那句红字
    '撤销的是卡片上的红字': 'Undid red ink on an answer card',
    '恢复的是卡片上的红字': 'Redid red ink on an answer card',
    '电脑浏览器': 'Computer browser',
    '（主屏幕）': '(home screen)',
    // 顶栏、左侧工具栏、⋯ 菜单、提示条上的固定文字
    '上一页': 'Previous page',
    '下一页': 'Next page',
    // 点页码出的输入页码的小框（2026-11-16 夜）：翻到第 [ ] 页（共 N 页）[去]；超出范围时那一句、「回到第 N 页」在 RULES 里
    '输入页码翻页': 'Go to a page by number',
    '翻到第': 'Go to page',
    '页码': 'Page number',
    '去': 'Go',
    '有新回答的页': 'Pages with new answers', // 点「几页有新回答」出的小单子
    '连续阅读：上下页接在一起，滚到哪页写哪页': 'Continuous: pages joined top to bottom; you write on whichever page you scroll to',
    '单页：一页一页翻': 'Single page: one page at a time',
    // 左上角和顶栏上的「单页 / 连续」一对图标、加页图标的说明（长按看）；「单页」那个和上面切到单页时的提示是同一句
    '连续：上下页接在一起': 'Continuous: pages joined top to bottom',
    '在这一页后面加一张空白页': 'Add a blank page after this one',
    '更多': 'More',
    '橡皮': 'Eraser',
    '套索': 'Lasso', // 新手引导里套索旁的小标签
    '全屏：隐藏浏览器界面、收起上栏和工具栏，只留纸': 'Full screen: hide the browser bars and the toolbars, leaving only the paper',
    '全屏': 'Full screen',
    '收起': 'Collapse',
    '退出全屏': 'Exit full screen',
    '显示 Claude 的批注': "Show Claude's annotations",
    '手指也能书写': 'Fingers can write too',
    '画线停住变直': 'Pause to straighten a line', // 「⋯」菜单和抽屉最下面的开关
    '回放本页书写过程': 'Replay how this page was written',
    // 「Claude 读到了什么」（阶段 D2）：「⋯」菜单和抽屉最下面的开关
    'Claude 读到了什么': 'What Claude read',
    '这一页还没有 Claude 读过的字': 'Claude has not read anything on this page yet',
    // 新手引导（阶段 D2）：按钮旁的小标签、中间的说明、再看一遍的入口
    '新手引导': 'Getting started',
    '再看一遍新手引导': 'Show the getting-started guide again',
    '翻页': 'Turn pages',
    '单页 / 连续': 'Single / continuous',
    '加一页': 'Add a page',
    '按住拖动': 'Hold to drag',
    '显示工具栏': 'Show the toolbars',
    '只留纸': 'Paper only',
    '黑笔': 'Black pen',
    '红笔': 'Red pen',
    '交给 Claude': 'Hand to Claude',
    '写你自己的草稿和推导': 'Your own drafts and working',
    '写给 Claude 的话：问题或要求': 'What you tell Claude: a question or a request',
    '写完点它，交给 Claude': 'Tap it when you are done, to hand the page to Claude',
    '蓝字': 'Blue ink',
    'Claude 回在纸上；长的收在圈号里，点圈号看': 'Claude answers on the paper; a long answer folds into a numbered circle, tap it to read',
    // 新文件提示（阶段 D2）：屏幕上方那一条、抽屉最上面那一组
    '新文件': 'New files',
    '全部忽略': 'Ignore all',
    '加入': 'Add',
    '来自': 'From',
    'Claude 生成了': 'Claude made',
    '在抽屉里看': 'See them in the drawer',
    '这个文件提示已经过期': 'This file notice has expired',
    '整页 / 适配宽度': 'Whole page / fit width',
    '清除本页 Claude 批注': "Clear Claude's annotations on this page",
    '清除本页所有 Claude 批注？（笔迹不受影响）': "Clear all of Claude's annotations on this page? (Your ink is not affected.)",
    '已清除本页 Claude 批注（点撤销能找回）': "Cleared Claude's annotations on this page (Undo brings them back)",
    '关闭': 'Close',
    '本页还没有笔迹': 'No ink on this page yet',
    '回放中（2 倍速，长停顿已压缩），点一下页面停止': 'Replaying (2× speed, long pauses shortened). Tap the page to stop',
    '重新转换': 'Convert again',
    '更新这本': 'Update this notebook',
    '回到新版': 'Back to the new version',
    '这一页是更新后新加的': 'This page was added by the update',
    '对比旧版': 'Compare with the old version',
    // 电脑上的服务回给页面的话
    '可以导入 PDF、PPT、Word、EPUB、图片、Markdown 和纯文本': 'PDF, PowerPoint, Word, EPUB, images, Markdown and plain text can be imported',
    '名字是空的': 'The name is empty',
    '没有连上的 Claude Code 对话。在电脑上打开一个装了 inkpad 插件的对话再试。': 'No Claude Code session connected. Open a session with the inkpad plugin on the computer and try again.',
    '这个对话已经断开了': 'That session has disconnected',
    '这个对话没连着，或不知道它在哪个文件夹': 'That session is not connected, or its folder is unknown',
    '只能浏览对话所在的文件夹': "Only the session's own folder can be browsed",
    '没有这个文件夹': 'No such folder',
    '没有这一页': 'No such page',
    '这本里没有新写的页': 'No pages with new ink in this notebook',
    '草稿本和「Claude 推送」不能删': 'The scratchpad and “Pushed by Claude” cannot be deleted',
    '草稿本和「Claude 推送」不能改名': 'The scratchpad and “Pushed by Claude” cannot be renamed',
    '没有安装 PyMuPDF，不能导入文档': 'PyMuPDF is not installed, so documents cannot be imported',
    '这个文件不能导入': 'This file cannot be imported',
    '图太大（超过 20 MB）': 'Image too large (over 20 MB)',
    '这张确认卡片已经回答过或过期了': 'This card was already answered or has expired',
    '那一页已经从本子里删掉了（可以在平板抽屉的「显示已删的页」里还原）': 'That page was deleted from the notebook (restore it under “Show deleted pages” in the drawer)',
    '原文件在导入后改过：先更新这本，再存回': 'The source file changed after it was imported: update this notebook first, then save back',
    '只有导入的 PDF 能存回': 'Only imported PDFs can be saved back',
    '只有导入的文档能更新': 'Only imported documents can be updated',
    '找不到这本的原文件（只有从电脑上的文件导入的才能更新）': 'The source file of this notebook cannot be found (only notebooks imported from a file on the computer can be updated)',
    '这本不是从电脑上的 PDF 导入的，没有可以存回的原文件': 'This notebook was not imported from a PDF on the computer, so there is no source file to save back to',
    // 电脑上的二维码页
    'ThinkPaper 连接平板': 'ThinkPaper: connect a tablet',
    'ThinkPaper 草稿纸': 'ThinkPaper',
    '用平板扫码打开草稿纸': 'Scan with the tablet to open the paper',
    '先试这个（这次的 IP 地址）': 'Try this one first (the current IP address)',
    '上面那个打不开再试': 'Try this if the one above does not open',
    '固定地址：换了网络、IP 变了也能用': 'Stable address: still works after the network or IP changes',
    '有的网络屏蔽这种地址，打不开就用左边的': 'Some networks block this kind of address. If it does not open, use the one on the left',
    '没找到局域网地址，检查电脑是否连着 Wi-Fi。': 'No local network address found. Check that the computer is on Wi-Fi.',
    // 手册只有中文：英文这句不写那一节的中文标题，说清是哪一份、哪一节
    '扫了打不开时：确认 Windows 防火墙已允许（见 inkthink\\README.md 的「出了问题」一节）；有些公共/校园 Wi-Fi 禁止设备互访，可改用电脑开的移动热点。':
      'If it does not open: make sure the Windows firewall allows it (see the troubleshooting section of inkthink\\README.md; the manual is in Chinese). Some public or campus Wi-Fi networks stop devices from reaching each other; a hotspot from the computer works around that.',
    '设备与安全': 'Devices and security',
    '扫码打开过的设备会换到一个只属于它的凭据。断开一台设备时会同时换访问码（它可能还记着旧地址）；你别的设备照常用，新设备扫新的二维码。': 'A device that has opened the page by QR code gets a token of its own. Disconnecting a device also changes the access code (it may still remember the old address). Your other devices keep working; new devices scan the new QR code.',
    '读取中…': 'Loading…',
    '更换访问码': 'Change the access code',
    '停止服务': 'Stop the server',
    '换了访问码之后，新设备要扫新的二维码。确定换？': 'After the change, new devices have to scan the new QR code. Change it?',
    '停止草稿纸服务？平板会连不上，插件也不会自动重新启动；要再用就在对话里输入 /ink。': 'Stop the server? The tablet will lose its connection and the plugin will not restart it. To use it again, run /ink in a session.',
    '服务已停止': 'Server stopped',
    '要再用，在 Claude Code 对话里输入 /ink。': 'To use it again, run /ink in a Claude Code session.',
    '没成功': 'That did not work',
    '还没有设备配对过。': 'No device has been paired yet.',
    '这次启动后还没连过': 'not connected since this start',
    '断开': 'Disconnect',
    '（还没有。在 Claude Code 里装好 inkpad 插件后，打开的对话会出现在这里）': '(none yet: once the inkpad plugin is installed in Claude Code, open sessions appear here)',
  };

  const FAIL = {
    '没换成': 'Could not switch', '没设成': 'Could not set', '没改成': 'Could not rename', '没删成': 'Could not delete',
    '没存成': 'Could not save', '没更新成': 'Could not update', '没加成': 'Could not add', '没还原成': 'Could not restore',
    '没建成': 'Could not create', '没导入成': 'Could not import', '导入失败': 'Import failed', '没放成': 'Could not move',
    '没挪成': 'Could not move the page', '没挪回去': 'Could not move the page back',
    '背景加载失败': 'Could not load the page background', '打不开这个本子': 'Cannot open this notebook',
    '打不开这个文件夹': 'Cannot open this folder', '连不上电脑上的服务': 'Cannot reach the server on the computer',
    '没发出去': 'Not sent', '没撤回': 'Could not revert', '没忽略成': 'Could not ignore',
  };
  // 「2、3」这样的页码 → 「pages 2, 3」（一页是「page 2」）
  const pagesEn = (s) => `${s.includes('、') ? 'pages' : 'page'} ${s.replace(/、/g, ', ')}`;
  // 带变化内容的句子：[匹配整句的正则, 换成什么]；{1}、{2} 是括号里抓到的内容（会再过一遍对照表）
  const RULES = [
    [/^第 (\d+) 页$/, 'Page {1}'],
    // 长回答卡片顶上的上一条、下一条要跨页时（2026-11-16 夜）：写出去哪一页
    [/^‹ 上一条（第 (\d+) 页）$/, '‹ Previous (page {1})'],
    [/^下一条（第 (\d+) 页）›$/, 'Next (page {1}) ›'],
    [/^被字压到的 (\d+) 条批注收成了小蓝点，点一下能看$/, '{1} notes under your writing folded into small blue dots. Tap one to read'],
    [/^（(\d+) 页(?:，已删 (\d+) 页)?）$/, (m) => `(${m[1]} ${m[1] === '1' ? 'page' : 'pages'}${m[2] ? `, ${m[2]} deleted` : ''})`],
    [/^已交给「(.+)」$/, 'Handed to “{1}”'],
    [/^已把 (\d+) 页交给「(.+)」$/, 'Handed {1} pages to “{2}”'],
    [/^这本发往：(.*?)( ▾)?$/, (m, t) => `Sends to: ${t(m[1])}${m[2] || ''}`],
    [/^「(.+)」（不在了）$/, '“{1}” (gone)'],
    [/^这本原来发往「(.+)」，那个对话现在不在了。发往：$/, 'This notebook used to go to “{1}”, which is gone now. Send it to:'],
    [/^(\d+) 分钟前$/, '{1} min ago'],
    [/^(\d+) 小时前$/, '{1} h ago'],
    [/^(\d+) 天前$/, '{1} d ago'],
    // 「这本发往」的列表里每个对话下面那行小字：什么时候开的 · 多久前活跃 · 执行过 /ink（用「 · 」连着的几段，最后那条规则一段段换）
    [/^(今天|昨天) (\d\d:\d\d) 开的$/, (m) => `opened ${m[1] === '今天' ? 'today' : 'yesterday'} ${m[2]}`],
    [/^(\d+)月(\d+)日 (\d\d:\d\d) 开的$/, 'opened {1}/{2} {3}'],
    [/^(刚刚|\d+ 分钟前|\d+ 小时前|\d+ 天前)活跃$/, (m, t) => `active ${t(m[1])}`],
    // 同一个文件夹开着几个对话、那个对话还没打过字：名字后面写什么时候开的
    [/^(.+)（((?:今天|昨天) \d\d:\d\d|\d+月\d+日 \d\d:\d\d) 开的）$/, (m, t) => `${m[1]} (${t(m[2] + ' 开的')})`],
    // 抽屉里的文件夹
    [/^(\d+) 本$/, (m) => `${m[1]} ${m[1] === '1' ? 'notebook' : 'notebooks'}`],
    [/^已放进「(.+)」$/, 'Moved into “{1}”'],
    [/^已放回「(.+)」$/, 'Moved back into “{1}”'],
    [/^已建立文件夹「(.+)」$/, 'Created the folder “{1}”'],
    [/^已删除文件夹「(.+)」$/, 'Deleted the folder “{1}”'],
    [/^删除文件夹「(.+)」？\n里面的 (\d+) 本回到外面，本子本身不动。$/, (m) => `Delete the folder “${m[1]}”?\nIts ${m[2]} ${m[2] === '1' ? 'notebook moves' : 'notebooks move'} back out; the notebooks themselves are untouched.`],
    [/^已经有一个叫「(.+)」的文件夹了$/, 'There is already a folder called “{1}”'],
    [/^今天 (\d\d:\d\d)$/, 'Today {1}'],
    [/^(\d+)月(\d+)日$/, '{1}/{2}'],
    [/^已建立「(.+)」$/, 'Created “{1}”'],
    [/^已改名为「(.+)」$/, 'Renamed to “{1}”'],
    [/^已删除「(.+)」。文件还留在电脑上，要找回就让 Claude 帮你挪回来。$/, 'Deleted “{1}”. The files stay on the computer. To get them back, ask Claude to move them back.'],
    [/^从列表里删除「(.+)」？\n上面的手写还留在电脑上，要找回就让 Claude 帮你挪回来。$/, 'Remove “{1}” from the list?\nThe handwriting stays on the computer. To get it back, ask Claude to move it back.'],
    [/^从列表里删除《(.+)》？\n文件和上面的手写都还留在电脑上，要找回就让 Claude 帮你挪回来。$/, 'Remove “{1}” from the list?\nThe file and the handwriting stay on the computer. To get them back, ask Claude to move them back.'],
    [/^这一页写过字，确定从本子里删掉？\n可以在抽屉的「显示已删的页」里还原。$/, 'This page has ink on it. Delete it from the notebook?\nYou can restore it under “Show deleted pages” in the drawer.'],
    [/^已在第 (\d+) 页后加了一张空白页$/, 'Added a blank page after page {1}'],
    [/^第 (\d+) 页挪到了第 (\d+) 页$/, 'Moved page {1} to page {2}'],
    [/^已挪回第 (\d+) 页$/, 'Moved it back to page {1}'],
    // 输入页码的小框（2026-11-16 夜）：总页数、超出范围时说的一句、回到跳之前的那一页
    [/^页（共 (\d+) 页）$/, 'of {1}'],
    [/^要输入 1 到 (\d+) 之间的页码$/, 'Enter a page number from 1 to {1}'],
    [/^回到第 (\d+) 页$/, 'Back to page {1}'],
    [/^(.+) 想确认字迹$/, '{1} wants to check your handwriting'],
    // 问话卡片的头一行、缩成的小条：谁在问、谁的结果、还排着几张
    [/^(.+) 问你$/, '{1} asks you'],
    [/^(.+) 问：$/, '{1} asks: '],
    [/^(.+) 的结果$/, 'Result from {1}'],
    [/^(.+) 的结果：$/, 'Result from {1}: '],
    [/^还有 (\d+) 张$/, (m) => `${m[1]} more`],
    [/^全部忽略（(\d+) 张）$/, 'Ignore all ({1})'],
    [/^已忽略 (\d+) 张卡片$/, (m) => `Ignored ${m[1]} ${m[1] === '1' ? 'card' : 'cards'}`],
    // 改文件前服务问的一句（问话卡片）；撤回前问的一句、撤回后的提示；存回 PDF 前问的一句
    [/^改《(.+)》：覆盖原文件，还是另存一份？$/, 'Edit “{1}”: overwrite the original file, or save a copy?'],
    [/^撤回对《(.+)》的另存？平板上这本换回原文件《(.+)》，另存出来的《(.+)》留在电脑上，不删。$/,
      'Revert saving “{1}” as a copy? This notebook switches back to the original file “{2}”; the copy “{3}” stays on the computer and is not deleted.'],
    [/^撤回对《(.+)》的上一次修改？电脑上的文件会回到修改之前。$/, 'Revert the last edit to “{1}”? The file on the computer goes back to how it was before the edit.'],
    [/^撤回对《(.+)》的上一次存回？电脑上的文件会回到存回之前。$/, 'Revert the last save-back to “{1}”? The file on the computer goes back to how it was before saving.'],
    [/^已撤回：《(.+)》回到了(修改|存回)之前(；后来又改过的那份另留了一份)?(?:（还能再往回撤 (\d+) 次）|（再往前没有留底了）)$/, (m) =>
      `Reverted: “${m[1]}” is back to how it was before the ${m[2] === '存回' ? 'save-back' : 'edit'}`
      + (m[3] ? '; the later version was kept as a separate copy' : '')
      + (m[4] ? ` (${m[4]} more ${m[4] === '1' ? 'step' : 'steps'} can be reverted)` : ' (nothing older is kept)')],
    [/^已撤回另存：这本换回了《(.*)》，《(.+)》留在电脑上$/, 'Reverted the copy: this notebook is back on “{1}”; “{2}” stays on the computer'],
    [/^把这本上的手写和 Claude 的批注写进原文件「(.+)」？\n写之前先把原文件留一份底，存完能撤回；以后再存会替换上次写进去的。$/,
      "Write this notebook's ink and Claude's annotations into the original file “{1}”?\nThe original is kept first, so you can revert after saving; saving again replaces what was written last time."],
    [/^撤回前没能把现在这份另留一份（(.*)）：没撤回，文件没动。$/, 'Could not keep a copy of the current version before reverting ({1}), so nothing was reverted and the file was not touched.'],
    [/^存之前没能把原文件留底（(.*)），这次没写进去，原文件没动$/, 'Could not keep the original before saving ({1}), so nothing was written and the original was not touched'],
    [/^Claude 的 (\d+) 条批注指着的字擦掉了，已收起（点撤销能找回）$/, "The ink that {1} of Claude's notes pointed at was erased, so they are folded away (Undo brings them back)"],
    [/^Claude 在别的页写了批注：(.*)$/, 'Claude wrote on another page: {1}'],
    // 页码旁「别的页有新回答」那个记号（2026-11-16 夜改样子）：几页时写几页，和它的说明（一页时翻过去，几页时点了列出来）
    [/^(\d+) 页有新回答$/, 'New on {1} pages'], // 写短一点：顶栏在 744 宽、英文时放得下
    [/^Claude 在第 (\d+) 页有新回答，点一下翻过去$/, 'New answers from Claude on page {1}; tap to go there'],
    [/^Claude 在第 ([\d、]+) 页有新回答，点一下列出来$/, (m) => `New answers from Claude on ${pagesEn(m[1])}; tap to list them`],
    [/^Claude 回了 (\d+) 条$/, (m) => `Claude replied with ${m[1]} ${m[1] === '1' ? 'answer' : 'answers'}`],
    [/^Claude 导入了《(.+)》$/, 'Claude imported “{1}”'],
    [/^Claude 推送了一页：(.*)$/, 'Claude pushed a page: {1}'],
    [/^正在导入 (.+?)…（要先转换，稍等）$/, 'Importing {1}… (converting it first; this takes a moment)'],
    [/^正在导入 (.+?)…$/, 'Importing {1}…'],
    [/^正在更新《(.+)》…（PPT\/Word 要先转换，稍等）$/, 'Updating “{1}”… (PowerPoint and Word files are converted first; this takes a moment)'],
    [/^正在更新《(.+)》…$/, 'Updating “{1}”…'],
    // 新文件提示（阶段 D2）
    [/^新文件（(\d+)）$/, 'New files ({1})'],
    [/^等 (\d+) 个文件$/, (m) => `and ${Number(m[1]) - 1} more`],
    [/^忽略这 (\d+) 个$/, 'Ignore these {1}'],
    [/^更新《(.+)》$/, 'Update “{1}”'],
    [/^替换《(.+)》$/, 'Replace “{1}”'],
    [/^正在加入 (.+?)…（要先转换，稍等）$/, 'Adding {1}… (converting it first; this takes a moment)'],
    [/^正在加入 (.+?)…$/, 'Adding {1}…'],
    [/^已加入《(.+)》$/, 'Added “{1}”'],
    [/^「(.+)」已经不在电脑上了（可能被删了或挪走了），这条提示收掉了$/, '“{1}” is no longer on the computer (it may have been deleted or moved), so the notice was removed'],
    [/^正在打开 (.+?)…$/, 'Opening {1}…'],
    [/^正在(打开|导入)《(.+)》…$/, (m) => `${m[1] === '打开' ? 'Opening' : 'Importing'} “${m[2]}”…`],
    [/^已(打开|导入)《(.+)》$/, (m) => `${m[1] === '打开' ? 'Opened' : 'Imported'} “${m[2]}”`],
    [/^找到 (\d+) 篇$/, '{1} found'],
    // Zotero 的出错提示、导入面板里的小字（2026-11-15 补）
    [/^Zotero 返回了错误（(\d+)）$/, 'Zotero returned an error ({1})'],
    [/^像是《(.+)》的新版$/, (m) => `looks like a new version of “${m[1]}”`],
    [/^› 搜索“(.*)”$/, (m) => `› Search “${m[1]}”`],
    // 存回 PDF（2026-11-15 补）：正在存、存好了写进去了什么、哪些没法写进去、哪几页还有没落下的回复
    [/^正在存回 (.+?)…$/, (m) => `Saving back to ${m[1]}…`],
    [/^已存回 (.+?)：(.+?)(?:（(.+)没法写进 PDF）)?(?:。第 (.+) 页还有 Claude 的 (\d+) 条回复没落到纸上，没写进去：翻到那几页后再存一次)?$/, (m) => {
      const part = (s) => s.split('、').map((x) => {
        let g;
        if ((g = /^手写 (\d+) 组$/.exec(x))) return `${g[1]} ${g[1] === '1' ? 'group' : 'groups'} of ink`;
        if ((g = /^Claude 批注 (\d+) 条$/.exec(x))) return `${g[1]} of Claude's annotations`;
        if ((g = /^页边和加长纸上的 (\d+) 组$/.exec(x))) return `${g[1]} ${g[1] === '1' ? 'group' : 'groups'} in the margin or on added paper`;
        if ((g = /^插入空白页上的 (\d+) 组$/.exec(x))) return `${g[1]} ${g[1] === '1' ? 'group' : 'groups'} on inserted blank pages`;
        if ((g = /^Claude 指着页面外的 (\d+) 条$/.exec(x))) return `${g[1]} of Claude's annotations pointing outside the page`;
        return null;
      });
      const done = part(m[2]), skip = m[3] ? part(m[3]) : [];
      if (done.includes(null) || skip.includes(null)) return null; // 有一段认不出：不换
      return `Saved back to ${m[1]}: ${done.join(', ')}` + (skip.length ? ` (${skip.join(', ')} could not be written into the PDF)` : '')
        + (m[4] ? `. ${pagesEn(m[4]).replace(/^p/, 'P')} still ${m[4].includes('、') ? 'have' : 'has'} ${m[5]} of Claude's replies`
          + ` not yet on the paper, so ${m[5] === '1' ? 'it was' : 'they were'} not written: turn to ${m[4].includes('、') ? 'those pages' : 'that page'} and save again` : '');
    }],
    // 导入的文档换了新版：「已换成新版（a → b）：……」「《某本》已更新：……」，后面是改了哪几页（服务端 change_summary，用「；」连着）
    [/^已换成新版（(.+) → (.+)）：([\s\S]+)$/, (m, t) => { const s = t(m[3]); return CJK.test(s) ? null : `Switched to the new version (${m[1]} → ${m[2]}): ${s}`; }],
    [/^《(.+)》已更新：([\s\S]+)$/, (m, t) => { const s = t(m[2]); return CJK.test(s) ? null : `“${m[1]}” updated: ${s}`; }],
    [/^第 ([\d、]+) 页有改动$/, (m) => `Changes on ${pagesEn(m[1])}`],
    [/^新增第 ([\d、]+) 页$/, (m) => `New ${pagesEn(m[1])}`],
    [/^删掉了旧版第 ([\d、]+) 页(（上面的手写另存了）)?$/, (m) => `Removed ${pagesEn(m[1])} of the old version${m[2] ? ' (the handwriting on them was kept separately)' : ''}`],
    [/^([^；]+)；([\s\S]+)$/, (m, t) => { const a = t(m[1]), b = t(m[2]); return CJK.test(a) || CJK.test(b) ? null : `${a}; ${b}`; }],
    [/^再显示 30 篇（共 (\d+) 篇）$/, 'Show 30 more ({1} in total)'],
    [/^原文件「(.+)」改过了$/, 'The source file “{1}” has changed'],
    [/^原 PPT 有 (\d+) 张隐藏页没转进来$/, '{1} hidden slides of the original PowerPoint were not converted'],
    // 右上角提示条：这一页更新时改过（带新旧两个文件名时照原样写）、正在看旧版（2026-11-14 补：以前英文界面这一句没换）
    [/^这一页更新时改过（(?:(.+) → (.+)，)?见橙框）$/, (m) => `This page changed in the update${m[1] ? ` (${m[1]} → ${m[2]})` : ''}: see the orange boxes`],
    [/^正在看更新前的旧版(?:（(.+)）)?$/, (m) => `Viewing the version before the update${m[1] ? ` (${m[1]})` : ''}`],
    [/^《(.+)》只在本地：不会发给 Claude$/, '“{1}” is local only: it will not be sent to Claude'],
    [/^《(.+)》可以发给 Claude 了$/, '“{1}” can be sent to Claude again'],
    [/^《(.+)》设为「只在本地」，不发给 Claude。要发的话，在抽屉里点「这本发往」选一个对话。$/, '“{1}” is set to local only and is not sent to Claude. To send it, tap “Sent to” in the drawer and pick a session.'],
    [/^找不到文件夹：(.*)$/, 'Folder not found: {1}'],
    [/^找不到文件：(.*)$/, 'File not found: {1}'],
    [/^不支持的文件类型：(.*?)（可以导入 PDF、PPT、Word、EPUB、图片、Markdown 和纯文本）$/, 'Unsupported file type: {1} (PDF, PowerPoint, Word, EPUB, images, Markdown and plain text can be imported)'],
    [/^已经有一本叫《(.+)》的了$/, 'There is already a notebook called “{1}”'],
    [/^没有这个本子：(.*)$/, 'No such notebook: {1}'],
    [/^页码超出范围（这本共 (\d+) 页）$/, 'Page number out of range (this notebook has {1} pages)'],
    [/^请求太大（(\d+) MB）$/, 'Request too large ({1} MB)'],
    [/^服务器出错：([\s\S]*)$/, 'Server error: {1}'],
    [/^没能把它转成 PDF：([\s\S]*)$/, 'Could not convert it to PDF: {1}'],
    [/^这一页在别的设备上改过了。你这边没存上的改动另存在电脑上：(.*)$/, 'This page was changed on another device. Your unsaved changes were kept on the computer: {1}'],
    [/^《(.+)》设为「只在本地」，不发给 Claude。要发的话，在平板抽屉里点「这本发往」选一个对话。$/, '“{1}” is set to local only and is not sent to Claude. To send it, tap “Sent to” in the drawer and pick a session.'],
    [/^配对于 (.+)$/, 'paired {1}'],
    [/^最近 (.+)，(.+)$/, 'last seen {1}, {2}'],
    [/^断开「(.+)」？它需要重新扫码才能再用，访问码也会一起换。$/, 'Disconnect “{1}”? It will have to scan again, and the access code changes too.'],
    [/^平板和这台电脑要连同一个 Wi-Fi。已连上的 Claude Code 对话：(.*)$/, (m, t) => `The tablet and this computer must be on the same Wi-Fi. Connected Claude Code sessions: ${t(m[1]).replace(/、/g, ', ')}`],
    [new RegExp(`^(${Object.keys(FAIL).join('|')})：([\\s\\S]*)$`), (m, t) => `${FAIL[m[1]]}: ${t(m[2])}`],
    // 用「 · 」连起来的几段（导入列表里「今天 10:20 · 12 KB」那样的）：每一段都认识才换，免得把别人写的话换掉一半
    [/^(.+?) · ([\s\S]+)$/, (m, t) => { const a = t(m[1]), b = t(m[2]); return CJK.test(a) || CJK.test(b) ? null : `${a} · ${b}`; }],
  ];

  const CJK = /[\u3400-\u9fff]/;
  function t(s) {
    if (lang !== 'en' || typeof s !== 'string' || !CJK.test(s)) return s;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    const core = m[2];
    if (Object.prototype.hasOwnProperty.call(EXACT, core)) return m[1] + EXACT[core] + m[3];
    for (const [re, out] of RULES) {
      const g = re.exec(core);
      if (!g) continue;
      const text = typeof out === 'function' ? out(g, t) : out.replace(/\{(\d)\}/g, (_, i) => t(g[Number(i)] || ''));
      if (text == null) continue; // 这条规则认不出里面的内容，换下一条
      return m[1] + text + m[3];
    }
    return s;
  }

  function setLang(next) {
    // 换语言要重新打开页面：还有字没存上（或连不上电脑）时不换，免得丢字
    const S = window.__ink && window.__ink.S, trouble = document.getElementById('trouble');
    if ((S && (S.dirty || S.online === false)) || (trouble && !trouble.hidden)) {
      window.alert(lang === 'en' ? 'Some ink is not saved yet. Switch the language once it is saved.' : '还有字没存上，等存好了再换语言。');
      return;
    }
    try { localStorage.setItem(KEY, next); } catch (e) { /* */ }
    const u = new URL(location.href);
    u.searchParams.set('lang', next);
    location.replace(u.toString());
  }

  // 不是界面的话不换：Claude 写在纸上的、长回答卡片里的，确认卡片上的问题和候选读法，文件名和文献标题；
  // 标着 data-lang-keep 的（你在对话里打的话、电脑上的文件夹名、你起的文件夹名、问话卡片上 Claude 写的问题、选项和结果……）
  const CONTENT = '#aiRoot, #tex, #qcBody .opts, .is-name, [data-lang-keep]';
  const CONTENT_OWN = '#qcBody .q'; // 只跳过直接写在里面的字，里面的按钮照常换
  // 本子名、文件夹名是你起的，不换；只有自带的两本换
  const NAMES = '#chipName, #nbTitle, .nb-name, .nf-name';
  const BUILT_IN = new Set(['草稿本', 'Claude 推送']);
  function isContent(textNode) {
    const p = textNode.parentElement;
    if (!p) return true;
    if (p.closest(CONTENT) || p.matches(CONTENT_OWN)) return true;
    if (p.closest(NAMES)) return !BUILT_IN.has((textNode.nodeValue || '').trim());
    return false;
  }

  const ATTRS = ['title', 'aria-label', 'placeholder'];
  function fixNode(n) {
    if (n.nodeType === 3) {
      const v = n.nodeValue;
      if (v && CJK.test(v) && !isContent(n)) { const w = t(v); if (w !== v) n.nodeValue = w; }
    } else if (n.nodeType === 1) {
      for (const a of ATTRS) {
        const v = n.getAttribute && n.getAttribute(a);
        if (v && CJK.test(v)) { const w = t(v); if (w !== v) n.setAttribute(a, w); }
      }
    }
  }
  function fixTree(root) {
    if (!root) return;
    fixNode(root);
    if (root.nodeType !== 1 || root.tagName === 'SCRIPT' || root.tagName === 'STYLE') return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) fixNode(n);
  }

  // 抽屉最下面的语言切换（两种语言下都有）
  function addSwitch() {
    const drawer = document.getElementById('drawer');
    if (!drawer || document.getElementById('langRow')) return;
    const row = document.createElement('div');
    row.id = 'langRow';
    row.className = 'dr-row';
    for (const [code, label] of [['zh', '中文'], ['en', 'English']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.lang = code;
      if (code === lang) b.classList.add('on');
      b.addEventListener('click', () => { if (code !== lang) setLang(code); });
      row.appendChild(b);
    }
    drawer.appendChild(row);
  }

  function start() {
    addSwitch();
    if (lang !== 'en') return;
    document.documentElement.lang = 'en';
    document.title = t(document.title);
    // 竖着写的两个纸边按钮：英文改成竖排的一行
    const css = document.createElement('style');
    css.textContent = '#extRight, #extLeft { writing-mode: vertical-rl; }';
    document.head.appendChild(css);
    const right = document.getElementById('extRight'), left = document.getElementById('extLeft');
    if (right) right.textContent = '＋ Wider';
    if (left) left.textContent = '＋ Left';
    fixTree(document.body);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') fixNode(m.target);
        else if (m.type === 'attributes') fixNode(m.target);
        else for (const n of m.addedNodes) fixTree(n);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  if (lang === 'en') { // 浏览器自带的对话框也过一遍
    for (const name of ['confirm', 'alert', 'prompt']) {
      const native = window[name];
      if (typeof native === 'function') window[name] = function (msg, ...rest) { return native.call(window, t(msg), ...rest); };
    }
  }
  window.InkLang = { lang, t, set: setLang };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
