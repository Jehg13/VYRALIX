const titleMaxLines = 2;
const captionMaxLines = 3;
const titleRegion = { left: 0.08, right: 0.08, top: 0.1, height: 0.16 };
const captionRegion = { left: 0.08, right: 0.19, top: 0.56, height: 0.14 };
const titleLineHeight = 1.2;
const captionLineHeight = 1.28;

function layoutError(message) {
  return Object.assign(new Error(message), { code: 'subtitle_layout_invalid' });
}

function glyphWidthEm(character) {
  if (/\s/u.test(character)) return 0.34;
  if (/[ilI1.,'`:;!|]/u.test(character)) return 0.36;
  if (/[MW@#%&]/u.test(character)) return 0.92;
  if (/[^\u0000-\u024F]/u.test(character)) return 1;
  if (/\p{Lu}/u.test(character)) return 0.72;
  return 0.62;
}

function measureLine(text, fontSizePixels) {
  return Array.from(text).reduce((width, character) => width + glyphWidthEm(character) * fontSizePixels, 0);
}

function splitLongWord(word, maxWidth, fontSizePixels) {
  const parts = [];
  let line = '';
  for (const character of Array.from(word)) {
    const candidate = `${line}${character}`;
    if (measureLine(candidate, fontSizePixels) > maxWidth) {
      if (!line) throw layoutError('Un carácter del texto excede el ancho seguro del video.');
      parts.push(line);
      line = character;
    } else {
      line = candidate;
    }
  }
  if (line) parts.push(line);
  return parts;
}

function wrapText(text, maxWidth, fontSizePixels) {
  const lines = [];
  const paragraphs = String(text || '').replace(/-->/gu, '→').split(/\r?\n/u);
  for (const paragraph of paragraphs) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/u).filter(Boolean)) {
      const parts = measureLine(word, fontSizePixels) > maxWidth
        ? splitLongWord(word, maxWidth, fontSizePixels)
        : [word];
      for (const part of parts) {
        const candidate = line ? `${line} ${part}` : part;
        if (measureLine(candidate, fontSizePixels) > maxWidth) {
          if (line) lines.push(line);
          line = part;
        } else {
          line = candidate;
        }
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function fontRange(width, role) {
  if (role === 'title') {
    return {
      max: Math.min(50, Math.round(width * 0.046)),
      min: Math.max(20, Math.round(width * 0.026)),
    };
  }
  return {
    max: Math.min(36, Math.round(width * 0.032)),
    min: Math.max(16, Math.round(width * 0.02)),
  };
}

function sceneTextRegion(width, height, role) {
  const region = role === 'title' ? titleRegion : captionRegion;
  const left = Math.round(width * region.left);
  const right = Math.round(width * region.right);
  const top = Math.round(height * region.top);
  const maxBlockHeight = Math.round(height * region.height);
  return {
    left,
    right,
    top,
    maxBlockHeight,
    maxLineWidth: width - left - right,
    anchorX: Math.round((left + width - right) / 2),
    maxLines: role === 'title' ? titleMaxLines : captionMaxLines,
    lineHeight: role === 'title' ? titleLineHeight : captionLineHeight,
  };
}

export function layoutSubtitleText(text, { width, height, role = 'caption' }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
    width * 16 !== height * 9 || !['title', 'caption'].includes(role)) {
    throw layoutError('La composición de texto requiere una resolución vertical 9:16 y un rol válido.');
  }
  const region = sceneTextRegion(width, height, role);
  const textValue = String(text || '').replace(/\0/gu, '').trim();
  const range = fontRange(width, role);
  if (!textValue) {
    return {
      lines: [],
      role,
      fontSizePixels: range.max,
      maxLineWidth: region.maxLineWidth,
      maxBlockHeight: region.maxBlockHeight,
      maxLines: region.maxLines,
      blockHeight: 0,
      lineWidths: [],
      minFontSizePixels: range.min,
      maxFontSizePixels: range.max,
      left: region.left,
      right: region.right,
      top: region.top,
      bottom: region.top,
      anchorX: region.anchorX,
      anchorY: region.top,
      lineHeight: region.lineHeight,
    };
  }

  for (let fontSizePixels = range.max; fontSizePixels >= range.min; fontSizePixels -= 1) {
    const lines = wrapText(textValue, region.maxLineWidth, fontSizePixels);
    const lineWidths = lines.map((line) => measureLine(line, fontSizePixels));
    const blockHeight = lines.length * fontSizePixels * region.lineHeight;
    if (lines.length <= region.maxLines && blockHeight <= region.maxBlockHeight &&
      lineWidths.every((lineWidth) => lineWidth <= region.maxLineWidth)) {
      return {
        lines,
        lineWidths,
        role,
        fontSizePixels,
        maxLineWidth: region.maxLineWidth,
        maxBlockHeight: region.maxBlockHeight,
        maxLines: region.maxLines,
        blockHeight,
        minFontSizePixels: range.min,
        maxFontSizePixels: range.max,
        left: region.left,
        right: region.right,
        top: region.top,
        bottom: region.top + blockHeight,
        anchorX: region.anchorX,
        anchorY: region.top,
        lineHeight: region.lineHeight,
      };
    }
  }

  throw layoutError(
    `El bloque de ${role === 'title' ? 'título' : 'subtítulos'} no cabe en su zona segura de ${width}×${height} ni con el tamaño mínimo de fuente (${range.min} px). Acorta el texto o divídelo entre escenas.`,
  );
}

export function subtitleAssStyleBlock({ width, height }) {
  const titleFontSize = fontRange(width, 'title').max;
  const captionFontSize = fontRange(width, 'caption').max;
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Arial,${titleFontSize},&H003FCCF3,&H000000FF,&HCC000000,&H66000000,-1,0,0,0,100,100,0,0,1,1.5,0,8,0,0,0,1
Style: Caption,Arial,${captionFontSize},&H00FFFFFF,&H000000FF,&HCC000000,&H66000000,0,0,0,0,100,100,0,0,1,1.25,0,8,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
}

export function assTimestamp(seconds) {
  const centiseconds = Math.round(seconds * 100);
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const remainingSeconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`;
}

export function escapeAssText(text) {
  return text.replace(/[\\{}]/gu, (character) => ({ '\\': '＼', '{': '｛', '}': '｝' })[character]);
}
