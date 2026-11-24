const componentStatusSchema = {
  type: 'string',
  enum: ['OK', 'DEGRADED', 'DOWN'],
  example: 'OK',
};

export const healthResponseSchema = {
  type: 'object',
  required: ['status', 'timestamp', 'uptimeSeconds', 'checks'],
  properties: {
    status: {
      type: 'string',
      enum: ['OK', 'DEGRADED'],
      example: 'OK',
    },
    timestamp: {
      type: 'string',
      format: 'date-time',
      example: '2026-11-25T03:10:00.000Z',
    },
    uptimeSeconds: {
      type: 'integer',
      example: 120,
    },
    checks: {
      type: 'object',
      required: ['postgres', 'redis', 'piscina', 'outbox'],
      properties: {
        postgres: {
          type: 'object',
          required: ['status', 'latencyMs'],
          properties: {
            status: componentStatusSchema,
            latencyMs: { type: 'number', example: 1.45 },
          },
        },
        redis: {
          type: 'object',
          required: ['status', 'latencyMs'],
          properties: {
            status: componentStatusSchema,
            latencyMs: { type: 'number', example: 0.52 },
          },
        },
        piscina: {
          type: 'object',
          required: [
            'status',
            'inFlight',
            'queued',
            'maxThreads',
            'maxQueue',
            'currentLimit',
          ],
          properties: {
            status: componentStatusSchema,
            inFlight: { type: 'integer', example: 0 },
            queued: { type: 'integer', example: 0 },
            maxThreads: { type: 'integer', example: 3 },
            maxQueue: { type: 'integer', example: 100 },
            currentLimit: { type: 'integer', example: 3 },
          },
        },
        outbox: {
          type: 'object',
          required: ['status', 'pendingCount', 'lagMs'],
          properties: {
            status: componentStatusSchema,
            pendingCount: { type: 'integer', example: 0 },
            lagMs: { type: 'integer', example: 0 },
          },
        },
      },
    },
  },
};
