import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const defaultTimeoutMs = 12_000;

function executable(envName, fallback) {
  const configured = process.env[envName]?.trim();
  return configured || fallback;
}

async function readCapability(binary, args) {
  const { stdout } = await execFileAsync(binary, args, {
    timeout: defaultTimeoutMs,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

export async function detectFfmpeg() {
  const ffmpegBinary = executable('FFMPEG_PATH', 'ffmpeg');
  const ffprobeBinary = executable('FFPROBE_PATH', 'ffprobe');
  const diagnostic = {
    ffmpeg: { available: false, version: null, h264: false, aac: false, subtitles: false, error: null },
    ffprobe: { available: false, version: null, error: null },
    windowsSetup: 'Instala FFmpeg desde una distribución confiable o con winget install Gyan.FFmpeg; luego reinicia la API. También puedes configurar FFmpeg_PATH y FFPROBE_PATH en .env.',
  };
  try {
    const output = await readCapability(ffmpegBinary, ['-version']);
    diagnostic.ffmpeg.available = true;
    diagnostic.ffmpeg.version = output.split(/\r?\n/, 1)[0].slice(0, 240);
  } catch (error) {
    diagnostic.ffmpeg.error = error.code === 'ENOENT'
      ? 'FFmpeg no está instalado o no se encuentra en PATH.'
      : 'No se pudo ejecutar FFmpeg. Revisa FFmpeg_PATH y permisos.';
  }
  try {
    const output = await readCapability(ffprobeBinary, ['-version']);
    diagnostic.ffprobe.available = true;
    diagnostic.ffprobe.version = output.split(/\r?\n/, 1)[0].slice(0, 240);
  } catch (error) {
    diagnostic.ffprobe.error = error.code === 'ENOENT'
      ? 'FFprobe no está instalado o no se encuentra en PATH.'
      : 'No se pudo ejecutar FFprobe. Revisa FFPROBE_PATH y permisos.';
  }
  if (diagnostic.ffmpeg.available) {
    try {
      const encoders = await readCapability(ffmpegBinary, ['-hide_banner', '-encoders']);
      const filters = await readCapability(ffmpegBinary, ['-hide_banner', '-filters']);
      diagnostic.ffmpeg.h264 = /\blibx264\b/.test(encoders);
      diagnostic.ffmpeg.aac = /\baac\b/.test(encoders);
      diagnostic.ffmpeg.subtitles = /\bsubtitles\b/.test(filters);
    } catch {
      diagnostic.ffmpeg.error = 'FFmpeg está instalado, pero no se pudieron consultar sus capacidades.';
    }
  }
  return diagnostic;
}

export function ffmpegPath() {
  return executable('FFMPEG_PATH', 'ffmpeg');
}

export function ffprobePath() {
  return executable('FFPROBE_PATH', 'ffprobe');
}
