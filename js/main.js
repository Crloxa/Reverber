/* main.js — UI 逻辑：拖拽、参数绑定、进度条、传输控制、导出 */
(function () {
  'use strict';

  var engine = new ReverberAudioEngine();
  var currentFile = null;
  var baseName = '';
  var sliderInstances = {};
  var seekSlider = null;
  var seekTotal = 0;
  var seekDragging = false;
  var reprocessTimer = null;
  var seekTimer = null;

  var els = {};

  /* kind: 'tempo' = 变速/变调（触发重处理）；'effect' = 混响/低频（实时生效） */
  var SLIDERS = [
    { id: 'speed',      engineKey: 'speed',      kind: 'tempo',  start: 0.8, min: 0.5,  max: 1.5,  step: 0.05, toEngine: function (v) { return v; },      fmt: function (v) { return v.toFixed(2) + '×'; } },
    { id: 'pitch',      engineKey: 'pitch',      kind: 'tempo',  start: 0,   min: -12,   max: 12,   step: 1,    toEngine: function (v) { return v; },      fmt: function (v) { return (v > 0 ? '+' : '') + v + ' 半音'; } },
    { id: 'reverbSize', engineKey: 'reverbSize', kind: 'effect', start: 3,   min: 0.5,   max: 10,   step: 0.5,  toEngine: function (v) { return v; },      fmt: function (v) { return v.toFixed(1) + 's'; } },
    { id: 'reverbMix',  engineKey: 'reverbMix',  kind: 'effect', start: 30,  min: 0,     max: 100,  step: 1,    toEngine: function (v) { return v / 100; }, fmt: function (v) { return v + '%'; } },
    { id: 'bassGain',   engineKey: 'bassGain',   kind: 'effect', start: 6,   min: -12,   max: 12,   step: 1,    toEngine: function (v) { return v; },      fmt: function (v) { return (v > 0 ? '+' : '') + v + ' dB'; } },
    { id: 'bassFreq',   engineKey: 'bassFreq',   kind: 'effect', start: 200, min: 50,    max: 300,  step: 10,   toEngine: function (v) { return v; },      fmt: function (v) { return v + ' Hz'; } }
  ];

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, isError) {
    els.status.textContent = msg;
    els.status.classList.toggle('error', !!isError);
  }

  function formatDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function updateSeekLabel() {
    els.seekTime.textContent = formatDuration(engine.currentOutPos()) + ' / ' + formatDuration(seekTotal);
  }

  function syncSeekRange() {
    seekTotal = engine.processed ? engine.processed.duration : 0;
    if (seekSlider) seekSlider.updateOptions({ range: { min: 0, max: Math.max(seekTotal, 1) } });
    updateSeekLabel();
  }

  /* 变速/变调参数防抖重处理 */
  function scheduleReprocess() {
    if (!engine.buffer) return;
    clearTimeout(reprocessTimer);
    setStatus('参数已变化，正在重新处理…');
    reprocessTimer = setTimeout(function () {
      reprocessTimer = null;
      engine.reprocess().then(function () {
        syncSeekRange();
        if (!engine.playing && !engine.paused) setStatus('处理完成，可预览或导出');
      });
    }, 400);
  }

  function startSeekTimer() {
    stopSeekTimer();
    updateSeekLabel();
    seekTimer = setInterval(function () {
      var t = engine.currentOutPos();
      if (seekSlider && seekTotal > 0 && !seekDragging) seekSlider.set(t);
      updateSeekLabel();
      if (engine.playing && t >= seekTotal - 0.03) engine.stop();
    }, 100);
  }

  function stopSeekTimer() {
    if (seekTimer) { clearInterval(seekTimer); seekTimer = null; }
  }

  /* 由 engine.onStateChange 触发：同步按钮状态与进度计时器 */
  function syncTransport() {
    els.playPauseBtn.textContent = engine.playing ? '⏸ 暂停' : '▶ 播放';
    els.stopBtn.disabled = !engine.playing && !engine.paused && engine.currentOutPos() < 0.01;
    els.exportBtn.disabled = !engine.processed;
    if (engine.playing) startSeekTimer(); else stopSeekTimer();
  }

  function initSliders() {
    SLIDERS.forEach(function (s) {
      var el = $(s.id);
      noUiSlider.create(el, {
        start: [s.start],
        range: { min: s.min, max: s.max },
        step: s.step,
        connect: [true, false]
      });
      sliderInstances[s.id] = el.noUiSlider;
      el.noUiSlider.on('update', function (values) {
        var v = parseFloat(values[0]);
        var label = $(s.id + 'Value');
        if (label) label.textContent = s.fmt(v);
        engine.params[s.engineKey] = s.toEngine(v);
        if (s.kind === 'tempo') scheduleReprocess();
        else engine.applyEffectsLive();
      });
    });
  }

  function initSeek() {
    var el = $('seek');
    noUiSlider.create(el, {
      start: [0],
      range: { min: 0, max: 1 },
      step: 0.01,
      connect: [true, false]
    });
    seekSlider = el.noUiSlider;
    // slide：拖动中只预览位置，不重启播放；change：松手/tap 时真正 seek
    seekSlider.on('slide', function (values) {
      seekDragging = true;
      updateSeekLabel();
    });
    seekSlider.on('change', function (values) {
      seekDragging = false;
      engine.seek(parseFloat(values[0]));
      updateSeekLabel();
    });
  }

  function onModeChanged() {
    engine.params.mode = $('modePreserve').checked ? 'preserve' : 'tape';
    refreshModeLabels();
    scheduleReprocess();
  }

  function refreshModeLabels() {
    $('modeTape').checked = engine.params.mode === 'tape';
    $('modePreserve').checked = engine.params.mode === 'preserve';
  }

  function loadFile(file) {
    setStatus('正在解码并处理 ' + file.name + ' …（首次处理需稍等）');
    els.playPauseBtn.disabled = true;
    els.stopBtn.disabled = true;
    els.exportBtn.disabled = true;
    engine.loadFile(file).then(function (decoded) {
      currentFile = file;
      baseName = file.name.replace(/\.[^.]+$/, '');
      els.fileName.textContent = file.name;
      els.fileInfo.textContent = '时长 ' + formatDuration(decoded.duration) + ' · ' +
        decoded.sampleRate + 'Hz · ' + decoded.numberOfChannels + ' 声道';
      syncSeekRange();
      seekSlider.set(0);
      els.playPauseBtn.disabled = false;
      els.exportBtn.disabled = false;
      setStatus('已加载，可预览或导出');
      syncTransport();
    }).catch(function (err) {
      setStatus('解码失败：' + err.message + '（请确认是支持的音频格式）', true);
      syncTransport();
    });
  }

  function togglePlay() {
    if (engine.playing) {
      engine.pause();
      setStatus('已暂停');
    } else {
      engine.play().then(function () {
        setStatus('播放中… 拖动滑块可实时调整效果');
      }).catch(function (err) {
        setStatus('播放失败：' + err.message, true);
      });
    }
  }

  function stopPlayback() {
    engine.stop();
    seekSlider.set(0);
    updateSeekLabel();
    setStatus('已停止');
  }

  function exportAudio() {
    if (!engine.processed) {
      setStatus('请先选择一个音频文件', true);
      return;
    }
    els.exportBtn.disabled = true;
    var fmt = $('format').value;
    var ext = (fmt === 'mp3') ? 'mp3' : 'wav';
    setStatus('正在导出 ' + ext.toUpperCase() + '…（大文件可能稍慢）');
    engine.render().then(function (rendered) {
      var blob = (fmt === 'mp3')
        ? ReverberWavEncoder.encodeMP3(rendered)
        : ReverberWavEncoder.encodeWAV(rendered);
      var name = baseName + '_reverber.' + ext;
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
      setStatus('已导出：' + name);
    }).catch(function (err) {
      setStatus('导出失败：' + err.message, true);
    }).finally(function () {
      els.exportBtn.disabled = false;
    });
  }

  function init() {
    els.dropZone = $('dropZone');
    els.fileInput = $('fileInput');
    els.fileName = $('fileName');
    els.fileInfo = $('fileInfo');
    els.playPauseBtn = $('playPauseBtn');
    els.stopBtn = $('stopBtn');
    els.exportBtn = $('exportBtn');
    els.status = $('status');
    els.seekTime = $('seekTime');
    els.playPauseBtn.disabled = true;
    els.stopBtn.disabled = true;
    els.exportBtn.disabled = true;

    engine.onStateChange = syncTransport;

    // 点击选择文件
    els.dropZone.addEventListener('click', function () { els.fileInput.click(); });
    els.fileInput.addEventListener('change', function () {
      if (els.fileInput.files && els.fileInput.files[0]) loadFile(els.fileInput.files[0]);
      els.fileInput.value = '';
    });

    // 拖拽
    ['dragover', 'dragenter'].forEach(function (evt) {
      els.dropZone.addEventListener(evt, function (e) {
        e.preventDefault();
        els.dropZone.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      els.dropZone.addEventListener(evt, function (e) {
        e.preventDefault();
        els.dropZone.classList.remove('drag');
      });
    });
    els.dropZone.addEventListener('drop', function (e) {
      var files = e.dataTransfer.files;
      if (files && files[0]) loadFile(files[0]);
    });

    initSliders();
    initSeek();
    $('modeTape').addEventListener('change', onModeChanged);
    $('modePreserve').addEventListener('change', onModeChanged);

    els.playPauseBtn.addEventListener('click', togglePlay);
    els.stopBtn.addEventListener('click', stopPlayback);
    els.exportBtn.addEventListener('click', exportAudio);

    refreshModeLabels();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
