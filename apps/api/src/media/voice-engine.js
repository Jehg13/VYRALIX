import { spawn } from 'node:child_process';

const listVoicesScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $items = @($synthesizer.GetInstalledVoices() | ForEach-Object {
  [PSCustomObject]@{
    id = $_.VoiceInfo.Name
    name = $_.VoiceInfo.Name
    language = $_.VoiceInfo.Culture.Name
    gender = $_.VoiceInfo.Gender.ToString()
  }
})
} finally {
  $synthesizer.Dispose()
}
ConvertTo-Json -InputObject $items -Compress
`;

const synthesizeScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synthesizer.SelectVoice([string]$payload.voiceId)
  $synthesizer.Rate = [int]$payload.rate
  $synthesizer.Volume = [int]$payload.volume
  $synthesizer.SetOutputToWaveFile([string]$payload.outputPath)
  $synthesizer.Speak([string]$payload.text)
} finally {
  $synthesizer.Dispose()
}
`;

function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function createWindowsSpeechEngine({
  executable = process.platform === 'win32'
    ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe',
  spawnImpl = spawn,
  timeoutMs = 120_000,
} = {}) {
  function run(script, { input, signal, timeout = timeoutMs } = {}) {
    if (process.platform !== 'win32') {
      return Promise.reject(Object.assign(new Error('La voz local Windows SAPI solo está disponible en Windows.'), { code: 'tts_unavailable' }));
    }
    return new Promise((resolve, reject) => {
      const child = spawnImpl(executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(script),
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => {
        child.kill();
        finish(Object.assign(new Error('La generación de voz fue cancelada.'), { code: 'cancelled' }));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(Object.assign(new Error('La generación de voz excedió el tiempo permitido.'), { code: 'tts_timeout' }));
      }, timeout);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-64_000); });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
      child.once('error', () => finish(Object.assign(new Error('No se pudo iniciar Windows PowerShell para la voz local.'), { code: 'tts_unavailable' })));
      child.once('close', (code) => {
        if (signal?.aborted) return finish(Object.assign(new Error('La generación de voz fue cancelada.'), { code: 'cancelled' }));
        if (code !== 0) {
          return finish(Object.assign(new Error('Windows SAPI no pudo generar el archivo de voz.'), {
            code: stderr.includes('SelectVoice') ? 'tts_voice_unavailable' : 'tts_generation_failed',
          }));
        }
        finish(null, stdout.trim());
      });
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (input !== undefined) child.stdin.end(JSON.stringify(input), 'utf8');
      else child.stdin.end();
    });
  }

  return {
    id: 'windows_sapi',
    async listVoices() {
      const result = await run(listVoicesScript, { timeout: 15_000 });
      let voices;
      try {
        voices = JSON.parse(result);
      } catch {
        throw Object.assign(new Error('Windows SAPI devolvió una lista de voces inválida.'), { code: 'tts_invalid_response' });
      }
      if (!Array.isArray(voices)) {
        throw Object.assign(new Error('Windows SAPI devolvió una lista de voces inválida.'), { code: 'tts_invalid_response' });
      }
      return voices.filter((voice) =>
        typeof voice.id === 'string' && typeof voice.name === 'string' &&
        typeof voice.language === 'string' && typeof voice.gender === 'string');
    },
    synthesize({ text, voiceId, rate, volume, outputPath, signal }) {
      return run(synthesizeScript, {
        input: { text, voiceId, rate, volume, outputPath },
        signal,
      });
    },
  };
}
