/* wav-encoder.js — AudioBuffer → WAV / MP3 Blob */
(function () {
  function writeString(view, offset, str) {
    for (var i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  function encodeWAV(audioBuffer) {
    var numChannels = audioBuffer.numberOfChannels;
    var sampleRate = audioBuffer.sampleRate;
    var numFrames = audioBuffer.length;
    var bytesPerSample = 2;
    var blockAlign = numChannels * bytesPerSample;
    var dataSize = numFrames * blockAlign;
    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);               // fmt 块大小
    view.setUint16(20, 1, true);                // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true); // 字节率
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);      // 位深
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    var offset = 44;
    var channelData = [];
    for (var c = 0; c < numChannels; c++) {
      channelData.push(audioBuffer.getChannelData(c));
    }
    for (var i = 0; i < numFrames; i++) {
      for (var c = 0; c < numChannels; c++) {
        var sample = Math.max(-1, Math.min(1, channelData[c][i]));
        sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset + (i * numChannels + c) * 2, sample, true);
      }
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  function toInt16(v) {
    v = Math.max(-1, Math.min(1, v));
    return v < 0 ? v * 0x8000 : v * 0x7fff;
  }

  var MP3_RATES = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];

  /* 线性重采样（lamejs 只支持有限的采样率） */
  function resample(data, inRate, outRate) {
    var out = new Float32Array(Math.ceil(data.length * outRate / inRate));
    var ratio = inRate / outRate;
    for (var i = 0; i < out.length; i++) {
      var src = i * ratio;
      var i0 = Math.floor(src);
      var i1 = Math.min(data.length - 1, i0 + 1);
      var frac = src - i0;
      out[i] = data[i0] * (1 - frac) + data[i1] * frac;
    }
    return out;
  }

  /* 用 lamejs（本地 vendor）编码 MP3。audioBuffer 为立体声 */
  function encodeMP3(audioBuffer, kbps) {
    kbps = kbps || 192;
    var channels = Math.min(2, audioBuffer.numberOfChannels);
    var sr = audioBuffer.sampleRate;
    var L = audioBuffer.getChannelData(0);
    var R = channels > 1 ? audioBuffer.getChannelData(1) : L;
    if (MP3_RATES.indexOf(sr) === -1) {
      L = resample(L, sr, 44100);
      R = resample(R, sr, 44100);
      sr = 44100;
    }
    var mp3enc = new lamejs.Mp3Encoder(channels, sr, kbps);
    var block = 1152;
    var left = new Int16Array(block);
    var right = new Int16Array(block);
    var out = [];
    for (var i = 0; i < L.length; i += block) {
      var n = Math.min(block, L.length - i);
      for (var j = 0; j < n; j++) {
        left[j] = toInt16(L[i + j]);
        right[j] = toInt16(R[i + j]);
      }
      var buf = (channels === 1)
        ? mp3enc.encodeBuffer(left.subarray(0, n))
        : mp3enc.encodeBuffer(left.subarray(0, n), right.subarray(0, n));
      if (buf.length > 0) out.push(new Uint8Array(buf));
    }
    var end = mp3enc.flush();
    if (end.length > 0) out.push(new Uint8Array(end));
    return new Blob(out, { type: 'audio/mpeg' });
  }

  window.ReverberWavEncoder = { encodeWAV: encodeWAV, encodeMP3: encodeMP3 };
})();
