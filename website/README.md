# LOL 红包局助手 · 官网

官网使用现有 EdgeOne 项目和 daguagua.top 域名。下载按钮优先指向本站版本化文件，GitHub Releases 保留为备用。版本信息读取本站 release.json；即使清单暂不可用，HTML 中仍保留可用下载地址。

## 准备下载文件

先取得 Windows 安装包及其原签名文件，再运行：

```bash
node 脚本/准备官网下载.mjs 安装包.exe 安装包.exe.sig 0.1.1 2026-10-23T14:00:00Z https://github.com/paidaxn/aram-helper/releases/download/v0.1.1/aram-helper_0.1.1_x64-setup.exe
```

脚本生成 website/downloads/版本/、SHA256SUMS.txt、release.json 和 latest.json，并同步静态按钮。不要覆盖已经发布的同版本文件；使用新版本号。

原更新签名私钥不可用时，将第二个参数写为 `-`，只准备手动下载安装包，并保留之前有效的 latest.json。不得更换现有公钥或向旧版推送无签名更新。

## EdgeOne 构建

现有项目从 GitHub 的 master 分支自动部署，根目录为 website。edgeone.json 已配置构建命令 `node ../脚本/构建官网.mjs`、输出目录 `.` 和 Node.js 22.11.0，可随代码一起部署。

构建脚本在服务器端取得 release.json 指定的 GitHub 文件，严格核对大小及 SHA-256，再将安装包作为本站静态资源部署。客户端不需要访问 GitHub API。二进制目录不进入 Git，后续部署可重复生成。

直接上传时，先在本地运行构建脚本，再将完整 website 目录打包上传。edgeone.json 为版本清单设置及时刷新，为版本化文件设置长期缓存。

## 验收

- 两个下载按钮、版本、大小、SHA-256 一致。
- 完整下载文件与清单摘要一致，Range 请求可恢复下载。
- 同一网络对比 GitHub 与官网地址的首字节、总耗时和速度；一次测速不代表所有运营商。
- 本站失败时可使用 GitHub 备用入口。
- 自动更新需保留原签名体系，清单与安装包先验证再发布。

当前官网加速区在控制台显示为全球可用区（不含中国大陆）。是否调整区域需结合真实测速、域名要求和实际套餐另行核对。

页面使用系统字体和静态 HTML；禁用 JavaScript 时下载入口仍可见。官网已移除 Clarity 及访客事件上报，后续恢复分析需单独明确数据与接收方。
