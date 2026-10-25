import { z } from 'zod';

export const VoiceRequest = z.object({
  sdp: z.string().min(1).max(65_536).refine((sdp) => sdp.trim().length > 0),
}).strict();

export interface VoiceSession { id: string; sdp: string }
export type Voice = (sdp: string, signal: AbortSignal) => Promise<VoiceSession>;

const liveResponse = z.object({
  session: z.object({ id: z.string().min(1).refine((id) => id.trim().length > 0) }),
  transport: z.object({ type: z.literal('webrtc'), sdp: z.string().min(1).refine((sdp) => sdp.trim().length > 0) }),
});

export const VOICE_INSTRUCTIONS = `You are Flowcast's concise campus voice assistant. Speak naturally and briefly.
Delegate every campus question to the backend, including buildings, walking routes, distances, times, hours and crowds.
WAIT for the backend result before giving any campus fact or numerical estimate. While waiting, say only that you are checking; never guess an answer from your own knowledge or fill the pause with an estimate.
Use only the backend's result for the answer. If lookup fails, say you could not check. Flowcast crowds are modeled, not real sensor data.
You receive text context about the user's page, not a screenshot. Do not claim to see the map or screen. No personal schedule is available.`;

export function createVoice(key: string, model = 'gpt-live-1', request: typeof fetch = fetch): Voice {
  return async (sdp, signal) => {
    if (!key) throw new Error('Voice is not configured');
    try {
      const response = await request('https://api.openai.com/v1/live/sessions', {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: { model, instructions: VOICE_INSTRUCTIONS, delegation: { type: 'client' }, store: false },
          transport: { type: 'webrtc', sdp },
        }),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Voice upstream failed');
      }
      const result = liveResponse.parse(await response.json());
      return { id: result.session.id, sdp: result.transport.sdp };
    } catch {
      // Upstream bodies and transport errors can contain credentials or SDP.
      throw new Error('Voice session creation failed');
    }
  };
}
