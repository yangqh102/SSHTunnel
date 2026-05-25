# SSHTunnel

SSH 端口转发客户端，通过 SSH 隧道将远程服务映射到本地，自动打开目标网页。

## 功能特性

- SSH 私钥认证，支持私钥选择与本地缓存
- 多连接配置管理：保存、加载、删除多个 SSH 配置
- 断线自动重连（最多 3 次），心跳保活机制
- 重连时复用目标窗口，自动恢复之前打开的页面
- 配置持久化，下次启动自动加载上次的连接设置

## 快速开始

### 安装依赖

```bash
npm install
```

### 运行

```bash
npm start
```

### 打包

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# 全平台
npm run build:all
```

打包产物位于 `dist/` 目录。

## 使用方法

1. **填写连接信息**：SSH 服务器 IP、用户名、端口、目标端口等
2. **选择私钥**：点击 "Select Private Key" 选择 SSH 私钥文件（如 `id_rsa`）
3. **保存私钥路径**：私钥路径会被缓存到本地，后续登录无需重复选择
4. **连接**：点击 "Login" 建立 SSH 隧道并自动打开目标网页
5. **配置管理**：通过下拉菜单加载已保存的配置，或输入名称保存新配置

## 连接配置说明

| 字段 | 说明 | 示例 |
|------|------|------|
| Remote SSH IP | 远程 SSH 服务器地址 | `192.168.1.100` |
| SSH Username | SSH 登录用户名 | `root` |
| SSH Port | SSH 端口 | `22` |
| Target Port | 远程服务端口 | `8008` |
| Local Port | 本地监听端口（与目标 URL 同步） | `8008` |
| Target URL | 打开的目标网页 | `http://127.0.0.1:8008` |

本地端口与目标 URL 端口会自动双向同步。

## 数据存储

所有数据保存在用户数据目录（`app.getPath('userData')`）：

| 文件 | 说明 |
|------|------|
| `ssh-config.json` | 默认连接配置 |
| `private-key-config.json` | 缓存的私钥路径 |
| `named-ssh-configs.json` | 多连接配置 |

## 技术栈

- **Electron** - 桌面应用框架
- **ssh2** - SSH 客户端
- **Node.js** - 运行时环境
