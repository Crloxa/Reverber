# Reverber 网页工具设计

日期：2026-08-03
状态：已确认 · 已实现 · 已通过浏览器实测

## 概述

一个纯前端、零依赖的网页工具，把用户拖入的音频文件实时处理为"0.8倍速 + Reverb"效果（速度、音调、混响、低频增强全部可调），支持实时预览、拖动进度、暂停/播放/停止，以及导出 WAV / MP3。放在 `E:\_myTool\Reverber` 目录，双击 `index.html` 即可使用，无需安装任何环境。

音频处理用浏览器原生 Web Audio API + soundtouchjs（时域变速/变调，本地 vendor 引入）；滑块控件使用知名组件 noUiSlider（MIT，v15.8.1，本地 vendor、离线可用）；MP3 编码用 lamejs（MIT，本地 vendor）。不引入 npm/构建工具。背景是音乐平台常见的"slowed and reverb"（0.8 倍速混响）改编版本，参考了开源项目 krish-134/Audio-Speed-Stretcher-and-Reverb 的效果意图（该项目的 Python 编排有 bug，故以 Web 方式重做）。

> 滑块组件选型修正：初版用原生 `<input type="range">` + `::-webkit-slider-*` 伪元素自定义样式，但新版 Chromium（Chrome 151+）已不再应用这些伪元素样式，导致滑块不可见。改用 noUiSlider（真实 DOM 渲染轨道+把手，任何浏览器可见可拖），已实测通过。

> 实现路径修正：初稿设想用 `AudioBufferSourceNode` 的 `playbackRate`/`preservesPitch` 做实时变速变调。但 `preservesPitch` 在 Chrome 下对 `BufferSource` 实际不支持（仍会变调），且实时图无法做"进度保持/重新处理"。故改为 **soundtouchjs 离线分块重处理**：变速变调先生成新的 AudioBuffer，再送入效果图（混响/低频），播放与导出共用同一份处理结果。代价是变速/变调/模式参数变化需重新处理（约 0.4s 防抖 + 分块异步，不卡 UI）。

## 信号处理链

```
输入音频文件
→ decodeAudioData 解码为 AudioBuffer（原始）
→ soundtouchjs 离线变速变调（chunked，每步 ~1s，setTimeout 异步）
   · st.tempo = 速度；st.rate = 1；st.pitch = 音调倍率（按模式计算）
→ 按响度截掉尾部静音 → 新 AudioBuffer（processed）
→ 效果图（实时预览与离线导出共用同一套结构）：
   → BiquadFilterNode 低频增强（lowshelf，frequency/增益）
   → 干声增益（gain = 1 - 混响干湿比）
   → ConvolverNode 卷积混响（程序化 IR）
   → 湿声增益（gain = 混响干湿比）
   → master 输出
→ 实时播放：AudioBufferSourceNode(processed) → 效果图 → ctx.destination
→ 导出：OfflineAudioContext 重建效果图 → startRendering → WAV/MP3 编码下载
```

要点：
- **变速/变调/模式**（tempo 类参数）：改变 → 防抖 400ms → 重新跑 soundtouch → 替换 processed 缓冲，保留当前进度自动续播。
- **混响/低频**（effect 类参数）：改变 → 只更新实时效果节点参数，不重处理，预览即时生效。
- 效果图节点在实时与离线导出间各自独立构建但结构一致；IR 只在房间大小变化时重新生成。
- 播放全程维护"处理后输出时间"坐标 `_outPos`；重处理前用 `getInputPos() = currentOutPos × speed` 折算回输入时间坐标，重处理后按 `inputPos / speed` 还原进度。

## 参数（全部滑块，含默认值）

| 参数 | 范围 | 默认 | 实现 |
|------|------|------|------|
| 速度 | 0.5–1.5× | 0.8 | `st.tempo`（触发重处理） |
| 音调 | -12 ~ +12 半音（偏移量） | 0 | `st.pitch` 倍率 = 按模式 × 2^(音调/12)（触发重处理） |
| 模式 | 磁带慢放 / 变速保调 | 磁带慢放 | 决定速度是否折算进音调倍率（触发重处理） |
| 混响-房间大小 | 0.5–10 s | 3 s | IR 衰减时长（实时生效） |
| 混响-干湿比 | 0–100 % | 30 % | 干/湿增益（实时生效） |
| 低频-增益 | -12 ~ +12 dB | +6 dB | lowshelf gain（实时生效） |
| 低频-频率 | 50–300 Hz | 200 Hz | lowshelf frequency（实时生效） |

### 音调计算（两种模式独立）

SoundTouch 的音高由 `virtualPitch` 决定、节奏由 `virtualTempo` 决定，二者互相独立：
- `st.tempo = 速度`；`st.rate = 1`（净时长比 = 1/速度，与音调无关）。
- **磁带慢放**：音高随速度自然下降 → 音调倍率 = `速度 × 2^(音调/12)`，音调滑块在其上叠加偏移。
- **变速保调**：只变节奏、音高不变 → 音调倍率 = `1 × 2^(音调/12)`，音调滑块独立控制音高。

已验证：tape@0.8 倍率 0.8；preserve@0.8 倍率 1.0；+12 半音时分别 1.6 / 2.0。

## 交互

- 拖拽音频文件到页面，或点击选择文件。支持 mp3/wav/flac/ogg，解码能力取决于浏览器。
- 六个参数均为 noUiSlider 滑块（轨道 + 圆形把手），拖动时标签实时更新：tempo 类即时触发（防抖）重处理，effect 类即时作用于实时节点。
- 模式为两个胶囊单选（磁带慢放 / 变速保调）。
- 传输控制：播放/暂停（▶/⏸ 切换）、停止（■）、**播放进度条**（可点击/拖动 seek，拖动中只预览位置、松手才真正跳转）。
- 导出：格式下拉选 WAV / MP3（默认 MP3），OfflineAudioContext 按 `处理后时长 + 房间大小 + 0.1s` 渲染，编码后触发下载，文件名 = 原名 + `_reverber.wav/.mp3`。
- 全部界面中文。

## 文件结构

```
Reverber/
  index.html            — 页面结构 + 内联样式
  js/
    main.js             — UI 逻辑：拖拽、noUiSlider 参数绑定、进度条/传输、导出
    audio-engine.js     — DSP：soundtouch 离线变速变调、效果图、IR 生成、播放/seek、离线渲染
    wav-encoder.js      — AudioBuffer → 16-bit PCM WAV / MP3（lamejs）编码
  vendor/
    nouislider.min.js   — 滑块组件（MIT v15.8.1）
    nouislider.min.css
    soundtouch.global.js— soundtouchjs 0.1.30 ESM→经典脚本转换（soundtouch.min.js 亦保留）
    lame.min.js         — lamejs 1.2.7 IIFE（window.lamejs）
  docs/superpowers/specs/2026-08-03-reverber-web-tool-design.md — 本文档
```

唯一外部依赖是本地 vendor 的 noUiSlider / soundtouchjs / lamejs（离线可用）。`<script>` 普通加载，不使用 ES module（file:// 下 module 受 CORS 限制），脚本按顺序在 `</body>` 前引入：nouislider.min.js → soundtouch.global.js → lame.min.js → wav-encoder.js → audio-engine.js → main.js。

## 关键实现细节

### IR 生成（audio-engine.js）

生成立体声指数衰减噪声作为卷积混响 IR：
- 时长 = 房间大小参数（秒）
- 每个样本 = 白噪声 × 指数衰减包络 `exp(-3 * t / 时长)`（约 -60 dB）
- 左右声道独立随机序列制造立体感，RMS 归一化到 0.5
- 采样率取上下文采样率
- 仅在房间大小变化时重新生成（`_irCache`）

### soundtouch 分块处理与尾部修正（audio-engine.js）

- 输入尾部补 1s 静音（`PAD_SEC`）——soundtouchjs 不会 flush 末尾不足 `sampleReq` 的残块，补静音防丢真实音频尾音。
- 按 `CHUNK=44100`（约 1s）分块 `putSamples → process → drain outputBuffer`，每步 `setTimeout(0)` 异步，避免长时间卡 UI。
- 处理令牌 `_token`：参数快速连动时丢弃过期结果，只采用最后一次。
- 输出按响度截断：找到最后一个响度超过 `peak × 0.0005` 的样本，保留其后 `TAIL_SEC=0.25s` 尾音，切掉 padding/算法残余的尾部静音。切掉对真实音频无影响（25s 测试音 0.8 倍速下音频尾端精确保留）。
- 若最终帧数为 0 则保底为 1 帧，防止空缓冲。

### 传输与进度保持

- `_outPos`：播放位置（处理后的输出时间，秒）。播放中 = 起始位置 + (ctx.currentTime − startCtxTime)；暂停/停止后 = 固定值。
- seek：先取当前真实位置、停止 source，再设新位置；若原本在播放则自动续播。进度条拖动中只更新标签（`seekDragging`），松手/tap 才真正 seek。
- 100ms 定时器驱动进度条与时间标签；播放到末尾自动停止并复位。
- 重处理（变速/变调/模式变化）：记录 `inputPos = currentOutPos × speed`，重处理后 `_outPos = min(inputPos / 新speed, duration − 0.01)`，若在处理前播放中则自动续播。

### 导出（audio-engine.js + wav-encoder.js）

- 离线渲染时长 = `processed.duration + 房间大小 + 0.1`，防止混响被硬切。
- **WAV**：16-bit PCM 立体声交错，44 字节 RIFF 头。
- **MP3**：lamejs `Mp3Encoder` 编码；采样率不在 lamejs 支持列表（48k/44.1k/32k/…）时先线性重采样到 44100；立体声/单声道按通道数调用 `encodeBuffer`；分块 1152 帧循环 + `flush()`。
- Blob + `URL.createObjectURL` + `<a download>` 触发下载，3s 后回收对象 URL。

## 错误处理

- 解码失败（不支持格式/损坏文件）：页面显示错误提示，不崩溃。
- 未加载文件时点导出/播放：提示先选择文件。
- 处理未完成时按钮禁用。
- 大文件导出时页面可能短暂无响应，属浏览器单线程正常现象；不做 Web Worker（保持轻量，超出范围）。

## 测试与验证（浏览器实测通过）

在 Chrome 中直接打开 `index.html`（file://），用 Python 生成的测试音频（6s/25s 双音正弦测试 WAV，48kHz 立体声）验证：

1. ✅ 加载 25s WAV：显示文件名、时长 0:25、48000Hz、2 声道；默认 0.8× 磁带模式处理为 0:31（25 ÷ 0.8 ≈ 31.25）。
2. ✅ 播放 → 进度条随播放推进；暂停（按钮变 ⏸ 暂停）、继续、停止均正常；播到末尾自动停止。
3. ✅ 进度条 seek：引擎 hook 跳转到 20s，播放从 ~20s 续播到末尾（31.5s）自动停。
4. ✅ 音调/速度独立：tape@0.8 倍率 0.8、preserve@0.8 倍率 1.0；+12 半音分别 1.6/2.0。
5. ✅ 模式切换（点"变速保调"）→ 触发重处理，状态提示"参数已变化，正在重新处理…" → "处理完成"。
6. ✅ 速度滑块改 1.00× → 触发重处理，处理后时长回到 0:25；preserve 下音调倍率保持 1.0。
7. ✅ 导出 MP3：`test_tone_25_reverber.mp3` 下载成功；字节校验为合法 MPEG1 Layer III（0xFF 帧同步 ×3128、665 KB）。
8. ✅ 导出 WAV：RIFF/WAVE 头正确，48000Hz 立体声，渲染时长 = 25.2 + 3.0(混响) + 0.1。

> 人工试听（速度/音高听感、混响质感）需用户最终确认；算法正确性已由上述数值验证覆盖。
