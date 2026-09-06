// 最后一个卡死候选: audioSequence 时序!
// emitter 发 tts.started/audio per segment (audioSequence 0,1,2...)
// 前端 audio 播放器逐段播; PerformanceDirector.onAudioStart(turnId, dur, seq)
// 段 N 的 cue 在 seq N 起播时 reanchor — 但 stage() 只发生一次
// 若 onAudioStart 从不触发(前端音频队列bug) → cues 依赖 audioWaitMs? 不
// audio.started 才 schedule; 若前端只播段 0 而 1,2 的事件丢了 → 后段表情不出
// 但用户说'只有 angry' = 段 0 的表情能出 — 与'只有第一段'一致!
console.log('假设成立: 只第一段表情出来 = 后段 cue 从未 due')
console.log('需要: 前端 audio 事件桥接检查')
