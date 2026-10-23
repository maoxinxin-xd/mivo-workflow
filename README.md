# Mivo Workflow

需要 Node.js 22.13+。安装依赖后运行 pnpm dev。
编辑器位于 http://127.0.0.1:9530，本地 Node 服务监听 127.0.0.1:9531。
首次启动编辑器会把原有可用工作流、会话密钥和运行进度迁移到本地服务。
网页关闭后，已经提交的工作流继续执行。

## 命令行

```sh
pnpm workflow list
pnpm workflow show --workflow-id <id>
pnpm workflow run --workflow-id <id> --字段1 '一只戴墨镜的猫' --图片1 ./参考图.png
pnpm workflow run --workflow-id <id> --字段1 '内容' --detach
pnpm workflow status --run-id <id>
pnpm workflow stop --run-id <id>
pnpm workflow resume --run-id <id>
```

可选：在本项目中执行 pnpm link --global，然后直接使用 mivo-workflow 命令。
--environment local|test|production 指定 API 环境，默认使用网页设置中的环境。
媒体变量接受本地文件路径，字符串变量接受文本；未提供的变量使用工作流默认值。
--output ./outputs 下载最终产出；--inputs-json ./inputs.json 接受变量名到文本或文件路径
的 JSON 对象，可用于名称与命令选项冲突的变量。恢复运行使用原始工作流及输入快照。
未知变量会报错；重新运行和恢复是不同操作，服务重启后的任务会标为暂停，需显式恢复。

## 数据与服务

SQLite、加密密钥文件和服务日志默认位于 ~/.mivo-workflow/。
工作流、草稿、运行快照、API 密钥和能力目录存入数据库；密钥字段使用 AES-256-GCM 加密。
备份时保留整个目录；丢失 secret.key 后无法解密数据库中的密钥。
浏览器仅获取配置状态，不获取已保存的 API Key 或会话 token。
资源预览图片仍使用短期内存缓存，媒体原文件继续由 Mivo 文件服务保存。

pnpm service 前台启动本地服务；编辑器和 CLI 会在需要时自动启动后台服务。
MIVO_WORKFLOW_DATA_DIR 可指定独立数据目录，MIVO_WORKFLOW_PORT 可调整本地服务端口。
本地 Mivo 上游默认 http://127.0.0.1:8000，可通过 MIVO_LOCAL_ENDPOINT 覆盖。
停止或修改服务代码后需重启本地服务，运行中的生成请求会保存为可恢复状态。
