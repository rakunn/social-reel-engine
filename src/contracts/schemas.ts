import {z} from 'zod';
import {isCanonicalRec709ColorSpace} from '../core/color-spaces';

export const SCHEMA_VERSION = '1.0.0' as const;

const SchemaVersion = z.literal(SCHEMA_VERSION);
const IsoDateTime = z.string().datetime({offset: true});
const RelativePath = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'Path must be relative and must not contain traversal segments',
  });

export const ReelBriefSchema = z
  .object({
    schemaVersion: SchemaVersion,
    identity: z.object({
      reelName: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      title: z.string().min(1).max(160),
      createdAt: IsoDateTime,
    }),
    target: z
      .object({
        minSeconds: z.number().positive(),
        idealSeconds: z.number().positive(),
        maxSeconds: z.number().positive(),
      })
      .superRefine((target, context) => {
        if (!(target.minSeconds <= target.idealSeconds && target.idealSeconds <= target.maxSeconds)) {
          context.addIssue({
            code: 'custom',
            message: 'Target duration must satisfy minSeconds <= idealSeconds <= maxSeconds',
          });
        }
      }),
    output: z.object({
      width: z.literal(1080),
      height: z.literal(1920),
      fps: z.literal(30),
    }),
    style: z.literal('cinematic-minimal'),
    options: z.object({
      music: z.boolean(),
      captions: z.boolean(),
      cameraAudio: z.boolean(),
    }),
    rightsConfirmed: z.boolean(),
    notes: z.string().max(10_000).optional().default(''),
  })
  .strict();

const FfprobeSchema = z.object({
  format: z.record(z.string(), z.unknown()).optional().default({}),
  streams: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  chapters: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const SourceEntrySchema = z
  .object({
    id: z.string().min(1),
    relativePath: RelativePath,
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.enum(['video', 'audio', 'caption', 'lut', 'font', 'brand']),
    ffprobe: FfprobeSchema,
    camera: z.object({
      manufacturer: z.string().nullable().optional().default(null),
      model: z.string().nullable().optional().default(null),
      gamma: z.string().nullable().optional().default(null),
      gamut: z.string().nullable().optional().default(null),
      profileId: z.string().min(1).nullable(),
      confirmed: z.boolean(),
    }),
  })
  .superRefine((source, context) => {
    if (source.camera.confirmed && !source.camera.profileId) {
      context.addIssue({
        code: 'custom',
        path: ['camera', 'profileId'],
        message: 'A confirmed camera/profile must include profileId',
      });
    }
    if (source.mediaType === 'video' && source.camera.confirmed) {
      for (const field of ['model', 'gamma', 'gamut'] as const) {
        if (!source.camera[field]?.trim()) {
          context.addIssue({
            code: 'custom',
            path: ['camera', field],
            message: `A confirmed video source must include camera ${field}`,
          });
        }
      }
    }
  });

export const SourceManifestSchema = z
  .object({
    schemaVersion: SchemaVersion,
    generatedAt: IsoDateTime,
    sources: z.array(SourceEntrySchema),
  })
  .strict();

export const LutDefinitionSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['technical', 'creative', 'combined']),
    file: RelativePath,
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    cameraModel: z.string().min(1).nullable().optional().default(null),
    profileId: z.string().min(1).nullable().optional().default(null),
    inputGamma: z.string().min(1).nullable().optional().default(null),
    inputGamut: z.string().min(1).nullable().optional().default(null),
    inputColorSpace: z.string().min(1),
    outputColorSpace: z.string().min(1),
    transformSemantics: z.enum(['normalization', 'look', 'normalization-and-look']),
    defaultMix: z.number().min(0).max(1),
  })
  .superRefine((lut, context) => {
    const semantics = {
      technical: 'normalization',
      creative: 'look',
      combined: 'normalization-and-look',
    } as const;
    if (lut.transformSemantics !== semantics[lut.kind]) {
      context.addIssue({
        code: 'custom',
        path: ['transformSemantics'],
        message: `${lut.kind} LUT must declare ${semantics[lut.kind]} semantics`,
      });
    }
    if ((lut.kind === 'technical' || lut.kind === 'combined') && lut.defaultMix !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['defaultMix'],
        message: 'Technical and combined LUTs must be applied at full strength',
      });
    }
    if (lut.kind === 'technical' || lut.kind === 'combined') {
      if (!lut.profileId) {
        context.addIssue({
          code: 'custom',
          path: ['profileId'],
          message: 'Technical and combined LUTs must declare an exact profile ID',
        });
      }
      for (const field of ['inputGamma', 'inputGamut'] as const) {
        if (!lut[field]?.trim()) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: `Technical and combined LUTs must declare ${field}`,
          });
        }
      }
      if (!isCanonicalRec709ColorSpace(lut.outputColorSpace)) {
        context.addIssue({
          code: 'custom',
          path: ['outputColorSpace'],
          message: 'Technical and combined LUT output must be a canonical Rec.709 declaration',
        });
      }
    }
    if (
      lut.kind === 'creative' &&
      (!isCanonicalRec709ColorSpace(lut.inputColorSpace) ||
        !isCanonicalRec709ColorSpace(lut.outputColorSpace))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['inputColorSpace'],
        message: 'Creative LUT input and output must be canonical Rec.709 declarations',
      });
    }
  });

const CropPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  scale: z.number().min(1).max(4),
});

export const AnimatedCropSchema = z.object({
  start: CropPointSchema,
  end: CropPointSchema,
});

export const EditClipSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*$/),
    sourceId: z.string().min(1),
    inSeconds: z.number().nonnegative(),
    outSeconds: z.number().positive(),
    playbackRate: z.number().min(0.5).max(2),
    crop: AnimatedCropSchema,
    stabilization: z.object({
      enabled: z.boolean(),
      strength: z.number().min(0).max(1),
      fallbackToUnstabilized: z.boolean().default(true),
    }),
    grade: z.object({
      exposureStops: z.number().min(-4).max(4),
      whiteBalanceKelvin: z.number().int().min(2000).max(12_000),
      tint: z.number().min(-1).max(1),
      technicalLutId: z.string().min(1).nullable().optional().default(null),
      creativeLutId: z.string().min(1).nullable().optional().default(null),
      combinedLutId: z.string().min(1).nullable().optional().default(null),
      creativeMix: z.number().min(0).max(1).optional().default(0),
    }),
    audio: z.object({
      muted: z.boolean(),
      gainDb: z.number().min(-60).max(12),
    }),
    transitionAfter: z.object({
      type: z.enum(['none', 'fade', 'slide', 'wipe']),
      durationSeconds: z.number().min(0).max(1.5),
    }),
  })
  .superRefine((clip, context) => {
    if (clip.outSeconds <= clip.inSeconds) {
      context.addIssue({
        code: 'custom',
        path: ['outSeconds'],
        message: 'outSeconds must be greater than inSeconds',
      });
    }
    if (clip.transitionAfter.type === 'none' && clip.transitionAfter.durationSeconds !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['transitionAfter', 'durationSeconds'],
        message: 'A none transition must have zero duration',
      });
    }
    const normalizers = Number(Boolean(clip.grade.technicalLutId)) + Number(Boolean(clip.grade.combinedLutId));
    if (normalizers > 1) {
      context.addIssue({
        code: 'custom',
        path: ['grade'],
        message: 'A combined LUT replaces a technical LUT and must not be stacked',
      });
    }
    if (!clip.grade.creativeLutId && clip.grade.creativeMix !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['grade', 'creativeMix'],
        message: 'creativeMix must be zero when no creative LUT is selected',
      });
    }
  });

const TitleSchema = z.object({
  text: z.string().min(1).max(300),
  startSeconds: z.number().nonnegative(),
  durationSeconds: z.number().positive(),
  position: z.enum(['top', 'center', 'bottom']).default('center'),
});

export const EditManifestSchema = z
  .object({
    schemaVersion: SchemaVersion,
    reelName: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    output: z.object({
      width: z.literal(1080),
      height: z.literal(1920),
      fps: z.literal(30),
    }),
    clips: z.array(EditClipSchema).min(1),
    titles: z.array(TitleSchema).default([]),
    music: z
      .object({
        sourceId: z.string().min(1),
        startSeconds: z.number().nonnegative().default(0),
        gainDb: z.number().min(-60).max(12).default(-8),
      })
      .nullable(),
    captions: z
      .object({
        relativePath: RelativePath,
        format: z.enum(['srt', 'remotion-json']),
      })
      .nullable(),
  })
  .strict()
  .superRefine((edit, context) => {
    const seen = new Set<string>();
    for (const [index, clip] of edit.clips.entries()) {
      if (seen.has(clip.id)) {
        context.addIssue({
          code: 'custom',
          path: ['clips', index, 'id'],
          message: `Clip ID must be unique: ${clip.id}`,
        });
      }
      seen.add(clip.id);
    }
  });

const ApprovalRecordSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  approvedAt: IsoDateTime,
  approvedBy: z.string().min(1).optional().default('user'),
});

export const ApprovalStateSchema = z
  .object({
    schemaVersion: SchemaVersion,
    edit: ApprovalRecordSchema.nullable(),
    color: ApprovalRecordSchema.extend({
      editHash: z.string().regex(/^[a-f0-9]{64}$/),
    }).nullable(),
  })
  .strict();

export const QcCheckSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['pass', 'warn', 'fail']),
  expected: z.unknown().optional(),
  observed: z.unknown().optional(),
  message: z.string().min(1),
});

export const QcReportSchema = z
  .object({
    schemaVersion: SchemaVersion,
    generatedAt: IsoDateTime,
    target: z.enum(['preview', 'master', 'delivery']),
    readable: z.boolean(),
    approvals: z.object({edit: z.boolean(), color: z.boolean()}),
    expected: z.record(z.string(), z.unknown()),
    observed: z.record(z.string(), z.unknown()),
    checks: z.array(QcCheckSchema),
    warnings: z.array(z.string()),
    failures: z.array(z.string()),
  })
  .strict();

export type ReelBrief = z.infer<typeof ReelBriefSchema>;
export type SourceEntry = z.infer<typeof SourceEntrySchema>;
export type SourceManifest = z.infer<typeof SourceManifestSchema>;
export type LutDefinition = z.infer<typeof LutDefinitionSchema>;
export type AnimatedCrop = z.infer<typeof AnimatedCropSchema>;
export type EditClip = z.infer<typeof EditClipSchema>;
export type EditManifest = z.infer<typeof EditManifestSchema>;
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;
export type QcReport = z.infer<typeof QcReportSchema>;
