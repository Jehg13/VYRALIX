import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const defaultTimeoutMs = 12_000;

function executable(env, envName, fallback) {
  const configured = env[envName]?.trim();
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

function failureStatus(error, pathConfigured) {
  if (error.code === 'ENOENT') return pathConfigured ? 'configured_path_not_found' : 'not_found';
  if (error.code === 'ETIMEDOUT' || error.killed) return 'timed_out';
  return 'execution_failed';
}

function failureMessage(tool, status) {
  if (status === 'not_found') return `${tool} no está instalado o no se encuentra en PATH.`;
  if (status === 'configured_path_not_found') return `No se encontró el ejecutable indicado en ${tool === 'FFmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'}.`;
  if (status === 'timed_out') return `${tool} no respondió dentro del tiempo de diagnóstico.`;
  return `No se pudo ejecutar ${tool}. Revisa la ruta configurada y los permisos.`;
}

export async function detectFfmpeg({ env = process.env, readCapabilityImpl = readCapability } = {}) {
  const ffmpegPathConfigured = Boolean(env.FFMPEG_PATH?.trim());
  const ffprobePathConfigured = Boolean(env.FFPROBE_PATH?.trim());
  const ffmpegBinary = executable(env, 'FFMPEG_PATH', 'ffmpeg');
  const ffprobeBinary = executable(env, 'FFPROBE_PATH', 'ffprobe');
  const diagnostic = {
    ffmpeg: { available: false, status: 'unknown', version: null, h264: false, aac: false, subtitles: false, error: null },
    ffprobe: { available: false, status: 'unknown', version: null, error: null },
    windowsSetup: 'Instala FFmpeg desde una distribución confiable o con winget install Gyan.FFmpeg; luego reinicia la API. También puedes configurar FFMPEG_PATH y FFPROBE_PATH en .env.',
  };
  try {
    const output = await readCapabilityImpl(ffmpegBinary, ['-version']);
    diagnostic.ffmpeg.available = true;
    diagnostic.ffmpeg.status = 'available';
    diagnostic.ffmpeg.version = output.split(/\r?\n/, 1)[0].slice(0, 240);
  } catch (error) {
    diagnostic.ffmpeg.status = failureStatus(error, ffmpegPathConfigured);
    diagnostic.ffmpeg.error = failureMessage('FFmpeg', diagnostic.ffmpeg.status);
  }
  try {
    const output = await readCapabilityImpl(ffprobeBinary, ['-version']);
    diagnostic.ffprobe.available = true;
    diagnostic.ffprobe.status = 'available';
    diagnostic.ffprobe.version = output.split(/\r?\n/, 1)[0].slice(0, 240);
  } catch (error) {
    diagnostic.ffprobe.status = failureStatus(error, ffprobePathConfigured);
    diagnostic.ffprobe.error = failureMessage('FFprobe', diagnostic.ffprobe.status);
  }
  if (diagnostic.ffmpeg.available) {
    try {
      const encoders = await readCapabilityImpl(ffmpegBinary, ['-hide_banner', '-encoders']);
      const filters = await readCapabilityImpl(ffmpegBinary, ['-hide_banner', '-filters']);
      diagnostic.ffmpeg.h264 = /\blibx264\b/.test(encoders);
      diagnostic.ffmpeg.aac = /\baac\b/.test(encoders);
      diagnostic.ffmpeg.subtitles = /\bsubtitles\b/.test(filters);
    } catch {
      diagnostic.ffmpeg.status = 'capability_check_failed';
      diagnostic.ffmpeg.error = 'FFmpeg está instalado, pero no se pudieron consultar sus capacidades.';
    }
  }
  return diagnostic;
}

export function ffmpegPath() {
  return executable(process.env, 'FFMPEG_PATH', 'ffmpeg');
}

export function ffprobePath() {
  return executable(process.env, 'FFPROBE_PATH', 'ffprobe');
}
