import { z } from 'zod';

export const categories = [
  'Memes originales',
  'Tendencias',
  'Entretenimiento',
  'Historias originales',
  'Curiosidades',
  'Noticias verificadas',
  'Contenido educativo ligero',
];

export const generationInputSchema = z.object({
  category: z.enum(categories),
  audience: z.string().trim().min(2).max(240).default('Público general adulto'),
  tone: z.string().trim().min(2).max(120).default('natural, ágil y cercano'),
  creativeGoal: z.string().trim().min(2).max(300).default('captar atención y ofrecer valor'),
  format: z.enum(['storytime', 'lista', 'sketch', 'explicativo', 'pregunta', 'libre']).default('libre'),
  durationSeconds: z.number().int().min(10).max(180).default(30),
  variants: z.number().int().min(1).max(4).default(2),
  restrictions: z.string().trim().max(1200).default(''),
  variationContext: z.string().trim().max(800).optional(),
  provider: z.enum(['auto', 'gemini', 'groq', 'ollama']).default('auto'),
});

export const generatedVariantSchema = z.object({
  title: z.string().trim().min(2).max(160),
  idea: z.string().trim().min(10).max(1200),
  hook: z.string().trim().min(4).max(300),
  script: z.string().trim().min(20).max(4000),
  description: z.string().trim().min(2).max(1000),
  hashtags: z.array(z.string().trim().min(1).max(60)).max(15),
  format: z.string().trim().min(2).max(80),
  durationSeconds: z.number().int().min(5).max(300),
  imageText: z.string().trim().max(500).default(''),
  mediaPrompt: z.string().trim().max(1000).default(''),
  warnings: z.array(z.string().trim().min(2).max(300)).max(8).default([]),
});

export const generatedResultSchema = z.object({
  variants: z.array(generatedVariantSchema).min(1).max(4),
});

export function buildPrompt(input) {
  const shape = {
    variants: [{
      title: 'string',
      idea: 'string',
      hook: 'string',
      script: 'string',
      description: 'string',
      hashtags: ['string'],
      format: 'string',
      durationSeconds: 30,
      imageText: 'string; vacío si no aplica',
      mediaPrompt: 'string; vacío si no aplica',
      warnings: ['string; incluye revisión de fuente si hay afirmaciones factuales'],
    }],
  };
  return [
    'Eres un guionista creativo para TikTok. Escribe contenido original en español, apto para el público indicado.',
    'Devuelve únicamente JSON válido, sin Markdown ni texto fuera del objeto.',
    `El objeto debe seguir esta estructura y tipos: ${JSON.stringify(shape)}.`,
    `Genera exactamente ${input.variants} variantes distintas para la categoría "${input.category}".`,
    `Público: ${input.audience}. Tono: ${input.tone}. Objetivo: ${input.creativeGoal}.`,
    `Formato: ${input.format}. Duración objetivo: ${input.durationSeconds} segundos.`,
    `Restricciones: ${input.restrictions || 'ninguna adicional'}.`,
    input.variationContext ? `Crea una variante nueva basada en esta idea, sin repetirla literalmente: ${input.variationContext}` : '',
    'No inventes noticias, estadísticas, citas ni tendencias actuales. Para noticias verificadas, marca claramente la necesidad de comprobar fuentes y no afirmes actualidad sin fuente proporcionada.',
    'No copies obras o guiones conocidos. Usa hashtags como palabras sin el símbolo #.',
  ].join('\n');
}

export function parseGeneratedText(text, requestedVariants) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('La respuesta del modelo no contiene JSON válido.');
    try {
      value = JSON.parse(match[0]);
    } catch {
      throw new Error('La respuesta del modelo contiene JSON inválido.');
    }
  }
  const parsed = generatedResultSchema.safeParse(value);
  if (!parsed.success) throw new Error('La respuesta del proveedor no cumple el formato de contenido requerido.');
  if (parsed.data.variants.length !== requestedVariants) {
    throw new Error('El proveedor devolvió un número de variantes distinto al solicitado.');
  }
  return parsed.data;
}
