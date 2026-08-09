/** Browser UI for the whiteboard — served as a single HTML page. */

export function whiteboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Whiteboard</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #1a1a2e;
      --fg: #e0e0e0;
      --muted: #888;
      --border: #333;
      --accent: #6c63ff;
      --code-bg: #16162a;
      --danger: #e74c3c;
    }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--fg);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    #header {
      padding: 12px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    #header h1 { font-size: 18px; font-weight: 600; }
    #status-badge {
      font-size: 12px;
      color: var(--muted);
      padding: 4px 10px;
      border: 1px solid var(--border);
      border-radius: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #status-badge.active { color: var(--accent); border-color: var(--accent); }
    #diagram-container {
      flex: 1;
      overflow: auto;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    #diagram { max-width: 100%; }
    #diagram svg { max-width: 100%; height: auto; }
    #transcript-panel {
      max-height: 120px;
      overflow-y: auto;
      padding: 8px 20px;
      border-top: 1px solid var(--border);
      font-size: 14px;
    }
    #transcript .partial { color: var(--muted); font-style: italic; }
    #transcript .final { color: var(--fg); margin-bottom: 2px; }
    #controls {
      padding: 12px 20px;
      border-top: 1px solid var(--border);
      display: flex;
      gap: 8px;
      align-items: center;
    }
    #text-input {
      flex: 1;
      padding: 10px 14px;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--fg);
      font-size: 14px;
      outline: none;
    }
    #text-input:focus { border-color: var(--accent); }
    button {
      padding: 10px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--code-bg);
      color: var(--fg);
      font-size: 14px;
      cursor: pointer;
      transition: border-color 0.15s, transform 0.1s;
      white-space: nowrap;
    }
    button:hover { border-color: var(--accent); }
    button:active { transform: scale(0.97); }
    button.recording {
      background: var(--danger);
      border-color: var(--danger);
      color: white;
      animation: pulse 1s infinite;
    }
    button.active { border-color: var(--accent); color: var(--accent); }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }
    #empty-state { text-align: center; color: var(--muted); }
    #empty-state h2 { font-size: 22px; margin-bottom: 8px; font-weight: 400; }
    #empty-state p { font-size: 14px; }
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="header">
    <h1>&#x1f4cb; Whiteboard</h1>
    <div id="status-badge">Connecting...</div>
  </div>
  <div id="diagram-container">
    <div id="diagram">
      <div id="empty-state">
        <h2>Start whiteboarding</h2>
        <p>Type a description below or push to talk</p>
      </div>
    </div>
  </div>
  <div id="transcript-panel"><div id="transcript"></div></div>
  <div id="controls">
    <input type="text" id="text-input" placeholder="Describe a diagram..." autocomplete="off" />
    <button id="send-btn">Send</button>
    <button id="talk-btn">&#x1f3a4; Push to Talk</button>
    <button id="continuous-btn">&#x267e;&#xfe0f; Continuous</button>
    <button id="clear-btn">Clear</button>
  </div>
  <script>
    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });

    let ws = null;
    let mediaRecorder = null;
    let audioChunks = [];
    let audioContext = null;
    let audioWorkletNode = null;
    let micStream = null;
    let isStreaming = false;

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host);
      ws.binaryType = 'arraybuffer';

      ws.onopen = function () {
        document.getElementById('status-badge').textContent = 'Ready';
        document.getElementById('status-badge').classList.add('active');
      };
      ws.onclose = function () {
        document.getElementById('status-badge').textContent = 'Disconnected';
        document.getElementById('status-badge').classList.remove('active');
        setTimeout(connect, 1000);
      };
      ws.onerror = function () {};
      ws.onmessage = function (event) {
        var msg = JSON.parse(event.data);
        handleMessage(msg);
      };
    }

    function handleMessage(msg) {
      switch (msg.type) {
        case 'mermaid': renderMermaid(msg.code); break;
        case 'partial': showTranscript(msg.text, 'partial'); break;
        case 'final': showTranscript(msg.text, 'final'); break;
        case 'status': updateStatus(msg.state); break;
        case 'error': console.error(msg.message); updateStatus('error'); break;
      }
    }

    async function renderMermaid(code) {
      var container = document.getElementById('diagram');
      if (!code || !code.trim()) {
        container.innerHTML = '<div id="empty-state"><h2>Start whiteboarding</h2><p>Type a description below or push to talk</p></div>';
        return;
      }
      try {
        var result = await mermaid.render('mermaid-diagram', code);
        container.innerHTML = result.svg;
      } catch (err) {
        container.innerHTML = '<div id="empty-state"><h2>Diagram error</h2><p>' + err.message + '</p></div>';
      }
    }

    function showTranscript(text, type) {
      var panel = document.getElementById('transcript');
      if (type === 'partial') {
        var partialEl = panel.querySelector('.partial');
        if (!partialEl) {
          partialEl = document.createElement('div');
          partialEl.className = 'partial';
          panel.appendChild(partialEl);
        }
        partialEl.textContent = text;
      } else {
        var p = panel.querySelector('.partial');
        if (p) p.remove();
        var el = document.createElement('div');
        el.className = 'final';
        el.textContent = text;
        panel.appendChild(el);
        panel.scrollTop = panel.scrollHeight;
      }
    }

    function updateStatus(state) {
      var badge = document.getElementById('status-badge');
      switch (state) {
        case 'idle':
          badge.textContent = 'Ready';
          badge.classList.add('active');
          break;
        case 'generating':
          badge.innerHTML = '<span class="spinner"></span> Generating';
          badge.classList.add('active');
          break;
        case 'transcribing':
          badge.innerHTML = '<span class="spinner"></span> Transcribing';
          badge.classList.add('active');
          break;
        case 'streaming':
          badge.textContent = 'Listening';
          badge.classList.add('active');
          break;
        default:
          badge.textContent = state;
      }
    }

    // Text input
    var textInput = document.getElementById('text-input');
    var sendBtn = document.getElementById('send-btn');

    function sendText() {
      var text = textInput.value.trim();
      if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'text', text: text }));
      textInput.value = '';
      showTranscript(text, 'final');
    }
    sendBtn.onclick = sendText;
    textInput.onkeydown = function (e) { if (e.key === 'Enter') sendText(); };

    // Push to talk (one-shot recording)
    var talkBtn = document.getElementById('talk-btn');
    talkBtn.onmousedown = startRecording;
    talkBtn.onmouseup = stopRecording;
    talkBtn.onmouseleave = stopRecording;
    talkBtn.ontouchstart = function (e) { e.preventDefault(); startRecording(); };
    talkBtn.ontouchend = function (e) { e.preventDefault(); stopRecording(); };

    async function startRecording() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        mediaRecorder = new MediaRecorder(micStream);
        mediaRecorder.ondataavailable = function (e) {
          if (e.data.size > 0) audioChunks.push(e.data);
        };
        mediaRecorder.start();
        talkBtn.classList.add('recording');
        talkBtn.textContent = 'Recording...';
      } catch (err) {
        alert('Microphone access denied: ' + err.message);
      }
    }

    async function stopRecording() {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
      await new Promise(function (resolve) {
        mediaRecorder.onstop = resolve;
        mediaRecorder.stop();
      });
      talkBtn.classList.remove('recording');
      talkBtn.innerHTML = '&#x1f3a4; Push to Talk';
      var blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
      if (blob.size === 0) return;
      var format = (mediaRecorder.mimeType.split(';')[0].split('/')[1] || 'webm');
      ws.send(JSON.stringify({ type: 'audio', format: format }));
      ws.send(await blob.arrayBuffer());
      if (micStream) {
        micStream.getTracks().forEach(function (t) { t.stop(); });
        micStream = null;
      }
    }

    // Continuous mode (streaming via AudioWorklet)
    var continuousBtn = document.getElementById('continuous-btn');
    continuousBtn.onclick = toggleContinuous;

    async function toggleContinuous() {
      if (isStreaming) { stopStreaming(); } else { await startStreaming(); }
    }

    async function startStreaming() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new AudioContext({ sampleRate: 48000 });
        var workletCode = [
          'class PCM16Processor extends AudioWorkletProcessor {',
          '  process(inputs) {',
          '    var input = inputs[0];',
          '    if (input && input[0]) {',
          '      var channel = input[0];',
          '      var resampled = [];',
          '      for (var i = 0; i < channel.length; i += 2) {',
          '        var s = Math.max(-1, Math.min(1, channel[i]));',
          '        resampled.push(s < 0 ? s * 0x8000 : s * 0x7FFF);',
          '      }',
          '      this.port.postMessage(new Int16Array(resampled));',
          '    }',
          '    return true;',
          '  }',
          '}',
          'registerProcessor("pcm16-processor", PCM16Processor);'
        ].join('\\n');
        var workletUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
        await audioContext.audioWorklet.addModule(workletUrl);
        var source = audioContext.createMediaStreamSource(micStream);
        audioWorkletNode = new AudioWorkletNode(audioContext, 'pcm16-processor');
        audioWorkletNode.port.onmessage = function (e) {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(e.data.buffer);
          }
        };
        source.connect(audioWorkletNode);
        ws.send(JSON.stringify({ type: 'stream_start' }));
        isStreaming = true;
        continuousBtn.classList.add('active');
        continuousBtn.innerHTML = '&#x23f9; Stop';
      } catch (err) {
        alert('Microphone access denied: ' + err.message);
      }
    }

    function stopStreaming() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stream_stop' }));
      }
      isStreaming = false;
      continuousBtn.classList.remove('active');
      continuousBtn.innerHTML = '&#x267e;&#xfe0f; Continuous';
      if (audioWorkletNode) { audioWorkletNode.disconnect(); audioWorkletNode = null; }
      if (audioContext) { audioContext.close(); audioContext = null; }
      if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
    }

    // Clear
    document.getElementById('clear-btn').onclick = function () {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'clear' }));
      document.getElementById('transcript').innerHTML = '';
    };

    connect();
  </script>
</body>
</html>`;
}
