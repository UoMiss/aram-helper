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
