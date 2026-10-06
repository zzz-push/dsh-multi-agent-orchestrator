import { z } from 'zod'

/** Configuration schema for the EventBus Harness plugin. */
export const CommEventBusConfigSchema = z.object({
  maxListeners: z.number().int().positive().max(10_000).default(64),
}).strict()

export type CommEventBusConfig = z.infer<typeof CommEventBusConfigSchema>
