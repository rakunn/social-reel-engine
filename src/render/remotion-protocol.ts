import {z} from 'zod';
import {RenderSettingsSchema} from '../contracts/schemas';

export const RemotionWorkerRequestSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  engineRoot: z.string().min(1),
  publicDir: z.string().min(1),
  target: z.enum(['preview', 'master', 'photo']),
  rawOutput: z.string().min(1),
  inputProps: z.record(z.string(), z.unknown()),
  settings: RenderSettingsSchema,
  photoOutputs: z
    .array(
      z.object({
        output: z.string().min(1),
        inputProps: z.record(z.string(), z.unknown()),
        jpegQuality: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .optional(),
  browserLifecycle: z
    .object({
      launcherPath: z.string().min(1),
      pgidPath: z.string().min(1),
    })
    .optional(),
}).superRefine((request, context) => {
  if (request.target === 'photo' && !request.photoOutputs?.length) {
    context.addIssue({
      code: 'custom',
      path: ['photoOutputs'],
      message: 'Photo render requests require at least one output',
    });
  }
});

export const RemotionWorkerResultSchema = z.discriminatedUnion('ok', [
  z.object({schemaVersion: z.literal('1.0.0'), ok: z.literal(true)}),
  z.object({
    schemaVersion: z.literal('1.0.0'),
    ok: z.literal(false),
    signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP']).nullable(),
    error: z.object({message: z.string(), stack: z.string().nullable()}),
  }),
]);

export type RemotionWorkerRequest = z.infer<typeof RemotionWorkerRequestSchema>;
export type RemotionWorkerResult = z.infer<typeof RemotionWorkerResultSchema>;
export type WorkerSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
export type BrowserLifecycleFiles = NonNullable<
  RemotionWorkerRequest['browserLifecycle']
>;
