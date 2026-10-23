import { z } from 'zod';

export const LockfileHeaderSchema = z.object({
  lockfileVersion: z.number().int(),
  packages: z.unknown(),
});

export const LockfilePackageEntrySchema = z.object({
  name: z.string().nullish(),
  version: z.string().nullish(),
  resolved: z.string().nullish(),
  link: z.boolean().optional(),
  dev: z.boolean().optional(),
  optional: z.boolean().optional(),
  peer: z.boolean().optional(),
  dependencies: z.unknown().optional(),
  devDependencies: z.unknown().optional(),
  optionalDependencies: z.unknown().optional(),
  peerDependencies: z.unknown().optional(),
  peerDependenciesMeta: z.unknown().optional(),
});

export type LockfilePackageEntry = z.infer<typeof LockfilePackageEntrySchema>;
