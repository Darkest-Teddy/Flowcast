import { useEffect, useRef, useState } from 'react';
import { askAgentWithRetry, type AgentAnswer, type AgentMessage, type AskCampus } from './askClient';
import { appendExchange } from './askConversation';
import { VoiceSession, type VoiceCaption, type VoicePhase } from './voiceSession';
import styles from './LiveVoice.module.css';

export interface VoiceContext { weekday: number; time: number; campus: AskCampus }

function currentContext(): VoiceContext {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const part = (name: string) => parts.find(p => p.type === name)?.value ?? '';
  return { weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(part('weekday')),
    time: Number(part('hour')) * 3600 + Number(part('minute')) * 60 + Number(part('second')), campus: 'charles-river' };
}

export function LiveVoice({ context, onAnswer }: { context?: VoiceContext; onAnswer?: (answer: AgentAnswer) => void }) {
  const [phase, setPhase] = useState<VoicePhase>('ended');
  const [message, setMessage] = useState('Ask about campus, crowds or walking routes.');
  const [captions, setCaptions] = useState<VoiceCaption[]>([]);
  const [muted, setMuted] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const call = useRef<VoiceSession | null>(null);
  const latest = useRef({ context, onAnswer });
  latest.current = { context, onAnswer };
  const active = phase === 'connecting' || phase === 'connected' || phase === 'ending';

  useEffect(() => {
    const leave = () => { call.current?.dispose(); call.current = null; setPhase('ended'); setMessage('Voice ended.'); };
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); call.current?.dispose(); call.current = null; };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => call.current?.updateContext(), 2_000);
    return () => window.clearInterval(timer);
  }, []);

  const start = () => {
    if (active || !audio.current) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      setPhase('error');
      setMessage('Voice needs a browser with microphone support on HTTPS or localhost.');
      return;
    }
    call.current?.dispose();
    setCaptions([]); setMuted(false); setPlaybackBlocked(false);
    let history: AgentMessage[] = [];
    const session = new VoiceSession({
      audio: audio.current,
      onState: (next, text) => { setPhase(next); setMessage(text); },
      onCaptions: setCaptions,
      onPlaybackBlocked: () => setPlaybackBlocked(true),
      context: () => {
        const ctx = latest.current.context ?? currentContext();
        const clock = `${Math.floor(ctx.time / 3600)}:${String(Math.floor(ctx.time / 60) % 60).padStart(2, '0')}`;
        return `Viewing ${latest.current.context ? 'the simulation map' : 'the dashboard'}: ${ctx.campus}, ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][ctx.weekday]} ${clock} Boston time. Campus crowds are modeled, not live measurements. Personal schedules are not shared in voice.`;
      },
      lookup: async (question, signal) => {
        const ctx = latest.current.context ?? currentContext();
        const result = await askAgentWithRetry({ ...ctx, question, history }, signal);
        if (signal.aborted) return '';
        if (!result.ok) return `Campus lookup could not answer: ${result.error.message}. Do not invent a result.`;
        history = appendExchange(history, question, result.value.answer);
        latest.current.onAnswer?.(result.value);
        return result.value.answer;
      },
    });
    call.current = session;
    void session.start();
  };

  return (
    <section className={styles.voice} aria-label="Live voice">
      <div className={styles.row}>
        <div className={styles.heading}>
          <strong>Talk to Flowcast</strong>
          <p role={phase === 'error' ? 'alert' : 'status'}>{message}{phase === 'connected' && (muted ? ' · Mic muted' : ' · Mic on')}</p>
        </div>
        <div className={styles.controls}>
          {phase === 'connected' && <button type="button" aria-pressed={muted} onClick={() => {
            call.current?.mute(!muted); setMuted(!muted);
          }}>{muted ? 'Unmute mic' : 'Mute mic'}</button>}
          {active ? <button type="button" disabled={phase === 'ending'} onClick={() => call.current?.stop()}>
            {phase === 'connecting' ? 'Cancel voice' : 'End voice'}
          </button> : <button type="button" className={styles.start} onClick={start}>Start voice</button>}
        </div>
      </div>
      <p className={styles.note}>GPT-Live uses an AI voice. Starting shares microphone audio with OpenAI. Campus data only; your imported schedule stays out of voice. Calls end after 10 minutes.</p>
      <audio ref={audio} autoPlay controls={playbackBlocked} className={styles.audio} aria-label="Voice playback" />
      {playbackBlocked && <p className={styles.note}>Press play above to hear Flowcast.</p>}
      {captions.length > 0 && <details className={styles.captions} open>
        <summary>Voice captions</summary>
        <div role="log" aria-label="Voice captions" aria-live="off" tabIndex={0}>
          {captions.map((caption, index) => <p key={index}><strong>{caption.role === 'user' ? 'You' : 'Flowcast'}: </strong>{caption.text}</p>)}
        </div>
      </details>}
    </section>
  );
}
