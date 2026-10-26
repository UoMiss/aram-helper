# 发版指南

## 当前发布方式

官网 daguagua.top 使用 EdgeOne 的 aram-helper 项目，从 master 自动部署，根目录为 website。安装包由构建脚本下载并校验后随静态站点发布，用户直接从官网下载；GitHub Releases 提供备用地址。

版本号需同步 package.json、package-lock.json、src-tauri/Cargo.toml、src-tauri/Cargo.lock 和 src-tauri/tauri.conf.json。提交和推送仍须遵守使用者的 Git 授权规则。

## Windows 手动安装包

1. 完成代码 Review、npm test、npm run build 和 Rust 测试。
2. 经授权推送后，在 GitHub Actions 手动运行「Windows 安装包」工作流。该工作流同时执行 Windows Rust 测试。
3. 下载 aram-helper-windows 构建产物，保留对应提交和构建记录。
4. 检查安装包的版本、大小及 SHA-256，再上传到对应版本的 GitHub Release。
5. 在仓库根目录运行准备脚本，第二个参数用 `-` 表示当前只提供手动安装：

```bash
node 脚本/准备官网下载.mjs 安装包.exe - 0.1.1 2026-10-23T14:00:00Z https://github.com/paidaxn/aram-helper/releases/download/v0.1.1/aram-helper_0.1.1_x64-setup.exe
node 脚本/构建官网.mjs
npm test
```

6. 核对 release.json、HTML 中两个按钮、备用链接和文件校验链接，再经授权提交并推送网站变更。
7. EdgeOne 部署成功后，验证官网完整下载的 SHA-256、Range 响应和同网络下载速度。

二进制文件保存在被 Git 忽略的发布产物和 website/downloads 目录。服务器按 release.json 重建下载目录，大小或 SHA-256 不符会终止部署。

## 自动更新签名

原发版说明记录的 Windows 项目路径为 `E:\repo\aram-helper`，私钥路径为该 Windows 用户的 `~/.tauri/aram-helper.key`。2026-10-23 在当前 Mac 常规目录和本仓库 GitHub Secrets 中未找到对应私钥，Windows 原电脑尚未核实。

现有 updater 公钥保持不变。Windows 工作流仅为本次手动构建覆盖 createUpdaterArtifacts=false，不会改变用户安装版本的签名验证。缺少原私钥时不发布新版 latest.json；官网保留已签名的 v0.1.0 清单及其原 GitHub 文件地址。旧版用户需要从官网下载新版安装包覆盖安装。

找回原私钥后，在私钥所在的安全环境设置 TAURI_SIGNING_PRIVATE_KEY（必要时另设密码），使用常规 `npm run tauri build` 生成安装包及 .sig。准备脚本的第二个参数改为真实 .sig 路径，即可生成新版 latest.json。旧版客户端使用 GitHub 更新入口，因此同一 latest.json 也需上传到对应 GitHub Release。

私钥不得进入代码、日志或聊天。不要用其他项目的密钥代替，也不要直接更换现有公钥。

## 验证边界

Mac 上的类型构建、脚本测试与窗口几何测试，不能替代 Windows 安装、托盘、真实 LOL 对局和自动更新验收。每次发布记录实际完成的层次及尚未验证项。

## v0.1.2 发布前审查

- 保留现有三种算分公式及分队规则；连接轮询改为单一串行任务，页面导航通过请求序号丢弃过期响应。
- 手动历史结果在前台保留在当前页；收进托盘或最小化后，下一局结算仍会恢复窗口。自动结算只提示一次，新对局开始后收起。等待统计阶段不读取上一局；同一应用会话中接口仍返回旧局时继续重试。
- 结算增加统计列名、本人标记、规则说明、滚动支持和真实截图反馈；设置版本读取安装包版本。
- LCU 本机请求绕过系统代理并设置连接/总超时；异常 lockfile 内容不进入错误提示。
- 官网首屏加入标明示例数据的结算预览；补全安装、升级、连接和楼层说明；移除外部字体、内容隐藏动画及 Clarity 访客上报。
- 自查与代码 Review：检查异步竞态、生命周期、错误恢复、下载回退及已有评分规则的影响；发现的旧局阻塞新结算问题已修复并加入回归测试，无未关闭阻断项。
- 本地验证：20 项 Node 测试、5 项 Rust 窗口几何测试、TypeScript/Vite 构建通过。
- 模拟交互验证：浏览器替换 Tauri IPC 后，验证连接、历史错误/空态/重试、游戏中手动历史、组队/个人战、长结果滚动、版本展示。模拟剪贴板接收 PNG 776×776；不等同于 Windows 原生剪贴板验收。
- 官网在 320/390/768/1280 宽度无横向溢出，禁用 JavaScript 后静态下载入口仍可见。
- 尚未验证：真实 Windows 安装与托盘恢复、真实 LOL/WeGame 对局、多显示器实机；自动更新仍受原签名私钥缺失限制，使用官网手动安装。

### v0.1.2 实际发布结果（2026-10-24 北京时间）

最终代码提交 9a562e8a1a1260f48dd56298ae7f6b809592066d，Windows Actions 39984101899 全部成功（20 项 Node、5 项 Rust 测试、正式 NSIS 构建）；GitHub 于 00:21:52 发布。官网版本切换提交 66fa3d1 已上线。

安装包 3,248,962 字节，SHA-256：63eb2e5faa7a711054d71f78962a3f7dccc1bfcae5ea1ab54e67a491edd8ec92。官网不使用本机代理的完整下载为 4.605727 秒，文件摘要与 GitHub 和构建产物一致；Range 206、两个首页入口、校验文件及原已签名 0.1.0 更新清单均通过。单次测速仅代表当前网络。

原始产物和验证记录在被 Git 忽略的 发布产物/v0.1.2/ 与 发布产物/下载验收/v0.1.2/。真实 Windows 对局及原生托盘、剪贴板、多屏的验证边界仍如上所述。


## 官网统计恢复（2026-10-26）

- 根据项目所有者明确要求，恢复原 Microsoft Clarity 项目 `waxxfg1lzn` 及原访问、下载、导航和 FAQ 事件。
- 首屏、页尾和 GitHub 备用下载均上报 `download_click`，另提供分入口事件；仅统计点击，不宣称完整下载或安装成功。
- 使用异步脚本和异常隔离，保留安装包原生链接及 v0.1.2 下载清单。无需重新发布桌面安装包。
