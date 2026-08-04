import { z } from 'zod'

export const ErrorCodeSchema = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'unavailable',
  'internal_error',
])

export const ErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
})

export function successEnvelope<T extends z.ZodTypeAny>(schema: T) {
  return z.object({
    ok: z.literal(true),
    data: schema,
  })
}

export const ErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: ErrorBodySchema,
})

export function responseEnvelope<T extends z.ZodTypeAny>(schema: T) {
  return z.union([successEnvelope(schema), ErrorEnvelopeSchema])
}

export const DirectoryProbeStatusSchema = z.enum([
  'neutral',
  'info',
  'success',
  'warning',
  'error',
])

export const GitProbeSchema = z.object({
  branch: z.string(),
  dirty_count: z.number().int().nonnegative(),
})

export const PullRequestProbeSchema = z.object({
  number: z.number().int().nonnegative(),
  status: z.string(),
  url: z.string(),
})

export const ScriptProbeSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
  status: DirectoryProbeStatusSchema,
  url: z.string().optional(),
})

export const DirectoryProbeSchema = z.object({
  git: GitProbeSchema.optional(),
  pr: PullRequestProbeSchema.optional(),
  scripts: z.array(ScriptProbeSchema).optional(),
})

export const DirectoryProbesSchema = z.record(DirectoryProbeSchema)
export const PeerDirectoryProbesSchema = z.record(DirectoryProbesSchema)

/**
 * The directory-probe extensions shared by GET /v1/projects `data` and
 * `snapshot.world`. The local map is present in either payload; the peer-keyed
 * map is composed only by a hub snapshot. Passthrough and optional fields keep
 * older servers and peers fully compatible.
 */
export const DirectoryProbePayloadSchema = z.object({
  directory_probes: DirectoryProbesSchema.optional(),
  peer_directory_probes: PeerDirectoryProbesSchema.optional(),
}).passthrough()

export type ErrorCode = z.infer<typeof ErrorCodeSchema>
export type ErrorBody = z.infer<typeof ErrorBodySchema>
export type DirectoryProbeStatus = z.infer<typeof DirectoryProbeStatusSchema>
export type GitProbe = z.infer<typeof GitProbeSchema>
export type PullRequestProbe = z.infer<typeof PullRequestProbeSchema>
export type ScriptProbe = z.infer<typeof ScriptProbeSchema>
export type DirectoryProbe = z.infer<typeof DirectoryProbeSchema>
export type DirectoryProbes = z.infer<typeof DirectoryProbesSchema>
export type PeerDirectoryProbes = z.infer<typeof PeerDirectoryProbesSchema>
