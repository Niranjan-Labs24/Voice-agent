import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type Turn = { eou?: number; trans?: number | null; ttft?: number; ttfb?: number; done?: boolean };

// SIP / Twilio timing checkpoints (all in ms since epoch)
interface SipTimings {
  // Set the moment we dispatch the outbound SIP INVITE (or inbound call arrives at agent)
  call_initiated_ts: number;
  // Set when the LiveKit room gets the caller-1 participant (Twilio SIP leg connected)
  sip_connected_ts?: number;
  // Set when the first audio track from caller-1 is subscribed (media flowing)
  first_audio_ts?: number;
  // Set when our greeting TTS actually starts playing
  greeting_start_ts?: number;
}

export class LatencyLogger {
  private turns = new Map<string, Turn>();
  private sip: SipTimings;

  constructor(
    private lang: string,
    private callId: string,
    private path = 'metrics/runs.jsonl'
  ) {
    mkdirSync(dirname(path), { recursive: true });
    // Record the moment the agent job starts as call_initiated
    this.sip = { call_initiated_ts: Date.now() };
  }

  /** Call this when caller-1 participant joins the LiveKit room (SIP leg up) */
  setSipConnected(): void {
    this.sip.sip_connected_ts = Date.now();
    const setup_ms = this.sip.sip_connected_ts - this.sip.call_initiated_ts;
    console.log(`[SIP_TIMING] SIP connected. Setup time: ${setup_ms}ms`);
  }

  /** Call this when the first audio track from caller is subscribed (media flowing) */
  setFirstAudio(): void {
    if (this.sip.first_audio_ts) return; // only first time
    this.sip.first_audio_ts = Date.now();
    const media_setup_ms = this.sip.first_audio_ts - this.sip.call_initiated_ts;
    console.log(`[SIP_TIMING] First audio received. Media setup time: ${media_setup_ms}ms`);
  }

  /** Call this just before session.say(greeting) fires */
  setGreetingStart(): void {
    this.sip.greeting_start_ts = Date.now();
    this.flushSipRow();
  }

  /** Writes one SIP timing row to the metrics file */
  private flushSipRow(): void {
    const { call_initiated_ts, sip_connected_ts, first_audio_ts, greeting_start_ts } = this.sip;

    const sip_setup_ms   = sip_connected_ts  ? sip_connected_ts  - call_initiated_ts : null;
    const first_audio_ms = first_audio_ts     ? first_audio_ts    - call_initiated_ts : null;
    const greeting_ms    = greeting_start_ts  ? greeting_start_ts - call_initiated_ts : null;
    // Time from media flowing → agent starts speaking (pure routing + LiveKit overhead)
    const media_to_speak_ms =
      first_audio_ts && greeting_start_ts ? greeting_start_ts - first_audio_ts : null;

    appendFileSync(this.path, JSON.stringify({
      type: 'sip_timing',
      ts: Date.now() / 1000,
      call_id: this.callId,
      lang: this.lang,
      // Absolute timestamps (ms)
      call_initiated_ts,
      sip_connected_ts:  sip_connected_ts  ?? null,
      first_audio_ts:    first_audio_ts    ?? null,
      greeting_start_ts: greeting_start_ts ?? null,
      // Derived durations (ms) — this is what you care about
      sip_setup_ms,       // job_start → Twilio SIP leg connected
      first_audio_ms,     // job_start → first RTP packet received
      greeting_ms,        // job_start → agent starts speaking
      media_to_speak_ms,  // first_audio → agent starts speaking (pure internal delay)
    }) + '\n');

    console.log(`[SIP_TIMING] Row flushed →`, {
      sip_setup_ms,
      first_audio_ms,
      greeting_ms,
      media_to_speak_ms,
    });
  }

  collect(m: any): void {
    const sid: string | undefined = m?.speechId ?? m?.speech_id;
    if (!sid) return;

    const t = this.turns.get(sid) ?? {};
    const eou = m.endOfUtteranceDelay ?? m.end_of_utterance_delay;

    if (eou !== undefined) {
      t.eou = eou;
      t.trans = m.transcriptionDelay ?? m.transcription_delay ?? null;
    }

    if (m.ttft !== undefined) t.ttft = m.ttft;
    if (m.ttfb !== undefined) t.ttfb = m.ttfb;

    this.turns.set(sid, t);

    if (t.eou !== undefined && t.ttft !== undefined && t.ttfb !== undefined && !t.done) {
      t.done = true;
      appendFileSync(this.path, JSON.stringify({
        type: 'turn',
        ts: Date.now() / 1000,
        call_id: this.callId,
        lang: this.lang,
        speech_id: sid,
        eou_delay: t.eou,
        transcription_delay: t.trans,
        llm_ttft: t.ttft,
        tts_ttfb: t.ttfb,
        total_ms: Math.round((t.eou + t.ttft + t.ttfb) * 1000),
      }) + '\n');
    }
  }
}
