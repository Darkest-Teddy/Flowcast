import { useEffect, useRef, useState } from 'react';
import { askAgentWithRetry, type AgentAnswer, type AgentMessage, type AskCampus } from './askClient';
import { appendExchange } from './askConversation';
import { VoiceSession, type VoiceCaption, type VoicePhase } from './voiceSession';
import { auth } from '../../web/src/auth/client';
import { loadVoiceSchedule } from './voiceSchedule';
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

export function LiveVoice({ context, onAnswer, compact = false }: { context?: VoiceContext; onAnswer?: (answer: AgentAnswer) => void; compact?: boolean }) {
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
    if (!active) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let account: string | null | undefined;
    void auth.getClient().then(client => {
      if (disposed) return;
      const { data } = client.auth.onAuthStateChange((_event, identity) => {
        const next = identity?.user.id ?? null;
        if (account !== undefined && account !== next) call.current?.stop();
        account = next;
      });
      unsubscribe = () => data.subscription.unsubscribe();
    }).catch(() => { /* Campus voice remains available when sign-in is not configured. */ });
    return () => { disposed = true; unsubscribe?.(); };
  }, [active]);

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
    let historyAccount: string | null | undefined;
    const session = new VoiceSession({
      audio: audio.current,
      onState: (next, text) => { setPhase(next); setMessage(text); },
      onCaptions: setCaptions,
      onPlaybackBlocked: () => setPlaybackBlocked(true),
      context: () => {
        const ctx = latest.current.context ?? currentContext();
        const clock = `${Math.floor(ctx.time / 3600)}:${String(Math.floor(ctx.time / 60) % 60).padStart(2, '0')}`;
        return `Viewing ${latest.current.context ? 'the simulation map' : 'the dashboard'}: ${ctx.campus}, ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][ctx.weekday]} ${clock} Boston time. Crowds are modeled. Delegate personal schedule questions to the backend; it checks the signed-in user's saved calendar using actual Boston dates.`;
      },
      lookup: async (question, signal) => {
        const ctx = latest.current.context ?? currentContext();
        let schedule;
        try {
          schedule = await loadVoiceSchedule(async () => {
            let client;
            try { client = await auth.getClient(); } catch { return null; }
            const { data, error } = await client.auth.getSession();
            if (error) throw error;
            return data.session ? { userId: data.session.user.id, accessToken: data.session.access_token } : null;
          }, signal);
        } catch (error) {
          return error instanceof Error ? error.message : 'Your schedule could not be loaded. Please try again.';
        }
        if (historyAccount !== undefined && historyAccount !== schedule.userId) {
          call.current?.stop();
          return '';
        }
        historyAccount = schedule.userId;
        const result = await askAgentWithRetry({ ...ctx, question, history, personalSchedule: schedule.personalSchedule }, signal);
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

  const toggleLabel = phase === 'connecting' ? 'Cancel voice' : active ? 'End voice' : 'Start voice';
  const toggle = () => active ? call.current?.stop() : start();

  if (compact) return (
    <div className={styles.compact} role="group" aria-label="Live voice">
      <button type="button" className={`${styles.mic} ${active ? styles.active : ''}`}
        aria-label={toggleLabel} title={active ? toggleLabel : 'Talk to Flowcast (AI voice)'}
        aria-pressed={active} aria-busy={phase === 'connecting'} disabled={phase === 'ending'} onClick={toggle}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          {active ? <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
            : <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></>}
        </svg>
      </button>
      <span className="visually-hidden" role="status">{message}</span>
      <audio ref={audio} autoPlay controls={playbackBlocked} className={styles.audio} aria-label="Voice playback" />
      {(phase === 'error' || playbackBlocked) && <div className={styles.feedback} onKeyDown={event => {
        if (event.key === 'Escape' && phase === 'error') setPhase('ended');
      }}>
        {phase === 'error' && <p role="alert">{message}</p>}
        {playbackBlocked && <button type="button" onClick={() => {
          void audio.current?.play().then(() => setPlaybackBlocked(false)).catch(() => setPlaybackBlocked(true));
        }}>Play voice</button>}
        {phase === 'error' && <button type="button" onClick={() => setPhase('ended')}>Dismiss</button>}
      </div>}
    </div>
  );

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
      <p className={styles.note}>AI voice · Uses your saved schedule when signed in.</p>
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
