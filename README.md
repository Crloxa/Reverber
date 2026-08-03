# Reverber · 0.8 倍速混响

纯前端、零依赖、离线可用的网页音频工具：把拖入的音频实时处理成「0.8 倍速 + Reverb + 低频增强」的改编版本（slowed and reverb），全部参数可调，支持实时预览、拖动进度、暂停/播放/停止，并导出 WAV / MP3。

双击 `index.html` 即可使用，无需安装任何环境，**所有音频处理都在浏览器本地完成，不上传任何文件**。

## 功能特性

- **拖拽即用**：拖入或点击选择音频文件，支持 mp3 / wav / flac / ogg 等（解码能力取决于浏览器）。
- **六个可调参数**，全部为滑块：
  | 参数 | 范围 | 默认 |
  |------|------|------|
  | 速度 | 0.5–1.5× | 0.8 |
  | 音调 | -12 ~ +12 半音 | 0 |
  | 模式 | 磁带慢放 / 变速保调 | 磁带慢放 |
  | 混响 · 房间大小 | 0.5–10 s | 3 s |
  | 混响 · 干湿比 | 0–100 % | 30 % |
  | 低频增强 · 增益 | -12 ~ +12 dB | +6 dB |
  | 低频增强 · 频率 | 50–300 Hz | 200 Hz |
- **实时预览**：播放/暂停/停止，可点击或拖动进度条跳转，播放到末尾自动停止。
- **导出**：WAV / MP3（默认 MP3），文件名为 `原名_reverber.wav/.mp3`。
- 全部界面中文，深色主题。

## 使用方式

1. 双击打开 `index.html`（或任意浏览器打开该文件）。
2. 拖拽音频文件到页面，等待处理完成（默认 0.8× 磁带慢放 + 混响）。
3. 调节滑块：速度/音调/模式变化会触发重新处理（约 0.4s 防抖 + 分块异步，不卡界面），处理期间保留播放进度自动续播；混响/低频参数即时生效。
4. 点「导出」选择 WAV 或 MP3，下载处理后的文件。

## 技术实现

- **变速变调**：soundtouchjs 离线分块重处理（chunked + `setTimeout` 异步），先生成新的 AudioBuffer，再送入效果图。播放与导出共用同一份处理结果。
  - 磁带慢放：音调倍率 = `速度 × 2^(音调/12)`（音高随速度自然下降）。
  - 变速保调：音调倍率 = `1 × 2^(音调/12)`（只变节奏、音高不变）。
- **混响**：程序化生成指数衰减立体声噪声 IR，经 `ConvolverNode` 卷积；仅房间大小变化时重新生成 IR。
- **低频增强**：`BiquadFilterNode` lowshelf（增益 + 频率）。
- **导出**：`OfflineAudioContext` 重建效果图离线渲染，WAV 用 16-bit PCM 编码，MP3 用 lamejs 编码（采样率不在支持列表时自动重采样到 44100）。
- 界面滑块使用 noUiSlider（MIT v15.8.1）；音频处理用 Web Audio API 原生能力。无 npm / 无构建工具 / 无 ES module（保证 `file://` 下可运行）。

## 文件结构

```
Reverber/
  index.html              — 页面结构 + 内联样式
  js/
    main.js               — UI 逻辑：拖拽、滑块绑定、进度条/传输、导出
    audio-engine.js       — DSP：变速变调、效果图、IR 生成、播放/seek、离线渲染
    wav-encoder.js        — AudioBuffer → 16-bit PCM WAV / MP3 编码
  vendor/
    nouislider.min.js/.css  — 滑块组件（MIT v15.8.1）
    soundtouch.global.js    — soundtouchjs 0.1.30（经典脚本，离线可用）
    lame.min.js             — lamejs 1.2.7（window.lamejs）
  docs/superpowers/specs/2026-08-03-reverber-web-tool-design.md — 设计文档
```

## 验证

已在 Chrome 直接打开 `index.html`（file://）实测通过：加载 25s WAV → 0.8× 处理为 0:31、播放/暂停/停止/seek、两种模式音调倍率计算、导出 MP3（合法 MPEG1 Layer III）与 WAV（RIFF/WAVE 头正确）均正常。详见设计文档「测试与验证」一节。

## 致谢与说明

效果意图参考开源项目 [krish-134/Audio-Speed-Stretcher-and-Reverb](https://github.com/krish-134/Audio-Speed-Stretcher-and-Reverb)（其 Python 编排存在 bug，本项目以 Web 方式重做）。

第三方库均为本地 vendor、离线可用：noUiSlider（MIT）、soundtouchjs（LGPL）、lamejs（MIT）。
