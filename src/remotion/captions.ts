import {parseSrt, type Caption} from '@remotion/captions';
import {z} from 'zod';

const CaptionSchema = z
  .object({
    text: z.string().refine((value) => value.trim().length > 0, {
      message: 'text must not be empty',
    }),
    startMs: z.number().finite().nonnegative(),
    endMs: z.number().finite().nonnegative(),
    timestampMs: z.number().finite().nullable(),
    confidence: z.number().finite().nullable(),
  })
  .superRefine((caption, context) => {
    if (caption.endMs <= caption.startMs) {
      context.addIssue({
        code: 'custom',
        path: ['endMs'],
        message: 'endMs must be greater than startMs',
      });
    }
  });

const formatIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.join('.') || 'caption'}: ${issue.message}`)
    .join('; ');

const CaptionListSchema = z.array(CaptionSchema).min(1, {
  message: 'caption file must contain at least one caption',
});

const SRT_TIMING_LINE =
  /^\d{2,}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2,}:\d{2}:\d{2}[,.]\d{3}(?:\s+.*)?$/;

const validateSrtBlocks = (content: string): void => {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    throw new Error('Invalid SRT: caption file is empty');
  }
  const blocks = normalized.split(/\n[ \t]*\n+/).filter((block) => block.trim().length > 0);
  blocks.forEach((block, index) => {
    const lines = block.split('\n');
    const timingIndex = /^\d+$/.test(lines[0]?.trim() ?? '') ? 1 : 0;
    const timingLine = lines[timingIndex]?.trim() ?? '';
    const hasText = lines.slice(timingIndex + 1).some((line) => line.trim().length > 0);
    if (!SRT_TIMING_LINE.test(timingLine) || !hasText) {
      throw new Error(`Invalid SRT caption block ${index + 1}`);
    }
  });
};

export const parseCaptionContent = (
  content: string,
  format: 'srt' | 'remotion-json',
): Caption[] => {
  let captions: unknown;
  if (format === 'srt') {
    validateSrtBlocks(content);
    captions = parseSrt({input: content}).captions;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error(`Invalid Remotion Caption JSON: ${(error as Error).message}`);
    }
    captions = Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === 'object'
        ? (parsed as {captions?: unknown}).captions
        : undefined;
    if (!Array.isArray(captions)) {
      throw new Error(
        'Invalid Remotion Caption JSON: expected an array or an object containing captions[]',
      );
    }
  }

  const result = CaptionListSchema.safeParse(captions);
  if (!result.success) {
    throw new Error(`Invalid caption data: ${formatIssues(result.error)}`);
  }
  return result.data;
};
