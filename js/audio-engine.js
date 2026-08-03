/* audio-engine.js — DSP：
   1) soundtouchjs 离线变速/变调：速度与音调互相独立，按模式区分
      · 磁带慢放：音高随速度自然下降（音调滑块在其上叠加偏移）
      · 变速保调：只变节奏、音高不变（音调滑块独立控制音高）
   2) 效果图：低频增强 + 卷积混响，实时预览与导出共用同一套节点
   3) 传输：播放/暂停/停止/seek，全程维护"输入时间"坐标以兼容重新处理
*/
(function () {
  'use strict';

  var DEFAULT_PARAMS = {
    speed: 0.8,        // 播放速度倍率
    pitch: 0,          // 音调偏移，半音
    mode: 'tape',      // 'tape' 磁带慢放 | 'preserve' 变速保调
    reverbSize: 3,     // 混响房间大小 = IR 衰减时长（秒）
    reverbMix: 0.3,    // 混响干湿比 0~1
    bassGain: 6,       // 低频增强增益（dB）
    bassFreq: 200      // 低频增强频率（Hz）
  };

  var PAD_SEC = 1;     // 输入尾部补的静音：soundtouch 结尾不 flush，补静音防丢真实音频尾音
  var TAIL_SEC = 0.25; // 处理后按响度截断时保留的尾音
  var CHUNK = 44100;   // 每步喂入帧数（约 1 秒），分块处理避免长时间卡 UI

  function generateIR(ctx, decay) {
    var sampleRate = ctx.sampleRate;
    var length = Math.max(1, Math.round(sampleRate * decay));
    var buffer = ctx.createBuffer(2, length, sampleRate);
    for (var c = 0; c < 2; c++) {
      var data = buffer.getChannelData(c);
      var sumSq = 0;
      for (var i = 0; i < length; i++) {
        var t = i / sampleRate;
        var noise = Math.random() * 2 - 1;
        var sample = noise * Math.exp(-3 * t / decay);
        data[i] = sample;
        sumSq += sample * sample;
      }
      var rms = Math.sqrt(sumSq / length);
      var scale = rms > 0 ? 0.5 / rms : 0;
      for (var j = 0; j < length; j++) data[j] *= scale;
    }
    return buffer;
  }

  function AudioEngine() {
    this.ctx = null;
    this.buffer = null;      // 原始解码 AudioBuffer
    this.processed = null;   // 变速/变调后的 AudioBuffer（播放与导出的输入）
    this.params = {};
    this.setParams(DEFAULT_PARAMS);
    this.playing = false;
    this.paused = false;
    this.onStateChange = null;
    this._live = null;       // 实时效果节点组
    this._irCache = null;
    this._source = null;
    this._outPos = 0;        // 播放位置（处理后的输出时间，秒）
    this._startCtxTime = 0;
    this._token = 0;         // 处理令牌，用于丢弃过期结果
  }

  AudioEngine.prototype.setParams = function (p) {
    this.params = {};
    for (var k in DEFAULT_PARAMS) this.params[k] = p[k];
  };

  AudioEngine.prototype._ensureContext = function () {
    if (!this.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
    }
    return this.ctx;
  };

  /* 效果节点组：lowshelf → dry → master；lowshelf → convolver → wet → master */
  AudioEngine.prototype._buildNodes = function (ctx) {
    var lowshelf = ctx.createBiquadFilter();
    lowshelf.type = 'lowshelf';
    var dry = ctx.createGain();
    var convolver = ctx.createConvolver();
    convolver.buffer = generateIR(ctx, this.params.reverbSize);
    var wet = ctx.createGain();
    var master = ctx.createGain();
    lowshelf.connect(dry);
    dry.connect(master);
    lowshelf.connect(convolver);
    convolver.connect(wet);
    wet.connect(master);
    return { lowshelf: lowshelf, dry: dry, convolver: convolver, wet: wet, master: master };
  };

  AudioEngine.prototype._applyEffectParams = function (nodes, ctx) {
    var p = this.params;
    nodes.lowshelf.frequency.value = p.bassFreq;
    nodes.lowshelf.gain.value = p.bassGain;
    nodes.dry.gain.value = 1 - p.reverbMix;
    nodes.wet.gain.value = p.reverbMix;
    if (!this._irCache || this._irCache.ctx !== ctx || this._irCache.size !== p.reverbSize) {
      nodes.convolver.buffer = generateIR(ctx, p.reverbSize);
      this._irCache = { ctx: ctx, size: p.reverbSize, buffer: nodes.convolver.buffer };
    }
  };

  /* 效果参数（混响/低频）变化：只更新实时节点，不触发重处理 */
  AudioEngine.prototype.applyEffectsLive = function () {
    if (this._live) this._applyEffectParams(this._live, this._ensureContext());
  };

  /* 音调目标倍率：磁带慢放含 speed 因子（音高随速度自然下降），变速保调不含 */
  AudioEngine.prototype._pitchRatio = function () {
    var p = this.params;
    return (p.mode === 'tape' ? p.speed : 1) * Math.pow(2, p.pitch / 12);
  };

  AudioEngine.prototype.loadFile = function (file) {
    var self = this;
    this.stop();
    this.processed = null;
    return file.arrayBuffer().then(function (ab) {
      var ctx = self._ensureContext();
      return ctx.decodeAudioData(ab).then(function (decoded) {
        self.buffer = decoded;
        self._outPos = 0;
        return self.reprocess().then(function () { return decoded; });
      });
    });
  };

  /* 变速/变调参数变化：重新处理（保留当前输入位置，处理完自动续播） */
  AudioEngine.prototype.reprocess = function () {
    var self = this;
    if (!this.buffer) return Promise.resolve();
    var token = ++this._token;
    var wasPlaying = this.playing;
    var inputPos = this.getInputPos();
    this._stopSource();
    this.playing = false;
    var speed = this.params.speed;
    return this._soundtouchProcess(this.buffer, speed, this._pitchRatio(), token)
      .then(function (processed) {
        if (token !== self._token || !processed) return;
        self.processed = processed;
        self._outPos = Math.min(inputPos / speed, Math.max(0, processed.duration - 0.01));
        if (wasPlaying) return self.play();
      })
      .then(function () {
        if (self.onStateChange) self.onStateChange();
      });
  };

  /* 用 soundtouch 分块处理整段音频 → 新的 AudioBuffer（按响度截掉尾部静音） */
  AudioEngine.prototype._soundtouchProcess = function (input, speed, pitchRatio, token) {
    var self = this;
    return new Promise(function (resolve) {
      var sr = input.sampleRate;
      var st = new window.SoundTouch();
      st.tempo = speed;
      st.pitch = pitchRatio;
      st.rate = 1;
      var L = input.getChannelData(0);
      var R = input.numberOfChannels > 1 ? input.getChannelData(1) : L;
      var inLen = L.length;
      var expected = Math.round(inLen / speed);
      var total = inLen + Math.round(sr * PAD_SEC);
      var inPos = 0;
      var outChunks = [];
      var inter = new Float32Array(CHUNK * 2);

      function drain() {
        st.process();
        var ob = st.outputBuffer;
        while (ob.frameCount > 0) {
          var n = ob.frameCount;
          var tmp = new Float32Array(n * 2);
          ob.receiveSamples(tmp, n);
          outChunks.push(tmp);
        }
      }

      function step() {
        if (token !== self._token) { resolve(null); return; }
        var n = Math.min(CHUNK, total - inPos);
        var k;
        if (inPos < inLen) {
          for (k = 0; k < n; k++) { inter[2 * k] = L[inPos + k]; inter[2 * k + 1] = R[inPos + k]; }
        } else {
          for (k = 0; k < n; k++) { inter[2 * k] = 0; inter[2 * k + 1] = 0; }
        }
        st.inputBuffer.putSamples(inter, 0, n);
        inPos += n;
        drain();
        if (inPos < total) {
          setTimeout(step, 0);
        } else {
          resolve(self._assemble(outChunks, sr, expected, token));
        }
      }
      step();
    });
  };

  AudioEngine.prototype._assemble = function (outChunks, sr, expected, token) {
    var totalFrames = 0;
    for (var i = 0; i < outChunks.length; i++) totalFrames += outChunks[i].length / 2;
    var merged = new Float32Array(totalFrames * 2);
    var pos = 0;
    for (var j = 0; j < outChunks.length; j++) { merged.set(outChunks[j], pos); pos += outChunks[j].length; }

    // 从尾部找最后一个有声样本（尾部 padding/算法残余是静音）
    var peak = 0;
    for (var m = 0; m < merged.length; m++) {
      var a = Math.abs(merged[m]);
      if (a > peak) peak = a;
    }
    var thresh = peak * 0.0005;
    var lastLoud = -1;
    for (var k = merged.length - 1; k >= 1; k -= 2) {
      if (Math.abs(merged[k]) > thresh || Math.abs(merged[k - 1]) > thresh) { lastLoud = k; break; }
    }
    var tail = Math.round(TAIL_SEC * sr);
    var end = (lastLoud >= 0) ? Math.floor(lastLoud / 2) + tail : expected + tail;
    end = Math.min(end, totalFrames);
    if (end < 1) end = 1;

    var ctx = this._ensureContext();
    var out = ctx.createBuffer(2, end, sr);
    var ch0 = out.getChannelData(0);
    var ch1 = out.getChannelData(1);
    for (var q = 0; q < end; q++) { ch0[q] = merged[q * 2]; ch1[q] = merged[q * 2 + 1]; }
    return out;
  };

  AudioEngine.prototype.play = function (pos) {
    var self = this;
    if (!this.processed) return Promise.reject(new Error('尚未处理完成'));
    if (this.playing) return Promise.resolve();
    var ctx = this._ensureContext();
    var outPos = (pos !== undefined) ? pos : this._outPos;
    if (outPos < 0) outPos = 0;
    if (outPos >= this.processed.duration) outPos = 0;
    return ctx.resume().then(function () {
      if (!self._live) {
        self._live = self._buildNodes(ctx);
        self._live.master.connect(ctx.destination);
      }
      self._applyEffectParams(self._live, ctx);
      var source = ctx.createBufferSource();
      source.buffer = self.processed;
      source.playbackRate.value = 1;
      source.connect(self._live.lowshelf);
      source.start(0, outPos);
      self._source = source;
      self._outPos = outPos;
      self._startCtxTime = ctx.currentTime;
      self.playing = true;
      self.paused = false;
      if (self.onStateChange) self.onStateChange();
    });
  };

  AudioEngine.prototype.pause = function () {
    if (!this.playing) return;
    this._outPos = this.currentOutPos();
    this._stopSource();
    this.playing = false;
    this.paused = true;
    if (this.onStateChange) this.onStateChange();
  };

  AudioEngine.prototype.stop = function () {
    var was = this.playing || this.paused;
    this._stopSource();
    this.playing = false;
    this.paused = false;
    this._outPos = 0;
    if (was && this.onStateChange) this.onStateChange();
  };

  AudioEngine.prototype.seek = function (outPos) {
    var wasPlaying = this.playing;
    if (wasPlaying) { this._outPos = this.currentOutPos(); this._stopSource(); this.playing = false; }
    var dur = this.processed ? this.processed.duration : 0;
    this._outPos = Math.max(0, Math.min(outPos, Math.max(0, dur - 0.01)));
    if (wasPlaying) this.play();
  };

  AudioEngine.prototype._stopSource = function () {
    if (this._source) {
      try { this._source.stop(0); } catch (e) { /* 已结束 */ }
      this._source.disconnect();
      this._source = null;
    }
  };

  /* 当前播放位置（输出时间，秒） */
  AudioEngine.prototype.currentOutPos = function () {
    if (this.playing && this._source && this.ctx) {
      return this._outPos + (this.ctx.currentTime - this._startCtxTime);
    }
    return this._outPos;
  };

  /* 当前播放位置折算回原始（未变速）输入时间，用于重处理后保持进度 */
  AudioEngine.prototype.getInputPos = function () {
    return this.currentOutPos() * this.params.speed;
  };

  /* 离线渲染：变速/变调结果过一遍效果图，返回最终 AudioBuffer */
  AudioEngine.prototype.render = function () {
    if (!this.processed) return Promise.reject(new Error('尚未处理完成'));
    var sr = this.processed.sampleRate;
    var dur = this.processed.duration + this.params.reverbSize + 0.1;
    var offline = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
    var nodes = this._buildNodes(offline);
    nodes.master.connect(offline.destination);
    this._applyEffectParams(nodes, offline);
    var source = offline.createBufferSource();
    source.buffer = this.processed;
    source.connect(nodes.lowshelf);
    source.start(0);
    return offline.startRendering();
  };

  window.ReverberAudioEngine = AudioEngine;
  window.ReverberDefaultParams = DEFAULT_PARAMS;
})();
