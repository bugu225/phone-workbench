import { z } from 'zod';

export const workspaceSnapshotSchema = z
  .object({
    schemaVersion: z.literal('phone-workbench/0.1-r1a'),
    runtimeId: z.string(),
    revision: z.number().int().nonnegative(),
    sourceKind: z.enum(['NONE', 'REAL_DEVICE', 'SIMULATED', 'FIXTURE']),
    discoveryStatus: z.enum(['ready', 'not_configured', 'unavailable', 'error']),
    observedAt: z.string(),
    lastSuccessfulDiscoveryAt: z.string().nullable(),
    devices: z.array(
      z
        .object({
          deviceId: z.string(),
          label: z.string(),
          connectionState: z.enum([
            'connected',
            'unauthorized',
            'offline',
            'disconnected',
            'unknown',
          ]),
          connectionGeneration: z.number().int().positive(),
          stale: z.boolean(),
          lastSeenAt: z.string(),
          capabilities: z.array(
            z
              .object({
                operation: z.string(),
                state: z.enum([
                  'supported',
                  'unsupported',
                  'unknown',
                  'permission_required',
                ]),
                reasonCode: z.string(),
                scope: z.enum(['device', 'display', 'application']),
                evidence: z.enum([
                  'NOT_RUN',
                  'STATIC_REVIEW',
                  'SIMULATED_PASS',
                  'DEVICE_PASS',
                ]),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    controlOwner: z.enum(['none', 'human', 'agent', 'transitioning']),
    activeSession: z.null(),
    error: z
      .object({
        code: z.enum([
          'INVALID_ARGUMENT',
          'ADAPTER_NOT_CONFIGURED',
          'ADAPTER_UNAVAILABLE',
          'DISCOVERY_FAILED',
          'TIMEOUT',
          'CANCELLED',
          'CAPABILITY_UNSUPPORTED',
          'STALE_OBSERVATION',
          'TARGET_MISMATCH',
          'EFFECT_UNKNOWN',
          'INTERNAL_ERROR',
          'CORE_CLOSED',
        ]),
        reasonCode: z.string(),
        message: z.string(),
        retryPolicy: z.enum(['never', 'after_refresh', 'reconcile_first']),
      })
      .strict()
      .nullable(),
  })
  .strict();
