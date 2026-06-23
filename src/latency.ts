import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type Turn = { eou?: number; trans?: number | null; ttft?: number; ttfb?: number; done?: boolean };

export class LatencyLogger {
  private turns = new Map<string, Turn>();

  constructor(
    private lang: string, 
    private callId: string,
    private path = 'metrics/runs.jsonl'
  ) {
    mkdirSync(dirname(path), { recursive: true });
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
