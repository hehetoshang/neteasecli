# neteasecli

Netease Cloud Music CLI / 网易云音乐命令行工具

Search, play, download, and manage your library — all from the terminal with structured JSON output for scripting and AI agent integration.

## Features

- Search tracks, albums, artists, playlists
- Playback via [mpv](https://mpv.io/) with persistent queues, automatic advance, previous/next, and IPC control
- Track info, streaming URLs, lyrics, download
- Library management (liked tracks, recent history)
- Playlist browsing
- Browser cookie import from Chrome, Edge, Firefox, Safari via [sweet-cookie](https://github.com/steipete/sweet-cookie)
- Multi-profile support for multiple accounts
- Three output modes: colorized human-readable, JSON, plain text
- Debug/verbose logging (`-v`, `-d`)
- Cross-platform: macOS, Linux, Windows

## Why Cookies?

Netease Cloud Music has no public API. The unofficial API endpoints require encrypted requests and valid session cookies. Instead of implementing a fragile login flow (SMS/QR code), neteasecli imports cookies directly from your browser:

- **Multi-browser** — Chrome, Edge, Firefox, Safari (auto-detected)
- **No credentials stored** — reads browser's encrypted cookie DB via OS keychain
- **No captcha** — skip SMS verification entirely
- **Always fresh** — re-run `auth login` anytime to refresh
- **One command** — `neteasecli auth login` and you're in

## Install / 安装

```bash
# npm
npx neteasecli search track "Jay Chou"    # Run without installing / 免安装运行
npm install -g neteasecli                   # Install globally / 全局安装

# pnpm
pnpm dlx neteasecli search track "Jay Chou"
pnpm add -g neteasecli

# bun
bunx neteasecli search track "Jay Chou"
bun add -g neteasecli
```

## Quick Start / 快速开始

```bash
neteasecli auth login                    # Import cookies from browser
neteasecli search track "Sunny Day"      # Search
neteasecli track play 185868             # Play (requires mpv)
neteasecli library play-liked --shuffle  # Continuously play liked tracks
neteasecli playlist play <id>            # Continuously play a playlist
neteasecli player next                   # Skip to the next track
neteasecli player pause                  # Pause/resume
neteasecli player stop                   # Stop
```

## Commands / 命令

### auth

```bash
neteasecli auth login              # Import cookies from browser / 从浏览器导入 Cookie
neteasecli auth login --profile X  # Specify Chrome/Edge profile / 指定 Chrome/Edge Profile
neteasecli auth check              # Check login status / 检查登录状态
neteasecli auth logout             # Logout / 登出
```

### search

```bash
neteasecli search track <query>    # Search tracks / 搜索歌曲
neteasecli search album <query>    # Search albums / 搜索专辑
neteasecli search playlist <query> # Search playlists / 搜索歌单
neteasecli search artist <query>   # Search artists / 搜索歌手
```

Options: `-l, --limit <n>` (default 20), `-o, --offset <n>` (default 0)

### track

```bash
neteasecli track detail <id>       # Track metadata / 歌曲详情
neteasecli track url <id>          # Streaming URL / 播放链接
neteasecli track lyric <id>        # Lyrics / 歌词
neteasecli track download <id>     # Download / 下载
neteasecli track play <id>         # Play via mpv / 用 mpv 播放
```

Options: `-q, --quality <level>` standard | higher | exhigh (default) | lossless | hires

### player

Requires [mpv](https://mpv.io/). / 需要安装 [mpv](https://mpv.io/)。

```bash
neteasecli player status           # Current playback status / 播放状态
neteasecli player pause            # Toggle pause/resume / 暂停或继续
neteasecli player stop             # Stop playback / 停止播放
neteasecli player seek <seconds>   # Seek relative (e.g. 10, -10) / 快进快退
neteasecli player seek 30 --absolute  # Seek to absolute position / 跳转到指定位置
neteasecli player volume [0-150]   # Get or set volume / 音量
neteasecli player repeat [on|off]  # Toggle or set repeat / 单曲循环
neteasecli player next             # Next track / 下一曲
neteasecli player previous         # Previous track / 上一曲
neteasecli player queue            # Show queue and current track / 查看队列
neteasecli player queue add <id...>       # Add tracks / 添加歌曲
neteasecli player queue remove <position> # Remove by 1-based position / 删除歌曲
neteasecli player queue play [position]   # Start queue / 从指定位置播放
neteasecli player queue clear             # Stop and clear queue / 停止并清空
```

`next` at the final track stops playback and marks the queue finished. `previous`
at the first track returns an error. `stop` preserves the queue so it can be
started again with `player queue play`; `queue clear` removes it. Single-track
repeat holds the current queue position, and disabling repeat restores automatic
advance. Queue state and playback history are stored per profile under
`~/.config/neteasecli/profiles/<profile>/player-queue.json` with user-only
permissions. A lightweight monitor process is started automatically while a
queue is active, so playback continues after the initiating CLI command exits.

#### XiaoAI speaker backend / 小爱音箱播放

Play through [open-xiaoai-bridge](https://github.com/coderzc/open-xiaoai-bridge)
via URL relay (download → decode PCM → push to speaker), which supports
pause/resume/seek controlled by the bridge. / 通过 open-xiaoai-bridge 中转推流播放
（下载 → 解码 PCM → 推流到音箱），暂停/恢复/跳进度由 bridge 管理。

```bash
# Choose the xiaoai backend / 选择小爱播放后端
NETEASECLI_PLAYER=xiaoai neteasecli track play <id>
# Optional: bridge API base URL / 可选：bridge API 地址
OPENXIAOAI_BASE_URL=http://127.0.0.1:9092
```

bridge 控制面必须认证。默认会读取 bridge 首次启动生成的
`~/.config/open-xiaoai-bridge/api-token`；也可设置
`OPENXIAOAI_API_TOKEN_FILE` 或至少 32 字符的 `OPENXIAOAI_API_TOKEN`。token
文件在 Unix 上必须是 `0600`。非 loopback 地址默认拒绝明文 HTTP，请配置
HTTPS；mTLS 可进一步设置 `OPENXIAOAI_TLS_CA`、
`OPENXIAOAI_TLS_CLIENT_CERT` 和 `OPENXIAOAI_TLS_CLIENT_KEY`。迁移期的
`OPENXIAOAI_ALLOW_INSECURE_HTTP=1` 会明文暴露凭据，不应作为长期配置。

bridge 会使用本播放器实际输出的 24 kHz PCM 作为 AEC 参考，在 KWS/VAD 前
处理 16 kHz 麦克风音频；参数、诊断和实机对照测试见 bridge 的
`docs/security-and-aec.md`。

`volume` is not supported on the xiaoai backend. / 小爱后端不支持 `volume`。

#### MCP server mode / MCP 服务器模式

Expose music capabilities as MCP tools for AI agents (e.g. speaker voice
dialogue routed through the bridge's MCP client). / 以 MCP 工具暴露音乐能力给
AI（如经 bridge 的 MCP client 接入音箱语音对话）。

```bash
neteasecli mcp   # stdio transport
```

Tools: `search_track` / `play_track` / `play_liked` / `play_playlist` /
`next_track` / `previous_track` / `queue_status` / `pause` / `resume` / `stop` /
`seek` / `status` / `repeat`. Pair with the bridge's `mcp_servers` config to let the
speaker dialogue control NetEase music. / 工具列表如上；配合 bridge 的
`mcp_servers` 配置即可让音箱语音对话控制网易云音乐。

### library

```bash
neteasecli library liked           # Liked tracks / 喜欢的音乐
neteasecli library play-liked      # Continuously play liked tracks / 连续播放喜欢的音乐
neteasecli library play-liked --limit 20 --shuffle --quality lossless
neteasecli library like <id>       # Like a track / 收藏
neteasecli library unlike <id>     # Unlike / 取消收藏
neteasecli library recent          # Recently played / 最近播放
```

### playlist

```bash
neteasecli playlist list           # My playlists / 我的歌单
neteasecli playlist detail <id>    # Playlist tracks / 歌单详情
neteasecli playlist play <id>      # Continuously play playlist / 连续播放歌单
neteasecli playlist play <id> --limit 20 --shuffle --quality exhigh
```

## Global Options / 全局选项

| Flag | Description |
|------|-------------|
| `--json` | Force JSON output (default when piped) / 强制 JSON 输出 |
| `--plain` | Plain text output (tab-separated) / 纯文本输出 |
| `--pretty` | Pretty-print JSON / 格式化 JSON |
| `--quiet` | Suppress output / 静默模式 |
| `--no-color` | Disable colors / 禁用颜色 |
| `--profile <name>` | Account profile (default: "default") / 账号配置 |
| `-v, --verbose` | Verbose output / 详细输出 |
| `-d, --debug` | Debug output (implies --verbose) / 调试输出 |
| `--timeout <seconds>` | Request timeout (default: 30) / 请求超时秒数 |

## Output Modes / 输出模式

| Mode | When | Description |
|------|------|-------------|
| Human | TTY (default) | Colorized, readable / 彩色可读 |
| JSON | Piped or `--json` | Structured `{ success, data, error }` / 结构化 JSON |
| Plain | `--plain` | Tab-separated, scriptable / 制表符分隔 |

```bash
# Colorized output in terminal / 终端彩色输出
neteasecli search track "Jay Chou"

# JSON for scripting / JSON 用于脚本
neteasecli --json search track "Jay Chou"
neteasecli search track "Jay Chou" | jq '.data.tracks[0]'

# Plain text for cut/awk / 纯文本用于文本处理
neteasecli --plain search track "Jay Chou" | cut -f1,2
```

Exit codes: `0` success, `1` general error, `2` auth error, `3` network error.

## Multi-Profile / 多账号

```bash
neteasecli --profile work auth login    # Login with "work" profile
neteasecli --profile work library liked  # Use "work" profile
neteasecli auth login                    # Default profile
```

Profiles are stored in `~/.config/neteasecli/profiles/<name>/`.

## Requirements / 环境要求

- Node.js >= 24
- Chrome, Edge, Firefox, or Safari (for cookie import / 用于导入 Cookie)
- [mpv](https://mpv.io/) (optional, for playback / 可选，用于播放)
- [open-xiaoai-bridge](https://github.com/coderzc/open-xiaoai-bridge) (optional,
  required only when `NETEASECLI_PLAYER=xiaoai`; its authenticated stream API
  must remain reachable while the queue is playing / 仅小爱后端需要)
- macOS, Linux, or Windows

## Legal / 免责

This tool uses unofficial Netease Cloud Music API endpoints. Use responsibly and in accordance with Netease's Terms of Service.

本工具使用非官方网易云音乐 API，请合理使用并遵守网易云音乐服务条款。

## License

MIT
