# SassDesk 路线图

## v0.1.0（当前）

- CLI（readline）+ 中文多轮对话（Pi Agent Loop）
- 受控工具：env_info / process_query / process_start / qqmusic_status / qqmusic_start
- 自动化规则：草稿 → 确认 → 启用（startup-auth）→ 开机执行 → JSONL 审计
- Windows Startup Provider（HKCU Run，幂等、可查询、可撤销）
- 语音管线：mock / SAPI 本地识别 / Whisper 云端转写（文件模式）
- 角色配置（默认「大肥鱼」，仅 persona + 资源路径占位）

## v0.2.0 方向

### 桌面悬浮窗（重点）
- Electron 或 Tauri 小窗（推荐 Tauri：体积小、Rust 侧无 Node 依赖），角色 PNG 序列帧/Live2D 占位
- 悬浮窗仅做展示与输入，Agent Core 复用 `SassDeskAgent`（进程内 IPC 或本地 socket）
- 角色状态机接入真实事件：`thinking`（message_update 流）、`working`（tool_execution_*）、`success/failure`（run 结果）

### DIY 角色与动画
- 角色包格式：`assets/characters/<name>/character.json`（状态 → 素材映射）+ 图片素材
- 角色编辑器（表单级）：换名、换图、调风格；支持导入原创形象
- 角色市场目录（本地文件夹扫描 + 预览）

### 唤醒词与持续监听
- 唤醒词走本地方案优先（whisper.cpp tiny 流式 / Vosk 小模型 / Windows 唤醒服务），默认关闭、需明确开启
- 麦克风占用指示（托盘/悬浮窗），隐私说明常驻

### 更多本地工具
- 窗口管理：列出/聚焦/最小化窗口（白名单应用范围内）
- 文件快捷访问：打开用户指定的文件夹/文档（路径需用户确认）
- 定时任务：cron 表达式规则（复用规则状态机，新增 trigger 类型）
- 通知中心：Windows toast 反馈任务结果（WinRT / PowerShell BurntToast 模块可选依赖）

### 工程化
- 设置文件 GUI（悬浮窗内嵌）
- 偏好与规则可选云同步（接口已隔离：KvStore → 远端实现）
- GitHub Actions CI：windows-latest 跑 typecheck + build + vitest
