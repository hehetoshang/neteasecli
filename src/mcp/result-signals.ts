import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const BRIDGE_CONTROL_KEY = 'x-open-xiaoai-bridge';

export const PLAYBACK_STARTED_SIGNAL = {
  version: 1,
  action: 'end_turn_silently',
  reason: 'playback_started',
} as const;

export const PLAYBACK_STARTED_OUTPUT_SCHEMA = {
  [BRIDGE_CONTROL_KEY]: z.object({
    version: z.literal(1),
    action: z.literal('end_turn_silently'),
    reason: z.literal('playback_started'),
  }),
};

export function playbackStartedResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: {
      [BRIDGE_CONTROL_KEY]: PLAYBACK_STARTED_SIGNAL,
    },
  };
}
